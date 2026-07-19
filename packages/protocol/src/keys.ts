import { z } from "zod";

/**
 * Identity-key directory wire types (docs/DMS.md stage 1). The edge distributes
 * X25519 *public* keys so two clients can derive a shared DM pair key; it never sees
 * a private key or any plaintext. All crypto happens client-side — these schemas only
 * carry the public key and validate its shape at the trust boundary.
 */

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded byte length of a standard-base64 string, or null if it isn't valid base64.
 *  Computed arithmetically (no `atob`) so it runs in the protocol package's non-DOM lib. */
function decodedByteLength(value: string): number | null {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** A base64-encoded X25519 public key — exactly 32 raw bytes. */
export const PublicKeyB64 = z
  .string()
  .refine((s) => decodedByteLength(s) === 32, "must be a base64-encoded 32-byte key");
export type PublicKeyB64 = z.infer<typeof PublicKeyB64>;

/**
 * Client → edge: publish my identity public key. Single-device v1 carries only the
 * public key; the passphrase-wrapped private-key backup (`wrappedSk`/`kdfParams`)
 * arrives with the multi-device milestone (docs/DMS.md stage 4). The publisher's
 * identity is taken from the auth token, never from this body.
 */
export const KeyPublishRequest = z.object({
  publicKey: PublicKeyB64,
});
export type KeyPublishRequest = z.infer<typeof KeyPublishRequest>;

/** Edge → client: a user's published identity public key. `user` is the CANONICAL
 *  identity handle (the server resolves a typed handle/display-name to it); pin + key
 *  threads by `user`. `displayName` is that user's current lounge name (`/nick`), for
 *  DISPLAY only — it can change, so it must never key a thread or a TOFU pin. */
export const KeyResponse = z.object({
  user: z.string(),
  publicKey: PublicKeyB64,
  displayName: z.string().nullable().optional(),
});
export type KeyResponse = z.infer<typeof KeyResponse>;
