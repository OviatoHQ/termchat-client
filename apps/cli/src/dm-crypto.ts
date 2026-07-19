import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { KeyResponse } from "@termchat/protocol";
import { readCredentials, resolveEdge, termchatHome } from "./config.ts";
import { FINGERPRINT_WORDS } from "./wordlist.ts";

/**
 * Client-side DM crypto (docs/DMS.md — all crypto happens here; the edge only ever
 * sees public keys + ciphertext). Pure and unit-testable: an X25519 identity keypair,
 * ECDH→HKDF to a shared pair key, XChaCha20-Poly1305 seal/open per message, and a
 * symmetric word "safety number" both sides can compare out-of-band. Single-device v1:
 * the private key is generated locally and never leaves the machine (no backup yet).
 */

const HKDF_INFO = new TextEncoder().encode("termchat-dm-pairkey-v1");
const SAFETY_DOMAIN = new TextEncoder().encode("termchat-safety-number-v1");
const NONCE_BYTES = 24;
// 16 bytes → 16 words → 128 bits. NOT a display-length nicety: a MITM controls the key
// shown to EACH side and can grind both to force a safety-number collision, a birthday
// search at 2^(bits/2). 64 bits → ~2^32 (feasible); 128 bits → ~2^64 (the conventional
// floor). Do not lower this (docs/DMS.md verification UX).
const SAFETY_WORDS = 16;

export interface Identity {
  /** 32-byte X25519 public key (published to the edge). */
  publicKey: Uint8Array;
  /** 32-byte X25519 private key (stays in ~/.termchat/keys/, mode 0600). */
  privateKey: Uint8Array;
}

/** A single sealed message as it goes on the wire — base64, opaque to the edge. */
export interface SealedMessage {
  nonce: string;
  ciphertext: string;
}

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromB64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

// ---- identity ---------------------------------------------------------------

function keysDir(): string {
  return join(termchatHome(), "keys");
}

function identityPath(): string {
  return join(keysDir(), "identity.key");
}

/** Fresh X25519 identity keypair (not persisted). */
export function generateIdentity(): Identity {
  const privateKey = x25519.utils.randomSecretKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/** Load this machine's identity, generating + persisting one (0600) on first use. */
export function loadOrCreateIdentity(): Identity {
  const path = identityPath();
  if (existsSync(path)) {
    const privateKey = fromB64(readFileSync(path, "utf8").trim());
    return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
  }
  mkdirSync(keysDir(), { recursive: true, mode: 0o700 });
  const identity = generateIdentity();
  writeFileSync(path, toB64(identity.privateKey), { mode: 0o600 });
  return identity;
}

// ---- pair key + AEAD --------------------------------------------------------

/**
 * Derive the shared 32-byte pair key via ECDH + HKDF-SHA256. Symmetric by
 * construction: `derivePairKey(a.priv, b.pub) === derivePairKey(b.priv, a.pub)`, so
 * both parties (and all of a user's devices) decrypt the same thread.
 */
export function derivePairKey(myPrivate: Uint8Array, theirPublic: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(myPrivate, theirPublic);
  return hkdf(sha256, shared, undefined, HKDF_INFO, 32);
}

/** Seal one message: fresh random nonce → XChaCha20-Poly1305 AEAD. */
export function seal(pairKey: Uint8Array, plaintext: string): SealedMessage {
  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const ciphertext = xchacha20poly1305(pairKey, nonce).encrypt(new TextEncoder().encode(plaintext));
  return { nonce: toB64(nonce), ciphertext: toB64(ciphertext) };
}

/** Open a sealed message, or null if it's tampered / not for this pair key. */
export function open(pairKey: Uint8Array, message: SealedMessage): string | null {
  try {
    const plaintext = xchacha20poly1305(pairKey, fromB64(message.nonce)).decrypt(
      fromB64(message.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null; // AEAD tag failed: altered ciphertext/nonce or wrong key
  }
}

// ---- safety number ----------------------------------------------------------

/**
 * A symmetric word "safety number" for the pair — the SAME value both sides compute
 * (keys are sorted before hashing), so they read it aloud to detect a key-substitution
 * MITM. Words (not emoji) so it renders identically in every terminal and reads aloud
 * unambiguously (docs/DMS.md resolved decision).
 */
export function safetyNumber(myPublic: Uint8Array, theirPublic: Uint8Array): string[] {
  const [first, second] =
    Buffer.compare(Buffer.from(myPublic), Buffer.from(theirPublic)) <= 0
      ? [myPublic, theirPublic]
      : [theirPublic, myPublic];
  const digest = sha256(new Uint8Array([...SAFETY_DOMAIN, ...first, ...second]));
  const words: string[] = [];
  for (const byte of digest.slice(0, SAFETY_WORDS)) {
    words.push(FINGERPRINT_WORDS[byte] as string);
  }
  return words;
}

// ---- publish / fetch (edge key directory) -----------------------------------

/** Publish my identity public key to the edge. Login required (DMs are login-only). */
export async function publishPublicKey(publicKey: Uint8Array): Promise<void> {
  const credentials = readCredentials();
  if (!credentials) throw new Error("sign in to set up DMs (login required)");
  const { httpBase } = resolveEdge();
  const res = await fetch(`${httpBase}/keys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ publicKey: toB64(publicKey) }),
  });
  if (!res.ok) throw new Error(`could not publish key (${res.status})`);
}

/**
 * Fetch a user's published public key AND their canonical identity handle, or null if
 * they haven't set up DMs. The server resolves a typed name (handle OR display name) to
 * the stable handle and returns it as `user` — callers MUST key threads/TOFU-pins by
 * that handle, never the typed name (display names are reassignable → spoofable pins).
 */
export async function fetchPublicKey(
  user: string,
): Promise<{ key: Uint8Array; handle: string; displayName: string | null } | null> {
  const credentials = readCredentials();
  if (!credentials) throw new Error("sign in to use DMs (login required)");
  const { httpBase } = resolveEdge();
  const res = await fetch(`${httpBase}/keys/${encodeURIComponent(user)}`, {
    headers: { authorization: `Bearer ${credentials.token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`could not fetch key (${res.status})`);
  const parsed = KeyResponse.safeParse(await res.json());
  return parsed.success
    ? {
        key: fromB64(parsed.data.publicKey),
        handle: parsed.data.user,
        displayName: parsed.data.displayName ?? null,
      }
    : null;
}
