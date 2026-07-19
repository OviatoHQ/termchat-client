import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPublicKey, publishPublicKey } from "../src/dm-crypto.ts";

// Drive the REAL config module rather than mock.module (which is process-global in bun
// and would leak into other test files): point TERMCHAT_HOME at a temp dir with a real
// credentials file, set TERMCHAT_EDGE, and stub only global fetch. This exercises the
// HAPPY path of publish/fetch — URL, Bearer header, body, response parse — which the
// login-guarded smoke test never reaches.

const PUB = new Uint8Array(32).fill(7);
const PUB_B64 = Buffer.from(PUB).toString("base64");

let home: string;
const prevHome = process.env.TERMCHAT_HOME;
const prevEdge = process.env.TERMCHAT_EDGE;
const realFetch = globalThis.fetch;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "termchat-dm-net-"));
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "credentials.json"),
    JSON.stringify({ token: "tok-123", user: "me", githubLogin: "me" }),
  );
  process.env.TERMCHAT_HOME = home;
  process.env.TERMCHAT_EDGE = "https://edge.test";
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.TERMCHAT_HOME;
  else process.env.TERMCHAT_HOME = prevHome;
  if (prevEdge === undefined) delete process.env.TERMCHAT_EDGE;
  else process.env.TERMCHAT_EDGE = prevEdge;
  rmSync(home, { recursive: true, force: true });
});

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

/** Replace global fetch with a canned responder that records the calls. */
function stubFetch(response: Response): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response;
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("key directory client (happy path)", () => {
  test("publishPublicKey POSTs to /keys with the bearer token and base64 body", async () => {
    const calls = stubFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await publishPublicKey(PUB);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("https://edge.test/keys");
    expect(call?.init?.method).toBe("POST");
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok-123");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ publicKey: PUB_B64 });
  });

  test("publishPublicKey throws on a non-OK response", async () => {
    stubFetch(new Response("nope", { status: 500 }));
    await expect(publishPublicKey(PUB)).rejects.toThrow();
  });

  test("fetchPublicKey GETs /keys/:user and decodes the returned key", async () => {
    const calls = stubFetch(
      new Response(JSON.stringify({ user: "alice", publicKey: PUB_B64 }), { status: 200 }),
    );
    const result = await fetchPublicKey("alice");

    expect(calls[0]?.url).toBe("https://edge.test/keys/alice");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer tok-123");
    expect(result).not.toBeNull();
    expect(Buffer.from((result as { key: Uint8Array }).key).equals(Buffer.from(PUB))).toBe(true);
    expect((result as { handle: string }).handle).toBe("alice");
  });

  test("fetchPublicKey URL-encodes the username", async () => {
    const calls = stubFetch(new Response("{}", { status: 404 }));
    await fetchPublicKey("weird/name");
    expect(calls[0]?.url).toBe("https://edge.test/keys/weird%2Fname");
  });

  test("fetchPublicKey returns null on 404 (peer hasn't set up DMs)", async () => {
    stubFetch(new Response("not found", { status: 404 }));
    expect(await fetchPublicKey("ghost")).toBeNull();
  });

  test("fetchPublicKey returns null when the response fails validation", async () => {
    stubFetch(
      new Response(JSON.stringify({ user: "x", publicKey: "not-base64!" }), { status: 200 }),
    );
    expect(await fetchPublicKey("x")).toBeNull();
  });
});
