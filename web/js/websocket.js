import { websocketProtocols, websocketURL } from "./api.js?v=community-1-0-24-v363";

export class ChatSocket extends EventTarget {
  constructor() {
    super();
    this.socket = null;
    this.retry = 1000;
    this.closed = false;
    this.reconnectTimer = 0;
  }

  connect() {
    if (this.closed || (this.socket && this.socket.readyState < WebSocket.CLOSING)) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    const protocols = websocketProtocols();
    const socket = protocols.length
      ? new WebSocket(websocketURL("/api/ws"), protocols)
      : new WebSocket(websocketURL("/api/ws"));
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.retry = 1000;
      this.dispatchEvent(new CustomEvent("status", { detail: true }));
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      try {
        this.dispatchEvent(new CustomEvent("event", { detail: JSON.parse(event.data) }));
      } catch (error) {
        console.error("WebSocket payload invalide", error);
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.dispatchEvent(new CustomEvent("status", { detail: false }));
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.retry;
    this.retry = Math.min(this.retry * 2, 15000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = 0;
      this.connect();
    }, delay);
  }

  reconnect() {
    if (this.closed) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    this.retry = 1000;
    const previous = this.socket;
    this.socket = null;
    if (previous && previous.readyState < WebSocket.CLOSING) previous.close();
    this.dispatchEvent(new CustomEvent("status", { detail: false }));
    this.connect();
  }

  send(event) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event));
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}
