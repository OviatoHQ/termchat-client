import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCredentials } from "../src/config.ts";
import { loadOrCreateIdentity } from "../src/dm-crypto.ts";

// The DM identity keypair is scoped to the signed-in GitHub account so two accounts on
// one machine (same TERMCHAT_HOME) never share a key — sharing one collapses E2E.
describe("loadOrCreateIdentity — per-account isolation", () => {
  let home: string;
  const prev = process.env.TERMCHAT_HOME;
  const login = (githubLogin: string) =>
    writeCredentials({ token: "tok", user: githubLogin, githubLogin });
  const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "termchat-id-"));
    process.env.TERMCHAT_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.TERMCHAT_HOME;
    else process.env.TERMCHAT_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  test("two accounts on the same home get DIFFERENT keys in separate files", () => {
    login("nulltohull");
    const a = loadOrCreateIdentity();
    login("shafius");
    const b = loadOrCreateIdentity();
    expect(same(a.publicKey, b.publicKey)).toBe(false);
    expect(existsSync(join(home, "keys", "identity-nulltohull.key"))).toBe(true);
    expect(existsSync(join(home, "keys", "identity-shafius.key"))).toBe(true);
  });

  test("the same account gets a STABLE key across calls (persisted)", () => {
    login("nulltohull");
    const a1 = loadOrCreateIdentity();
    const a2 = loadOrCreateIdentity();
    expect(same(a1.publicKey, a2.publicKey)).toBe(true);
  });

  test("login is case-folded to one file (Shafius == shafius)", () => {
    login("Shafius");
    const a = loadOrCreateIdentity();
    login("shafius");
    const b = loadOrCreateIdentity();
    expect(same(a.publicKey, b.publicKey)).toBe(true);
  });
});
