import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeToken } from "../src/auth.ts";
import {
  clearCredentials,
  credentialsPath,
  readCredentials,
  writeCredentials,
} from "../src/config.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let home: string;
const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  if (!(key in saved)) saved[key] = process.env[key];
  process.env[key] = value;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tc-auth-"));
  setEnv("TERMCHAT_HOME", home);
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
  rmSync(home, { recursive: true, force: true });
});

function makeToken(claims: Record<string, unknown>): string {
  const b64url = (value: unknown): string =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "HS256" })}.${b64url(claims)}.signature`;
}

test("credentials round-trip and are written 0600", () => {
  expect(readCredentials()).toBeNull();
  writeCredentials({ token: "t", user: "octocat", githubLogin: "octocat" });
  expect(readCredentials()).toEqual({ token: "t", user: "octocat", githubLogin: "octocat" });
  expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  clearCredentials();
  expect(readCredentials()).toBeNull();
});

test("writeCredentials enforces 0600 even on a pre-existing looser file", () => {
  writeCredentials({ token: "t", user: "u", githubLogin: "u" });
  // Loosen, then re-write — the mode must be re-tightened.
  chmodSync(credentialsPath(), 0o644);
  writeCredentials({ token: "t2", user: "u", githubLogin: "u" });
  expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
});

test("decodeToken extracts claims without verifying", () => {
  const token = makeToken({
    sub: "octocat",
    gh: "octocat",
    ghId: "1",
    ver: true,
    iat: 0,
    exp: 9_999_999_999,
  });
  expect(decodeToken(token)?.gh).toBe("octocat");
  expect(decodeToken("not-a-token")).toBeNull();
});

test("login exchanges the pasted browser code and stores credentials", async () => {
  const token = makeToken({
    sub: "octocat",
    gh: "octocat",
    ghId: "1",
    ver: true,
    iat: 0,
    exp: 9_999_999_999,
  });
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/auth/pair/start") {
        return Response.json({
          pairingId: "pid-123",
          onboardUrl: "http://127.0.0.1/onboard?pairing=pid-123",
          expiresInSeconds: 600,
        });
      }
      if (path === "/auth/pair/exchange") {
        return Response.json({ status: "ok", token, user: "octocat", githubLogin: "octocat" });
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const proc = Bun.spawn([process.execPath, CLI, "login"], {
      env: {
        ...process.env,
        TERMCHAT_HOME: home,
        TERMCHAT_EDGE: `http://127.0.0.1:${server.port}`,
        TERMCHAT_NO_BROWSER: "1",
      },
      stdin: new TextEncoder().encode("ABCD-EF12-3456-7890\n"),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    const stored = JSON.parse(readFileSync(join(home, "credentials.json"), "utf8"));
    expect(stored.githubLogin).toBe("octocat");
    expect(stored.token).toBe(token);
  } finally {
    server.stop(true);
  }
});
