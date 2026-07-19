import { describe, expect, test } from "bun:test";
import { derivePairKey, generateIdentity, open, safetyNumber, seal } from "../src/dm-crypto.ts";
import { FINGERPRINT_WORDS } from "../src/wordlist.ts";

describe("dm-crypto", () => {
  test("identity keys are 32 bytes", () => {
    const id = generateIdentity();
    expect(id.privateKey.length).toBe(32);
    expect(id.publicKey.length).toBe(32);
  });

  test("both parties derive the same pair key (ECDH is symmetric)", () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const aliceKey = derivePairKey(alice.privateKey, bob.publicKey);
    const bobKey = derivePairKey(bob.privateKey, alice.publicKey);
    expect(Buffer.from(aliceKey).equals(Buffer.from(bobKey))).toBe(true);
    expect(aliceKey.length).toBe(32);
  });

  test("seal → open round-trips, and the peer can read it", () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const aliceKey = derivePairKey(alice.privateKey, bob.publicKey);
    const bobKey = derivePairKey(bob.privateKey, alice.publicKey);

    const sealed = seal(aliceKey, "yo bro ssup");
    expect(open(bobKey, sealed)).toBe("yo bro ssup");
  });

  test("each seal uses a fresh nonce (no reuse across messages)", () => {
    const key = derivePairKey(generateIdentity().privateKey, generateIdentity().publicKey);
    const a = seal(key, "hi");
    const b = seal(key, "hi");
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test("open returns null on tampered ciphertext", () => {
    const key = derivePairKey(generateIdentity().privateKey, generateIdentity().publicKey);
    const sealed = seal(key, "secret");
    const raw = Buffer.from(sealed.ciphertext, "base64");
    raw[0] = (raw[0] ?? 0) ^ 0xff; // flip a byte
    expect(open(key, { nonce: sealed.nonce, ciphertext: raw.toString("base64") })).toBeNull();
  });

  test("open returns null with the wrong pair key", () => {
    const good = derivePairKey(generateIdentity().privateKey, generateIdentity().publicKey);
    const wrong = derivePairKey(generateIdentity().privateKey, generateIdentity().publicKey);
    expect(open(wrong, seal(good, "secret"))).toBeNull();
  });

  test("safety number is symmetric, fixed-length, and drawn from the wordlist", () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const fromAlice = safetyNumber(alice.publicKey, bob.publicKey);
    const fromBob = safetyNumber(bob.publicKey, alice.publicKey);
    expect(fromAlice).toEqual(fromBob); // both sides see the identical number
    expect(fromAlice.length).toBe(16); // 128-bit — resists birthday-collision MITM
    for (const word of fromAlice) expect(FINGERPRINT_WORDS).toContain(word);
  });

  test("safety number changes if a key is substituted (MITM is detectable)", () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const attacker = generateIdentity();
    const honest = safetyNumber(alice.publicKey, bob.publicKey);
    const mitm = safetyNumber(alice.publicKey, attacker.publicKey);
    expect(honest).not.toEqual(mitm);
  });
});

describe("fingerprint wordlist", () => {
  test("is exactly 256 unique lowercase words", () => {
    expect(FINGERPRINT_WORDS.length).toBe(256);
    expect(new Set(FINGERPRINT_WORDS).size).toBe(256);
    for (const word of FINGERPRINT_WORDS) expect(word).toMatch(/^[a-z]{3,7}$/);
  });
});
