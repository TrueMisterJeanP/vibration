package callsig

// Recipient is a resolved destination for one call signal.
//
// UserID is the identifier the *routing* instance uses for that participant: it
// is the real account id for a local member, and the shadow account id for a
// remote one. It is never sent across the federation boundary — only Identity
// travels.
type Recipient struct {
	UserID     int64
	Identity   Identity
	InstanceID int64
}

// Remote reports whether this participant lives on another instance.
func (r Recipient) Remote() bool { return r.InstanceID != 0 }

// Delivery is the outcome for one recipient. An empty reason means the signal
// reached a live WebSocket connection; anything else is a failure the emitting
// browser is entitled to hear about.
type Delivery struct {
	Recipient Recipient
	Reason    string
}

// OK reports a successful delivery.
func (d Delivery) OK() bool { return d.Reason == ReasonDelivered }

// Receipt is the structured answer an instance returns for a federated call
// event. Recipients counts the local members the event was addressed to and
// Delivered counts those whose browser actually accepted it. A response with
// Delivered == 0 is a failure even though the HTTP status is 200: the request
// was understood, the signal simply reached nobody.
type Receipt struct {
	Recipients int    `json:"recipients"`
	Delivered  int    `json:"delivered"`
	Reason     string `json:"reason,omitempty"`
}
