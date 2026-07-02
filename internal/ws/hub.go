package ws

import (
	"encoding/json"
	"sync"
)

type Client struct {
	UserID int64
	Send   chan []byte
	Kick   chan []byte
	Done   chan struct{}
	once   sync.Once
}

func (c *Client) Close() {
	c.once.Do(func() { close(c.Done) })
}

type Hub struct {
	mu      sync.RWMutex
	clients map[int64]map[*Client]struct{}
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
	return first
}

func (h *Hub) Unregister(client *Client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
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

func (h *Hub) SendToUser(userID int64, event any) bool {
	var data []byte
	switch value := event.(type) {
	case []byte:
		data = value
	case json.RawMessage:
		data = value
	default:
		var err error
		data, err = json.Marshal(event)
		if err != nil {
			return false
		}
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	sent := false
	for client := range h.clients[userID] {
		select {
		case client.Send <- data:
			sent = true
		default:
		}
	}
	return sent
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
			client.Close()
		}
	}
}
