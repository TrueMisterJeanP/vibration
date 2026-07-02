import { websocketURL } from "./api.js";

export class ChatSocket extends EventTarget {
  constructor() {
    super();
    this.socket = null;
    this.retry = 1000;
    this.closed = false;
  }

  connect() {
    this.socket = new WebSocket(websocketURL("/api/ws"));
    this.socket.addEventListener("open", () => {
      this.retry = 1000;
      this.dispatchEvent(new CustomEvent("status", { detail: true }));
    });
    this.socket.addEventListener("message", (event) => {
      try {
        this.dispatchEvent(new CustomEvent("event", { detail: JSON.parse(event.data) }));
      } catch (error) {
        console.error("WebSocket payload invalide", error);
      }
    });
    this.socket.addEventListener("close", () => {
      this.dispatchEvent(new CustomEvent("status", { detail: false }));
      if (!this.closed) {
        setTimeout(() => this.connect(), this.retry);
        this.retry = Math.min(this.retry * 2, 15000);
      }
    });
  }

  send(event) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event));
  }

  close() {
    this.closed = true;
    this.socket?.close();
  }
}
