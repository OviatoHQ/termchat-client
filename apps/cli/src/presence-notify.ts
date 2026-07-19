import { AUTH_SUBPROTOCOL, DmNotify, PONG } from "@termchat/protocol";
import type { WebSocketLike } from "./lounge-client.ts";

export interface PresenceNotifyOptions {
  wsBase: string;
  clientId: string;
  token: string;
  /** Invoked when the edge pushes a `dm_notify` (a DM arrived for us). */
  onDmNotify: (from: string) => void;
  /** Injectable for tests; defaults to the global WebSocket. */
  socketFactory?: (url: string, protocols?: string[]) => WebSocketLike;
}

/**
 * Lightweight presence subscription for the chat TUI (docs/DMS.md). It holds one socket
 * to the global presence room and calls `onDmNotify` when the edge nudges us that a DM
 * arrived — the PUSH replacement for inbox polling, using the SAME channel the daemon
 * listens on for desktop toasts. It carries the user's token so the edge can target this
 * socket; on the same machine it shares the daemon's clientId, so it doesn't inflate the
 * online count. Basic reconnect so a network blip doesn't silently stop notifications.
 */
export class PresenceNotifyClient {
  private ws: WebSocketLike | undefined;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: PresenceNotifyOptions) {}

  connect(): void {
    const factory =
      this.options.socketFactory ??
      ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
    const url = `${this.options.wsBase}/ws?clientId=${encodeURIComponent(this.options.clientId)}`;
    const ws = factory(url, [AUTH_SUBPROTOCOL, this.options.token]);
    this.ws = ws;

    ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (!data || data === PONG) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      // We only care about DM nudges here; presence counts are the daemon's job.
      const notify = DmNotify.safeParse(parsed);
      if (notify.success) this.options.onDmNotify(notify.data.from);
    });
    ws.addEventListener("close", () => this.scheduleReconnect());
    ws.addEventListener("error", () => this.scheduleReconnect());
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closed) this.connect();
    }, 2000);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
