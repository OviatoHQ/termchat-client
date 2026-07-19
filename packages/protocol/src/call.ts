import { z } from "zod";

/**
 * Audio-call signaling (PRD §3.3, §11.6). Media is **relayed via the Cloudflare
 * Realtime SFU, never P2P** — each participant negotiates with the SFU (through
 * the Worker, which holds the app secret) and the Session DO only relays SFU
 * *coordinates* (`sfuSessionId` + `trackName`) so each side can subscribe to the
 * other's published track. No ICE candidates, IPs, or host info ever cross the
 * signaling channel, so participants can't learn each other's addresses.
 */

export const SfuSessionId = z.string().min(1).max(128);
export const TrackName = z.string().min(1).max(64);

// ---- Worker `/call/token` mint (browser → Worker → RealtimeKit, Phase 3A) ----

/** Browser asks the Worker to mint a short-lived RealtimeKit participant token for
 *  the caller's seat in a session. The account API token NEVER reaches the browser. */
export const CallTokenRequest = z.object({ sessionId: z.number().int().positive() });
export type CallTokenRequest = z.infer<typeof CallTokenRequest>;

/**
 * The Worker returns the short-lived participant authToken (NEVER the account token
 * or any secret) plus non-sensitive session context the call UI renders: the two
 * participants' handles, the caller's role, and the user-typed summon `problem` +
 * coarse `topic` (both already shown to the expert in the marketplace). Sent in the
 * POST response body (no-store), never in the URL — per PRD §9 / CLAUDE.md.
 */
export const CallTokenResponse = z.object({
  token: z.string().min(1),
  self: z.string(),
  peer: z.string(),
  role: z.enum(["seeker", "expert"]),
  problem: z.string().nullable(),
  topic: z.string().nullable(),
});
export type CallTokenResponse = z.infer<typeof CallTokenResponse>;

/**
 * THE HINGE (Phase 3A.1). The billing clock must start only when AUDIO is actually
 * flowing — never on mere room-join. The call page emits `{type:"connected"}` exactly
 * once, the first time a remote participant's audio becomes enabled; `participantJoined`
 * never calls this. Pure + bun-tested so the anchor can't silently regress.
 */
export function shouldEmitConnected(audioAlreadySeen: boolean, audioEnabled: boolean): boolean {
  return !audioAlreadySeen && audioEnabled;
}

// ---- Session-DO call signaling (call page ↔ DO over WebSocket) ---------------

/** WebSocket subprotocol carrying the session token for the call signaling socket. */
export const CALL_SUBPROTOCOL = "termchat-call";

/** Client → DO. Deliberately carries only SFU coordinates + control — no IPs. */
export const ClientCallSignal = z.discriminatedUnion("type", [
  z.object({ type: z.literal("announce"), sfuSessionId: SfuSessionId, trackName: TrackName }),
  z.object({ type: z.literal("connected") }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("end") }),
]);
export type ClientCallSignal = z.infer<typeof ClientCallSignal>;

/** DO → client. */
export const ServerCallSignal = z.discriminatedUnion("type", [
  z.object({ type: z.literal("peer_announce"), sfuSessionId: SfuSessionId, trackName: TrackName }),
  z.object({ type: z.literal("state"), connected: z.boolean(), paused: z.boolean() }),
  z.object({ type: z.literal("meter"), minutes: z.number().int(), chargeCents: z.number().int() }),
  z.object({
    type: z.literal("ended"),
    minutes: z.number().int(),
    chargeCents: z.number().int(),
    payoutCents: z.number().int(),
    role: z.enum(["seeker", "expert"]),
  }),
]);
export type ServerCallSignal = z.infer<typeof ServerCallSignal>;
