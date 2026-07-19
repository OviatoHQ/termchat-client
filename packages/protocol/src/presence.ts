import { z } from "zod";
import { TopicTag } from "./topics.ts";

/**
 * Phase 0 presence protocol.
 *
 * One WebSocket per client (the local presence daemon). The server (a single
 * `lobby` Durable Object) broadcasts a {@link PresenceSnapshot} on every change.
 * Client activity (waiting on the agent vs. idle) is flipped out-of-band by
 * one-shot hook HTTP calls — see {@link PresenceStateUpdate}.
 *
 * Privacy invariant (PRD §11.3): nothing here carries raw prompt text, `cwd`,
 * file paths, or transcripts. Only opaque identifiers and coarse counts cross
 * the wire.
 */

/** Fixed name of the single global lounge room for Phase 0 (PRD §6). */
export const LOBBY_ROOM = "lobby";

/**
 * Keepalive request/response strings. The DO answers `PING` with `PONG` via
 * `setWebSocketAutoResponse()` so heartbeats never wake a hibernating object
 * (PRD §6 invariant 2). These are raw socket strings, not JSON envelopes.
 */
export const PING = "ping";
export const PONG = "pong";

/** A client is either idle or busy (waiting on the agent). */
export const PresenceStateValue = z.enum(["idle", "busy"]);
export type PresenceStateValue = z.infer<typeof PresenceStateValue>;

/**
 * Body of `POST /presence/state`, fired one-shot by Claude Code hooks.
 *
 * `clientId` ties the HTTP call back to the daemon's open WebSocket. `sessionId`
 * (the Claude Code session) lets one machine run several concurrent sessions
 * without one session's `Stop` flipping another session's `busy` to idle:
 * the client counts as "waiting" while ANY of its sessions is busy.
 */
export const PresenceStateUpdate = z.object({
  clientId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128).optional(),
  state: PresenceStateValue,
  /**
   * Coarse, locally-derived topic tag (PRD §11.3). Constrained to the public
   * allow-list so raw prompt text can never ride along on this field.
   */
  topic: TopicTag.optional(),
});
export type PresenceStateUpdate = z.infer<typeof PresenceStateUpdate>;

/** Coarse, recomputed-from-sockets counts. `experts` is always 0 in Phase 0. */
export const PresenceCounts = z.object({
  online: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  experts: z.number().int().nonnegative(),
});
export type PresenceCounts = z.infer<typeof PresenceCounts>;

/** Server → client broadcast, sent on every presence change. */
export const PresenceSnapshot = PresenceCounts.extend({
  type: z.literal("presence"),
  ts: z.number().int().nonnegative(),
});
export type PresenceSnapshot = z.infer<typeof PresenceSnapshot>;

/** Response body of `GET /online` — the status-line warm bootstrap (PRD §6). */
export const OnlineResponse = PresenceCounts.extend({
  ts: z.number().int().nonnegative(),
});
export type OnlineResponse = z.infer<typeof OnlineResponse>;

/**
 * Inbound JSON messages a client may send over the WebSocket. Phase 0 has no
 * meaningful client→server JSON (keepalive uses the raw {@link PING} string,
 * handled by auto-response), but the DO still Zod-validates every inbound frame
 * at the trust boundary and ignores anything that does not match (PRD §5.1).
 */
export const ClientMessage = z.object({ type: z.literal("ping") });
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Build the broadcast envelope from recomputed counts. */
export function buildPresenceSnapshot(counts: PresenceCounts, ts: number): PresenceSnapshot {
  return { type: "presence", ...counts, ts };
}
