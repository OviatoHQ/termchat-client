import {
  AUTH_SUBPROTOCOL,
  type ClientChatMessage,
  PONG,
  type RosterEntry,
  type ServerChatMessage,
  ServerChatMessage as ServerChatMessageSchema,
  type TopicTag,
} from "@termchat/protocol";

/** One line in the chat transcript the TUI renders. */
export interface ChatLine {
  id: number;
  kind: "msg" | "system";
  from?: string;
  text: string;
  ts: number;
}

export interface LoungeState {
  room: string;
  connected: boolean;
  lines: ChatLine[];
  members: RosterEntry[];
  guests: number;
  /** This socket's effective display name (assigned guest name, or GitHub handle). */
  self: string | null;
  /** Whether this socket is a verified (signed-in) identity. */
  verified: boolean;
}

export interface LoungeClientOptions {
  wsBase: string;
  clientId: string;
  token?: string;
  room: string;
  /** Injectable for tests; defaults to the global WebSocket. */
  socketFactory?: (url: string, protocols?: string[]) => WebSocketLike;
}

/** Minimal WebSocket surface the client needs (lets tests inject a fake). */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "close" | "error" | "message",
    handler: (event: { data?: unknown }) => void,
  ): void;
}

const MAX_LINES = 500;

/**
 * Headless lounge chat client: owns the WebSocket, applies server messages to an
 * observable {@link LoungeState}, and exposes intent methods. The Ink component
 * is a thin view over this — so all behaviour is unit-testable under `bun test`.
 */
export class LoungeClient {
  private ws: WebSocketLike | undefined;
  private lineSeq = 0;
  private readonly options: LoungeClientOptions;
  /** Current auth token — mutable so `/login`/`/logout` can re-auth in place. */
  private token: string | undefined;
  private state: LoungeState;
  private readonly listeners = new Set<(state: LoungeState) => void>();

  constructor(options: LoungeClientOptions) {
    this.options = options;
    this.token = options.token;
    this.state = {
      room: options.room,
      connected: false,
      lines: [],
      members: [],
      guests: 0,
      self: null,
      verified: this.token !== undefined,
    };
  }

  getState(): LoungeState {
    return this.state;
  }

  /** Subscribe to state changes; returns an unsubscribe function. */
  subscribe(listener: (state: LoungeState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get verified(): boolean {
    return this.token !== undefined;
  }

  /**
   * Re-authenticate the live connection: swap the token (or clear it), then
   * reconnect so the socket rejoins with the new identity. History is kept; the
   * roster + self reset and the server re-sends them on reconnect. Drives
   * `/login` (guest → verified) and `/logout` (verified → guest) in place.
   */
  reauthenticate(token: string | undefined): void {
    this.token = token;
    this.state = {
      ...this.state,
      connected: false,
      members: [],
      self: null,
      verified: token !== undefined,
    };
    this.emit();
    this.ws?.close();
    this.connect();
  }

  connect(): void {
    const factory =
      this.options.socketFactory ??
      ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
    const url = `${this.options.wsBase}/lounge?room=${encodeURIComponent(this.state.room)}&clientId=${encodeURIComponent(this.options.clientId)}`;
    const protocols = this.token ? [AUTH_SUBPROTOCOL, this.token] : undefined;
    const ws = factory(url, protocols);
    this.ws = ws;

    ws.addEventListener("open", () => this.patch({ connected: true }));
    ws.addEventListener("close", () => this.patch({ connected: false }));
    ws.addEventListener("error", () => this.patch({ connected: false }));
    ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (!data || data === PONG) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      const result = ServerChatMessageSchema.safeParse(parsed);
      if (result.success) this.apply(result.data);
    });
  }

  /** Send a chat message (anonymous guests may post; the server rate-limits). */
  sendMessage(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.send({ type: "msg", text: trimmed.slice(0, 2000) });
  }

  /** Pick/change this guest's display name (server validates availability). */
  setNick(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.send({ type: "nick", name: trimmed });
  }

  /** Publish the coarse topic tag for this session's roster entry. */
  setTopic(tag: TopicTag): void {
    this.send({ type: "topic", tag });
  }

  /** Report another user for abuse (server applies a distinct-reporter threshold). */
  report(target: string): void {
    const handle = target.trim();
    if (!handle) return;
    this.send({ type: "report", target: handle });
  }

  /** Switch rooms: tear down the current socket and reconnect to a fresh one. */
  switchRoom(room: string): void {
    this.ws?.close();
    this.state = {
      room,
      connected: false,
      lines: [],
      members: [],
      guests: 0,
      self: null, // server re-sends identity on reconnect
      verified: this.token !== undefined,
    };
    this.emit();
    this.connect();
  }

  close(): void {
    this.ws?.close();
  }

  private send(message: ClientChatMessage): void {
    try {
      this.ws?.send(JSON.stringify(message));
    } catch {
      // socket not ready / gone; the UI shows the disconnected state
    }
  }

  private apply(message: ServerChatMessage): void {
    switch (message.type) {
      case "msg":
        this.appendLine({ kind: "msg", from: message.from, text: message.text, ts: message.ts });
        break;
      case "system":
        this.appendLine({ kind: "system", text: message.text, ts: Date.now() });
        break;
      case "roster":
        this.patch({ members: message.members, guests: message.guests, room: message.room });
        break;
      case "identity":
        this.patch({ self: message.user, verified: message.verified });
        break;
    }
  }

  private appendLine(line: Omit<ChatLine, "id">): void {
    this.lineSeq += 1;
    const lines = [...this.state.lines, { ...line, id: this.lineSeq }].slice(-MAX_LINES);
    this.patch({ lines });
  }

  private patch(partial: Partial<LoungeState>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}
