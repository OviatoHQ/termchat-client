import {
  AUTH_SUBPROTOCOL,
  type ClientMarketplaceMessage,
  PONG,
  type ServerMarketplaceMessage,
  ServerMarketplaceMessage as ServerMarketplaceSchema,
  type TopicTag,
} from "@termchat/protocol";
import type { WebSocketLike } from "./lounge-client.ts";

export interface MarketplaceClientOptions {
  wsBase: string;
  clientId: string;
  token: string;
  socketFactory?: (url: string, protocols?: string[]) => WebSocketLike;
}

/**
 * Headless marketplace client: owns the WebSocket to the Marketplace DO, tracks
 * just enough state for ergonomic commands (latest offer, active/last session),
 * and fans validated server messages out to subscribers. The TUI is a thin view;
 * all behaviour is unit-tested under `bun test` with an injected socket.
 */
export class MarketplaceClient {
  private ws: WebSocketLike | undefined;
  private readonly listeners = new Set<(m: ServerMarketplaceMessage) => void>();
  /** Most recent summon offer received as an expert (so `/accept` needs no id). */
  latestOfferReqId: string | null = null;
  activeSessionId: number | null = null;
  lastEndedSessionId: number | null = null;

  constructor(private readonly options: MarketplaceClientOptions) {}

  subscribe(listener: (m: ServerMarketplaceMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  connect(): void {
    const factory =
      this.options.socketFactory ??
      ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
    const url = `${this.options.wsBase}/marketplace?clientId=${encodeURIComponent(this.options.clientId)}`;
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
      const result = ServerMarketplaceSchema.safeParse(parsed);
      if (result.success) this.apply(result.data);
    });
  }

  private apply(message: ServerMarketplaceMessage): void {
    switch (message.type) {
      case "summon_request":
        this.latestOfferReqId = message.reqId;
        break;
      case "summon_closed":
        if (this.latestOfferReqId === message.reqId) this.latestOfferReqId = null;
        break;
      case "session_start":
        this.activeSessionId = message.sessionId;
        break;
      case "session_end":
        this.lastEndedSessionId = message.sessionId;
        this.activeSessionId = null;
        break;
      default:
        break;
    }
    for (const listener of this.listeners) listener(message);
  }

  expertOn(rate: number, topics: TopicTag[]): void {
    this.send({ type: "expert_on", rate, topics });
  }
  expertOff(): void {
    this.send({ type: "expert_off" });
  }
  summon(input: {
    problem: string;
    maxRate: number;
    topic?: TopicTag;
    maxMinutes?: number;
    /** Targeted summon: address one named expert by handle instead of the auction. */
    target?: string;
    /** Free-call promo code (opaque; validated on the edge). */
    code?: string;
  }): void {
    this.send({ type: "summon", ...input });
  }
  /** Accept an offer; defaults to the most recent one when no id is given. */
  accept(reqId?: string): boolean {
    const id = reqId ?? this.latestOfferReqId;
    if (!id) return false;
    this.send({ type: "accept", reqId: id });
    return true;
  }
  decline(reqId?: string): boolean {
    const id = reqId ?? this.latestOfferReqId;
    if (!id) return false;
    this.send({ type: "decline", reqId: id });
    return true;
  }
  end(): void {
    this.send({ type: "end" });
  }
  /** Review a session; defaults to the last ended one when no id is given. */
  review(stars: number, text?: string, sessionId?: number): boolean {
    const id = sessionId ?? this.lastEndedSessionId;
    if (!id) return false;
    this.send({ type: "review", sessionId: id, stars, ...(text !== undefined ? { text } : {}) });
    return true;
  }
  experts(): void {
    this.send({ type: "experts" });
  }
  /** Request the open bounty board (browsable, claimable bounties). */
  bounties(): void {
    this.send({ type: "bounties" });
  }
  /** Request the caller's own sessions (Calls tab + review selection). */
  mySessions(): void {
    this.send({ type: "my_sessions" });
  }
  earnings(): void {
    this.send({ type: "earnings" });
  }
  dispute(sessionId: number, reason?: string): void {
    this.send({ type: "dispute", sessionId, ...(reason !== undefined ? { reason } : {}) });
  }
  bountyPost(priceCents: number, question: string): void {
    this.send({ type: "bounty_post", topic: null, question, priceCents });
  }
  bountyClaim(bountyId: number): void {
    this.send({ type: "bounty_claim", bountyId });
  }
  bountyAnswer(bountyId: number, answer: string): void {
    this.send({ type: "bounty_answer", bountyId, answer });
  }
  bountyAccept(bountyId: number): void {
    this.send({ type: "bounty_accept", bountyId });
  }
  bountyReject(bountyId: number): void {
    this.send({ type: "bounty_reject", bountyId });
  }
  close(): void {
    this.ws?.close();
  }

  private send(message: ClientMarketplaceMessage): void {
    try {
      this.ws?.send(JSON.stringify(message));
    } catch {
      // socket not ready / gone
    }
  }
}
