import { z } from "zod";

/**
 * Direct-message wire protocol (docs/DMS.md stage 2). Every body is **ciphertext** —
 * the edge validates the envelope shape (base64, sizes, ids) but by construction can
 * never read the plaintext. One `DmRoom` Durable Object per sorted pair of users
 * relays live and persists to D1; clients seal/open with a shared pair key.
 */

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded byte length of a standard-base64 string, or null if malformed (no `atob`). */
function decodedByteLength(value: string): number | null {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** Base64 XChaCha20-Poly1305 nonce — exactly 24 bytes. */
export const NonceB64 = z
  .string()
  .refine((s) => decodedByteLength(s) === 24, "must be a base64 24-byte nonce");

/** Base64 AEAD ciphertext — at least the 16-byte tag, capped so one message can't be
 *  huge (plaintext is capped ~2000 chars → a few KB of base64). */
export const CiphertextB64 = z
  .string()
  .max(16384)
  .refine((s) => {
    const n = decodedByteLength(s);
    return n !== null && n >= 16;
  }, "must be base64 AEAD ciphertext");

/** A client-generated message id for idempotent retries + optimistic reconciliation. */
export const ClientMsgId = z.string().min(1).max(64);

/** A user handle DMs can target (GitHub-login shape). Login-only — no guests. */
export const DmPeer = z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/, "invalid handle");
export type DmPeer = z.infer<typeof DmPeer>;

/** The sorted, stable key for a conversation between two users ("alice|bob"). Both
 *  sides + the router compute the same value, so both connect to the same DO. */
export function dmPairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

// ---- client → edge ----------------------------------------------------------

export const ClientDmMessage = z.discriminatedUnion("type", [
  // Send one sealed message. `clientMsgId` dedupes retries + reconciles the optimistic
  // local echo with the server-assigned id.
  z.object({
    type: z.literal("dm_send"),
    nonce: NonceB64,
    ciphertext: CiphertextB64,
    clientMsgId: ClientMsgId,
  }),
  // Page older history before `before` (omit for the newest page).
  z.object({ type: z.literal("dm_history"), before: z.number().int().positive().optional() }),
  // Advance this user's read cursor (monotonic on the server).
  z.object({ type: z.literal("dm_read"), upToId: z.number().int().nonnegative() }),
]);
export type ClientDmMessage = z.infer<typeof ClientDmMessage>;

// ---- edge → client ----------------------------------------------------------

/** One stored message as delivered to a client — still opaque ciphertext. */
export const DmMessagePayload = z.object({
  id: z.number().int().positive(),
  from: z.string(),
  nonce: NonceB64,
  ciphertext: CiphertextB64,
  ts: z.number().int().nonnegative(),
  clientMsgId: ClientMsgId.optional(),
});
export type DmMessagePayload = z.infer<typeof DmMessagePayload>;

// ---- notifications + inbox (docs/DMS.md stage 3) ----------------------------

/**
 * Edge → presence socket: a metadata-only nudge that a DM arrived, so the daemon can
 * raise a desktop notification when the TUI isn't on that thread. §11.3: carries ONLY
 * the sender handle (already-unhidden metadata) — never a nonce, ciphertext, or any
 * message content. The daemon builds a fixed banner from `from` alone.
 */
export const DmNotify = z.object({ type: z.literal("dm_notify"), from: z.string() });
export type DmNotify = z.infer<typeof DmNotify>;

/** Internal DmRoom → PresenceRoom push body: which user to nudge, and from whom. */
export const DmNotifyPush = z.object({ from: z.string(), to: z.string() });
export type DmNotifyPush = z.infer<typeof DmNotifyPush>;

/** One inbox thread — metadata only (no message content; the client decrypts its
 *  own snippet from cache). `unread` counts messages to me past my read cursor. */
export const DmInboxThread = z.object({
  /** The peer's CANONICAL identity handle (stable — used to open/route the thread). */
  peer: z.string(),
  /** The peer's current display name (`/nick`), for the thread label only (may change). */
  displayName: z.string().nullable().optional(),
  lastId: z.number().int().nonnegative(),
  lastTs: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
});
export type DmInboxThread = z.infer<typeof DmInboxThread>;

export const DmInboxResponse = z.object({ threads: z.array(DmInboxThread) });
export type DmInboxResponse = z.infer<typeof DmInboxResponse>;

export const ServerDmMessage = z.discriminatedUnion("type", [
  // Sent once on connect: who this socket is and who it's talking to.
  z.object({ type: z.literal("dm_ready"), self: z.string(), peer: z.string() }),
  // A live or echoed message (broadcast to every socket on the pair DO).
  z.object({ type: z.literal("dm_message"), message: DmMessagePayload }),
  // A batch: offline replay on connect, or a `dm_history` page.
  z.object({ type: z.literal("dm_backlog"), messages: z.array(DmMessagePayload) }),
]);
export type ServerDmMessage = z.infer<typeof ServerDmMessage>;
