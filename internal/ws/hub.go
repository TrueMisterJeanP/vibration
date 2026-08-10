package ws

import (
	"encoding/json"
	"sync"
	"sync/atomic"
)

const (
	// clientQueueSize is the per-connection outbound buffer. It absorbs the
	// bursts produced by a busy group without allocating much: 256 pointers is
	// ~2 KiB per connection, so 1000 connections cost about 2 MiB of queues.
	clientQueueSize = 256
	// ephemeralQueueLimit reserves the upper half of the queue for events that
	// must not be lost. Typing indicators and presence updates are dropped past
	// this watermark so a chatty client cannot crowd out a new message.
	ephemeralQueueLimit = clientQueueSize / 2
	// callSignalQueueSize is independent from the reloadable event queue. WebRTC
	// offers, answers and ICE candidates do not exist in the database, so closing
	// and resynchronizing cannot recover one that was crowded out.
	callSignalQueueSize = 64
)

type Client struct {
	UserID int64
	Send   chan []byte
	Call   chan []byte
	Kick   chan []byte
	Done   chan struct{}
	once   sync.Once
	// policyClose distinguishes an authorization close (ban, revocation) from
	// an ordinary or backpressure-driven close.
	policyClose atomic.Bool
	// resync records that a durable event could not be queued, so the close is
	// followed by a client reconnect that re-reads the persisted state.
	resync atomic.Bool
}

// NewClient builds a connection with the standard queue sizes.
func NewClient(userID int64) *Client {
	return &Client{
		UserID: userID,
		Send:   make(chan []byte, clientQueueSize),
		Call:   make(chan []byte, callSignalQueueSize),
		Kick:   make(chan []byte, 1),
		Done:   make(chan struct{}),
	}
}

func (c *Client) deliverCall(data []byte) bool {
	select {
	case c.Call <- data:
		return true
	default:
		return false
	}
}

// Close asks the write loop to terminate the connection normally.
func (c *Client) Close() { c.closeWith(false) }

// ClosePolicy terminates the connection with a policy-violation close, used
// when the account is banned or the session revoked.
func (c *Client) ClosePolicy() { c.closeWith(true) }

func (c *Client) closeWith(policy bool) {
	if policy {
		c.policyClose.Store(true)
	}
	c.once.Do(func() { close(c.Done) })
}

// deliver queues an event for this connection.
//
// Ephemeral events (typing, presence) are best effort: they are dropped once
// the queue passes its watermark, because a stale typing indicator is worthless
// and re-sending it would only deepen the backlog.
//
// Durable events (new message, membership and role changes, revocations) are
// never dropped silently. When the queue is full the connection is closed
// instead: the client reconnects, refetches its conversations and the current
// message page, and therefore observes the event it would otherwise have
// missed. Losing the socket is recoverable; losing the event is not.
// It returns whether the event was queued, and whether this delivery is the one
// that tipped the connection over. Only the first overflow closes the socket and
// counts: until the reader notices and unregisters, later events would otherwise
// re-close an already-closed client and inflate the metric.
func (c *Client) deliver(data []byte, ephemeral bool) (queued, firstOverflow bool) {
	if ephemeral && len(c.Send) >= ephemeralQueueLimit {
		return false, false
	}
	select {
	case c.Send <- data:
		return true, false
	default:
	}
	if ephemeral {
		return false, false
	}
	if c.resync.CompareAndSwap(false, true) {
		c.Close()
		return false, true
	}
	return false, false
}

type Hub struct {
	mu      sync.RWMutex
	clients map[int64]map[*Client]struct{}
	// stats are process-wide counters, exported for load tests and operational
	// dashboards.
	connections    atomic.Int64
	forcedResyncs  atomic.Int64
	droppedTyping  atomic.Int64
	deliveredCount atomic.Int64
	failedCalls    atomic.Int64
}

// Stats is a point-in-time view of the hub, used by the metrics endpoint.
type Stats struct {
	Connections       int64 `json:"connections"`
	Users             int   `json:"users"`
	ForcedResyncs     int64 `json:"forced_resyncs"`
	DroppedEvents     int64 `json:"dropped_ephemeral_events"`
	Delivered         int64 `json:"delivered_events"`
	MaxQueueDepth     int   `json:"max_queue_depth"`
	MaxCallQueueDepth int   `json:"max_call_queue_depth"`
	FailedCallSignals int64 `json:"failed_call_signals"`
}

func NewHub() *Hub {
	return &Hub{clients: make(map[int64]map[*Client]struct{})}
}

func (h *Hub) Register(client *Client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	first := len(h.clients[client.UserID]) == 0
	if h.clients[client.UserID] == nil {
		h.clients[client.UserID] = make(map[*Client]struct{})
	}
	h.clients[client.UserID][client] = struct{}{}
	h.connections.Add(1)
	return first
}

func (h *Hub) Unregister(client *Client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, known := h.clients[client.UserID][client]; known {
		h.connections.Add(-1)
	}
	delete(h.clients[client.UserID], client)
	last := len(h.clients[client.UserID]) == 0
	if last {
		delete(h.clients, client.UserID)
	}
	return last
}

func (h *Hub) IsOnline(userID int64) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients[userID]) > 0
}

func (h *Hub) Stats() Stats {
	h.mu.RLock()
	users := len(h.clients)
	depth := 0
	callDepth := 0
	for _, clients := range h.clients {
		for client := range clients {
			if queued := len(client.Send); queued > depth {
				depth = queued
			}
			if queued := len(client.Call); queued > callDepth {
				callDepth = queued
			}
		}
	}
	h.mu.RUnlock()
	return Stats{
		Connections:       h.connections.Load(),
		Users:             users,
		ForcedResyncs:     h.forcedResyncs.Load(),
		DroppedEvents:     h.droppedTyping.Load(),
		Delivered:         h.deliveredCount.Load(),
		MaxQueueDepth:     depth,
		MaxCallQueueDepth: callDepth,
		FailedCallSignals: h.failedCalls.Load(),
	}
}

// SendToUser delivers a durable event. It returns true when at least one
// connection accepted it.
func (h *Hub) SendToUser(userID int64, event any) bool {
	return h.send(userID, event, false)
}

// SendEphemeralToUser delivers a best-effort event such as a typing indicator
// or a presence update. It may be dropped when the connection is saturated.
func (h *Hub) SendEphemeralToUser(userID int64, event any) bool {
	return h.send(userID, event, true)
}

// SendCallToUser uses a dedicated queue for non-persisted WebRTC signalling.
// A full queue is reported to the caller instead of closing the recipient and
// pretending that a database resync could restore the missing signal.
func (h *Hub) SendCallToUser(userID int64, event any) bool {
	data, ok := encodeEvent(event)
	if !ok {
		h.failedCalls.Add(1)
		return false
	}
	h.mu.RLock()
	sent := false
	for client := range h.clients[userID] {
		if client.deliverCall(data) {
			sent = true
			h.deliveredCount.Add(1)
		}
	}
	h.mu.RUnlock()
	if !sent {
		h.failedCalls.Add(1)
	}
	return sent
}

func (h *Hub) send(userID int64, event any, ephemeral bool) bool {
	data, ok := encodeEvent(event)
	if !ok {
		return false
	}
	// Deliveries are non-blocking, so holding the read lock cannot stall the
	// hub, and it guarantees a connection cannot be unregistered (and its queue
	// closed) while an event is being queued for it.
	h.mu.RLock()
	defer h.mu.RUnlock()
	sent := false
	for client := range h.clients[userID] {
		queued, firstOverflow := client.deliver(data, ephemeral)
		switch {
		case queued:
			sent = true
			h.deliveredCount.Add(1)
		case ephemeral:
			h.droppedTyping.Add(1)
		case firstOverflow:
			h.forcedResyncs.Add(1)
		}
	}
	return sent
}

func encodeEvent(event any) ([]byte, bool) {
	switch value := event.(type) {
	case []byte:
		return value, true
	case json.RawMessage:
		return value, true
	default:
		data, err := json.Marshal(event)
		if err != nil {
			return nil, false
		}
		return data, true
	}
}

func (h *Hub) KickUser(userID int64, event any) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	h.mu.RLock()
	clients := make([]*Client, 0, len(h.clients[userID]))
	for client := range h.clients[userID] {
		clients = append(clients, client)
	}
	h.mu.RUnlock()
	for _, client := range clients {
		select {
		case client.Kick <- data:
		default:
			// A kick is already queued for this connection; tearing it down is
			// still the correct outcome for a revoked or banned account.
			client.ClosePolicy()
		}
	}
}
