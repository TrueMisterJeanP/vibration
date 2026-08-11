package callsig

import (
	"sync"
	"time"
)

// Dispatcher limits, stated exactly.
//
// Two different things are bounded, and conflating them would overstate the
// guarantee: a job is either *waiting* in a stream's queue or *in flight* in
// that stream's goroutine, and only the waiting ones are counted by
// DispatchTotalDepth.
//
//	waiting jobs      ≤ DispatchTotalDepth                        (512)
//	waiting per stream ≤ DispatchStreamDepth                       (32)
//	active streams    ≤ DispatchMaxStreams                        (128)
//	goroutines        ≤ DispatchMaxStreams                        (128)
//	in-flight jobs    ≤ DispatchMaxStreams                        (128)
//	worst-case jobs held ≤ DispatchTotalDepth + DispatchMaxStreams (640)
const (
	// DispatchStreamDepth caps how many signals of one logical stream may wait
	// at once. A negotiation is a handful of events; a stream that has queued
	// this many is not going to catch up before they expire.
	DispatchStreamDepth = 32
	// DispatchTotalDepth caps the *waiting* jobs across every stream, so one
	// unreachable instance cannot make every call on the server allocate.
	DispatchTotalDepth = 512
	// DispatchMaxStreams caps concurrency. One goroutine runs per active
	// stream, so this bounds both the goroutine count and the number of jobs
	// that can be in flight at the same time.
	DispatchMaxStreams = 128
)

// StreamKey identifies a logical, order-sensitive flow of call signals.
//
// Ordering matters within one call, in one conversation, from one sender, to
// one instance — and only there. Two different calls, the same call id in two
// conversations, or the same call towards two different instances have no
// causal relationship and must stay parallel: serializing them would make one
// slow instance delay everybody.
type StreamKey struct {
	InstanceID int64
	// ConversationID keeps two conversations independent even when they carry
	// the same call id from the same sender to the same instance. Call ids are
	// chosen by clients, so that collision is ordinary rather than exotic, and
	// without this a slow conversation would serialize an unrelated one behind
	// it.
	ConversationID int64
	Sender         string
	CallID         string
}

// Job is one queued delivery.
type Job struct {
	Key       StreamKey
	Event     Event
	Recipient Recipient
	Report    func(Delivery)
}

type stream struct {
	jobs    []Job
	running bool
}

// Dispatcher delivers federated call signals in order within each stream.
//
// The problem it solves is specific and easy to miss: a browser sends
// call_accept and then, microseconds later, call_offer. With a shared queue and
// several workers, both requests leave at once and the network decides which
// arrives first. If the offer wins, the peer is still in "ringing", ignores it,
// and nothing re-sends it — the call rings forever. Serializing per stream
// makes that reordering impossible at the source.
type Dispatcher struct {
	mu      sync.Mutex
	streams map[StreamKey]*stream
	queued  int
	now     func() time.Time
	deliver func(Job) Delivery
	// idle is signalled whenever the dispatcher becomes completely empty. It
	// exists so tests can wait for quiescence without polling.
	idle chan struct{}
}

// NewDispatcher builds a dispatcher over a delivery function.
func NewDispatcher(deliver func(Job) Delivery) *Dispatcher {
	return NewDispatcherWithClock(deliver, time.Now)
}

// NewDispatcherWithClock builds a dispatcher with an injected clock.
func NewDispatcherWithClock(deliver func(Job) Delivery, now func() time.Time) *Dispatcher {
	return &Dispatcher{streams: map[StreamKey]*stream{}, now: now, deliver: deliver, idle: make(chan struct{}, 1)}
}

// Submit queues a job, preserving FIFO order within its stream.
//
// It never blocks: the caller is a WebSocket reader with other frames to read.
// A refused job is reported immediately as queue_full rather than silently
// dropped, so the calling browser learns that its signal went nowhere.
func (d *Dispatcher) Submit(job Job) {
	if job.Event.Expired(d.now()) {
		job.Report(Delivery{Recipient: job.Recipient, Reason: ReasonExpired})
		return
	}
	d.mu.Lock()
	existing, known := d.streams[job.Key]
	switch {
	case d.queued >= DispatchTotalDepth:
		d.mu.Unlock()
		job.Report(Delivery{Recipient: job.Recipient, Reason: ReasonQueueFull})
		return
	case known && len(existing.jobs) >= DispatchStreamDepth:
		d.mu.Unlock()
		job.Report(Delivery{Recipient: job.Recipient, Reason: ReasonQueueFull})
		return
	case !known && len(d.streams) >= DispatchMaxStreams:
		d.mu.Unlock()
		job.Report(Delivery{Recipient: job.Recipient, Reason: ReasonQueueFull})
		return
	}
	if !known {
		existing = &stream{}
		d.streams[job.Key] = existing
	}
	existing.jobs = append(existing.jobs, job)
	d.queued++
	start := !existing.running
	if start {
		existing.running = true
	}
	d.mu.Unlock()
	if start {
		go d.run(job.Key)
	}
}

// run drains one stream to completion, one job at a time. Exactly one goroutine
// exists per active stream, and it exits — releasing the map entry — as soon as
// the stream is empty, so an idle call leaves nothing behind.
func (d *Dispatcher) run(key StreamKey) {
	for {
		d.mu.Lock()
		item, known := d.streams[key]
		if !known || len(item.jobs) == 0 {
			if known {
				delete(d.streams, key)
			}
			empty := len(d.streams) == 0
			d.mu.Unlock()
			if empty {
				d.signalIdle()
			}
			return
		}
		job := item.jobs[0]
		item.jobs = item.jobs[1:]
		d.queued--
		d.mu.Unlock()

		// The event may have expired while it waited behind its predecessors.
		// Sending it anyway would put a stale offer on the wire.
		if job.Event.Expired(d.now()) {
			job.Report(Delivery{Recipient: job.Recipient, Reason: ReasonExpired})
			continue
		}
		job.Report(d.deliver(job))
	}
}

func (d *Dispatcher) signalIdle() {
	select {
	case d.idle <- struct{}{}:
	default:
	}
}

// Pending reports how many jobs are queued. It is used by tests and by the
// metrics endpoint to observe backpressure.
func (d *Dispatcher) Pending() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.queued
}

// Streams reports how many streams are active, which is also the number of
// dispatcher goroutines currently running.
func (d *Dispatcher) Streams() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.streams)
}

// WaitIdle blocks until every stream has drained or the timeout elapses. It
// reports whether the dispatcher reached quiescence.
func (d *Dispatcher) WaitIdle(timeout time.Duration) bool {
	deadline := time.After(timeout)
	for {
		if d.Streams() == 0 {
			return true
		}
		select {
		case <-d.idle:
		case <-deadline:
			return d.Streams() == 0
		case <-time.After(5 * time.Millisecond):
		}
	}
}
