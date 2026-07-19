import {
  fetchPublicKey,
  loadOrCreateIdentity,
  publishPublicKey,
  safetyNumber,
} from "./dm-crypto.ts";

/**
 * `termchat dm` — stage 1 surface for the identity-key directory (docs/DMS.md).
 * Messaging + the DMs tab arrive in later stages; for now this generates/publishes
 * the local identity key and shows a word "safety number" to verify a peer
 * out-of-band. Login is required (DMs are login-only).
 */
export async function runDm(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "setup":
      await setup();
      return;
    case "fingerprint":
    case "verify":
      await fingerprint(rest[0]);
      return;
    default:
      console.log("usage: termchat dm setup | termchat dm fingerprint <user>");
  }
}

/** Generate this machine's identity (if needed) and publish the public key. */
async function setup(): Promise<void> {
  const identity = loadOrCreateIdentity();
  await publishPublicKey(identity.publicKey);
  console.log("DMs ready — your identity key is published.");
  console.log("Your private key stays on this machine (~/.termchat/keys/). Single-device for now:");
  console.log("reinstalling before backup exists means old messages can't be read.");
}

/** Show the safety number to compare with `user` out-of-band. */
async function fingerprint(user: string | undefined): Promise<void> {
  if (!user) {
    console.log("usage: termchat dm fingerprint <user>");
    process.exitCode = 1;
    return;
  }
  const identity = loadOrCreateIdentity();
  // Ensure my own key is published first — otherwise I could read a safety number for
  // `user` while they still see "hasn't set up DMs" for me (an asymmetric footgun).
  // Publish is an idempotent upsert, so this is safe to repeat.
  await publishPublicKey(identity.publicKey);
  const their = await fetchPublicKey(user);
  if (!their) {
    console.log(`${user} hasn't set up DMs yet (no published key).`);
    process.exitCode = 1;
    return;
  }
  const words = safetyNumber(identity.publicKey, their.key);
  // Show the canonical handle the directory resolved to (in case `user` was a nick).
  console.log(`Safety number with ${their.handle}:`);
  console.log(`  ${words.join(" · ")}`);
  console.log("Compare this with them over another channel — if it matches, no one is");
  console.log("intercepting. If it ever changes unexpectedly, stop and re-verify.");
}
