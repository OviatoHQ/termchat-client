import { z } from "zod";
import { TopicTag } from "./topics.ts";

/**
 * Lounge chat wire protocol (PRD §8, Phase 1). Chat text is the user's own
 * deliberately-typed words (intentionally shared); the privacy gate (§11.3)
 * applies to the prompt-derived topic, not to chat. The server stamps `from`
 * from the verified identity, so senders cannot be spoofed.
 */

export const ChatText = z.string().trim().min(1).max(2000);

/** A user handle (target of a report). */
export const Handle = z.string().trim().min(1).max(128);

/**
 * A chosen display name (`/nick`) — for an anonymous guest (session-only) OR a
 * verified user (saved to their profile; identity handle stays fixed). Deliberately
 * narrow — 2–24 chars of letters/digits/`-`/`_`, starting alphanumeric — so names
 * can't spoof formatting or whitespace. Impersonating another account's handle or
 * display name is blocked server-side by a cross-namespace uniqueness check.
 */
export const NickName = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,23}$/, "2–24 chars: letters, digits, - or _");
export type NickName = z.infer<typeof NickName>;

/** Client → server. */
export const ClientChatMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("msg"), text: ChatText }),
  z.object({ type: z.literal("topic"), tag: TopicTag }),
  z.object({ type: z.literal("report"), target: Handle }),
  // Any socket may pick a display name (subject to cross-namespace availability). For
  // a guest it's session-only; for a verified user it's saved to their profile while
  // the identity handle (and all money/moderation keying) stays fixed.
  z.object({ type: z.literal("nick"), name: NickName }),
]);
export type ClientChatMessage = z.infer<typeof ClientChatMessage>;

/**
 * One participant in a room roster — only the coarse topic tag, never prompt text.
 * `verified` is true for GitHub-authenticated members and false for anonymous
 * guests, so the UI can mark who's signed in.
 */
export const RosterEntry = z.object({
  user: z.string(),
  topic: TopicTag.nullable(),
  verified: z.boolean(),
});
export type RosterEntry = z.infer<typeof RosterEntry>;

/** Server → client. */
export const ServerChatMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("msg"),
    from: z.string(),
    text: z.string(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("roster"),
    room: z.string(),
    members: z.array(RosterEntry),
    guests: z.number().int().nonnegative(),
  }),
  // The server tells each socket its own effective identity (assigned guest name
  // on connect, or the new name after a successful `/nick`).
  z.object({ type: z.literal("identity"), user: z.string(), verified: z.boolean() }),
  z.object({ type: z.literal("system"), text: z.string() }),
]);
export type ServerChatMessage = z.infer<typeof ServerChatMessage>;

/** `GET /rooms` directory response. */
export const RoomDirectory = z.object({
  rooms: z.array(z.string()),
});
export type RoomDirectory = z.infer<typeof RoomDirectory>;
