import {
  AUTH_SUBPROTOCOL,
  type ClientDmMessage,
  type DmMessagePayload,
  PONG,
  type ServerDmMessage,
  ServerDmMessage as ServerDmMessageSchema,
} from "@termchat/protocol";
import { type Identity, derivePairKey, open, seal } from "./dm-crypto.ts";
import type { WebSocketLike } from "./lounge-client.ts";

/** One decrypted line in a conversation the TUI renders. */
export interface DmLine {
  /** Server id once persisted; a negative placeholder while optimistic/pending. */
  id: number;
  from: string;
  text: string;
  ts: number;
  /** True until the server echoes this message back (optimistic local send). */
  pending?: boolean;
  /** True when the ciphertext could not be opened (wrong/rotated key, tamper). */
  undecryptable?: boolean;
  clientMsgId?: string;
}

export interface DmState {
  peer: string;
  connected: boolean;
  lines: DmLine[];
  /** This socket's own identity handle (from `dm_ready`). */
  self: string | null;
}

export interface DmClientOptions {
  wsBase: string;
  token: string;
  peer: string;
  identity: Identity;
  /** The peer's published public key (fetched + TOFU-pinned by the caller). */
  peerPublicKey: Uint8Array;
  socketFactory?: (url: string, protocols?: string[]) => WebSocketLike;
  /** Injectable id source for clientMsgId (tests); defaults to crypto.randomUUID. */
  idFactory?: () => string;
}

const MAX_LINES = 1000;

/**
 * Headless direct-message client: owns the WebSocket to a `DmRoom`, seals outbound
 * and opens inbound with the shared pair key, and applies server frames to an
 * observable {@link DmState}. All crypto is local (the edge only ever sees
 * ciphertext). The Ink view is a thin layer over this — so behaviour is unit-testable.
 */
export class DmClient {
  private ws: WebSocketLike | undefined;
  private readonly options: DmClientOptions;
  private readonly pairKey: Uint8Array;
  private readonly idFactory: () => string;
  private optimisticSeq = 0;
  private readonly seenIds = new Set<number>();
  private state: DmState;
  private readonly listeners = new Set<(state: DmState) => void>();
  /** True once the socket has fired `open`; sends before this are queued (below). */
  private isOpen = false;
  /** Frames enqueued while the socket was still connecting, flushed on `open`. */
  private outbox: string[] = [];

  constructor(options: DmClientOptions) {
    this.options = options;
    this.pairKey = derivePairKey(options.identity.privateKey, options.peerPublicKey);
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.state = { peer: options.peer, connected: false, lines: [], self: null };
  }

  getState(): DmState {
    return this.state;
  }

  subscribe(listener: (state: DmState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  connect(): void {
    const factory =
      this.options.socketFactory ??
      ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
    const url = `${this.options.wsBase}/dm?peer=${encodeURIComponent(this.options.peer)}`;
    const ws = factory(url, [AUTH_SUBPROTOCOL, this.options.token]);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.isOpen = true;
      this.patch({ connected: true });
      this.flushOutbox();
    });
    ws.addEventListener("close", () => {
      this.isOpen = false;
      this.patch({ connected: false });
    });
    ws.addEventListener("error", () => {
      this.isOpen = false;
      this.patch({ connected: false });
    });
    ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (!data || data === PONG) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      const result = ServerDmMessageSchema.safeParse(parsed);
      if (result.success) this.apply(result.data);
    });
  }

  /** Seal + send a message, showing it immediately (optimistic) pending server echo. */
  sendMessage(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const clientMsgId = this.idFactory();
    const sealed = seal(this.pairKey, trimmed);
    this.optimisticSeq += 1;
    this.appendLine({
      id: -this.optimisticSeq,
      from: this.state.self ?? "me",
      text: trimmed,
      ts: Date.now(),
      pending: true,
      clientMsgId,
    });
    this.send({ type: "dm_send", nonce: sealed.nonce, ciphertext: sealed.ciphertext, clientMsgId });
  }

  /** Page older history before `beforeId` (omit for the newest page). */
  requestHistory(beforeId?: number): void {
    this.send(beforeId ? { type: "dm_history", before: beforeId } : { type: "dm_history" });
  }

  /** Advance this user's read cursor on the server (drives offline replay + unread). */
  markRead(upToId: number): void {
    if (upToId <= 0) return;
    this.send({ type: "dm_read", upToId });
  }

  close(): void {
    this.ws?.close();
  }

  private send(message: ClientDmMessage): void {
    const frame = JSON.stringify(message);
    // Queue until the socket is OPEN. A send during the WS handshake — e.g. the first
    // line from `/dm <user> <msg>`, which sends right after connect() — would otherwise
    // throw and be silently dropped (the message never reaches the peer). Flush on open.
    if (!this.isOpen) {
      this.outbox.push(frame);
      return;
    }
    try {
      this.ws?.send(frame);
    } catch {
      this.outbox.push(frame); // socket raced closed; keep it for the next open
    }
  }

  /** Send everything queued while connecting, in order, once the socket is open. */
  private flushOutbox(): void {
    const queued = this.outbox;
    this.outbox = [];
    for (const frame of queued) {
      try {
        this.ws?.send(frame);
      } catch {
        this.outbox.push(frame);
      }
    }
  }

  private apply(message: ServerDmMessage): void {
    switch (message.type) {
      case "dm_ready":
        this.patch({ self: message.self, peer: message.peer });
        break;
      case "dm_message":
        this.ingest(message.message);
        break;
      case "dm_backlog":
        for (const m of message.messages) this.ingest(m);
        break;
    }
  }

  /** Fold one persisted message in: reconcile my optimistic copy, or append; dedupe. */
  private ingest(payload: DmMessagePayload): void {
    if (this.seenIds.has(payload.id)) return; // already have this server row

    // Reconcile the optimistic line I sent (match by clientMsgId) → real id, not pending.
    if (payload.clientMsgId) {
      const idx = this.state.lines.findIndex(
        (l) => l.pending && l.clientMsgId === payload.clientMsgId,
      );
      if (idx !== -1) {
        this.seenIds.add(payload.id);
        const lines = [...this.state.lines];
        lines[idx] = { ...lines[idx], id: payload.id, ts: payload.ts, pending: false } as DmLine;
        this.patch({ lines });
        return;
      }
    }

    const text = open(this.pairKey, { nonce: payload.nonce, ciphertext: payload.ciphertext });
    this.seenIds.add(payload.id);
    this.appendLine({
      id: payload.id,
      from: payload.from,
      text: text ?? "",
      ts: payload.ts,
      undecryptable: text === null,
      ...(payload.clientMsgId ? { clientMsgId: payload.clientMsgId } : {}),
    });
  }

  private appendLine(line: DmLine): void {
    const lines = [...this.state.lines, line].slice(-MAX_LINES);
    this.patch({ lines });
  }

  private patch(partial: Partial<DmState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.state);
  }
}
