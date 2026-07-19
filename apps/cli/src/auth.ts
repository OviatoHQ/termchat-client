import {
  PairExchangeResponse,
  PairStartResponse,
  SessionClaims,
  type StoredCredentials,
} from "@termchat/protocol";
import { clearCredentials, readCredentials, resolveEdge, writeCredentials } from "./config.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Open a URL in the user's browser (best effort; skipped when headless). */
function openUrl(url: string): void {
  if (process.env.TERMCHAT_NO_BROWSER === "1") return;
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    Bun.spawn([command, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // The URL is printed regardless, so the user can open it manually.
  }
}

/** Yield trimmed lines from stdin (works for both TTY and piped input). */
async function* stdinLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      yield buffer.slice(0, newline).replace(/\r$/, "").trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

/**
 * Start the pairing flow: ask the edge for a pairing id + onboarding URL and open
 * the browser. Returns the pairing handle (or null if the edge is unreachable).
 * Reused by both the CLI `login` command and the in-TUI `/login`.
 */
export async function beginLogin(): Promise<PairStartResponse | null> {
  const { httpBase } = resolveEdge();
  try {
    const res = await fetch(`${httpBase}/auth/pair/start`, { method: "POST" });
    const parsed = PairStartResponse.safeParse(await res.json());
    if (!parsed.success) return null;
    openUrl(parsed.data.onboardUrl);
    return parsed.data;
  } catch {
    return null;
  }
}

export type LoginOutcome =
  | { ok: true; credentials: StoredCredentials }
  | { ok: false; reason: "invalid" | "expired" | "pending" | "unreachable" };

/**
 * Exchange a pasted one-time code for credentials. Tolerates "pending" (the
 * browser sign-in hasn't finished) by polling briefly. Does NOT persist — the
 * caller decides when to `writeCredentials`. Reused by CLI + TUI login.
 */
export async function submitLoginCode(pairingId: string, code: string): Promise<LoginOutcome> {
  const { httpBase } = resolveEdge();
  for (let wait = 0; wait < 20; wait += 1) {
    const result = await exchange(httpBase, pairingId, code);
    if (!result) {
      await sleep(500);
      continue;
    }
    if (result.status === "ok") {
      return {
        ok: true,
        credentials: { token: result.token, user: result.user, githubLogin: result.githubLogin },
      };
    }
    if (result.status === "pending") {
      await sleep(1_000);
      continue;
    }
    if (result.status === "invalid") return { ok: false, reason: "invalid" };
    return { ok: false, reason: "expired" };
  }
  return { ok: false, reason: "pending" };
}

/**
 * Browser-onboarding login: open the page, then read the one-time code the user
 * pastes from their browser and exchange it for a session token.
 */
export async function login(): Promise<void> {
  const start = await beginLogin();
  if (!start) {
    console.error("login failed: could not reach the termchat edge.");
    process.exitCode = 1;
    return;
  }

  console.log(`\n  Opening ${start.onboardUrl}`);
  console.log("  Sign in with GitHub, then paste the one-time code shown in your browser.\n");

  const lines = stdinLines();
  let credentials: StoredCredentials | null = null;

  for (let attempt = 0; attempt < 3 && !credentials; attempt += 1) {
    process.stdout.write("  Paste code: ");
    const next = await lines.next();
    if (next.done || !next.value) break;

    const outcome = await submitLoginCode(start.pairingId, next.value);
    if (outcome.ok) {
      credentials = outcome.credentials;
    } else if (outcome.reason === "invalid" || outcome.reason === "pending") {
      console.log("  That code didn't match (or sign-in isn't finished) — try again.");
    } else {
      console.error("  This login expired. Re-run `termchat login`.");
      process.exitCode = 1;
      return;
    }
  }

  if (!credentials) {
    console.error("login was not completed.");
    process.exitCode = 1;
    return;
  }
  writeCredentials(credentials);
  console.log(`Logged in as ${credentials.githubLogin}.`);
}

async function exchange(
  httpBase: string,
  pairingId: string,
  code: string,
): Promise<PairExchangeResponse | null> {
  try {
    const res = await fetch(`${httpBase}/auth/pair/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingId, code }),
    });
    const parsed = PairExchangeResponse.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function logout(): void {
  clearCredentials();
  console.log("Logged out.");
}

export async function whoami(): Promise<void> {
  const credentials = readCredentials();
  if (!credentials) {
    console.log("Not logged in. Run `termchat login`.");
    return;
  }
  // Prefer a server-side confirmation; fall back to a local token decode offline.
  const { httpBase } = resolveEdge();
  try {
    const res = await fetch(`${httpBase}/auth/me`, {
      headers: { authorization: `Bearer ${credentials.token}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (res.ok) {
      const me = (await res.json()) as { githubLogin?: string; verified?: boolean };
      console.log(`Logged in as ${me.githubLogin} (verified: ${me.verified === true}).`);
      return;
    }
    if (res.status === 401) {
      console.log("Session expired. Run `termchat login`.");
      return;
    }
  } catch {
    // offline — fall through to local decode
  }
  const claims = decodeToken(credentials.token);
  console.log(`Logged in as ${claims?.gh ?? credentials.githubLogin} (offline).`);
}

/** Decode (without verifying) the claims of a session token, for display. */
export function decodeToken(token: string): SessionClaims | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const parsed = SessionClaims.safeParse(JSON.parse(atob(padded)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
