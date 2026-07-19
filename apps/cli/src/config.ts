import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StoredCredentials } from "@termchat/protocol";

/**
 * Local state directory. Honors `TERMCHAT_HOME` (used by tests and by users who
 * relocate state); defaults to `~/.termchat`.
 */
export function termchatHome(): string {
  return process.env.TERMCHAT_HOME ?? join(homedir(), ".termchat");
}

export function ensureHome(): string {
  const dir = termchatHome();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function onlineLinePath(): string {
  return join(termchatHome(), "online.line");
}

export function clientIdPath(): string {
  return join(termchatHome(), "client-id");
}

export function pidPath(): string {
  return join(termchatHome(), "daemon.pid");
}

export function configFilePath(): string {
  return join(termchatHome(), "config.json");
}

export function statuslineScriptPath(): string {
  return join(termchatHome(), "statusline.sh");
}

/** Sidecar holding the agent's ORIGINAL `statusLine` object (verbatim) when termchat
 *  wraps it to append presence. Read on re-install (so we never wrap our own wrapper)
 *  and on uninstall (to restore exactly what was there before). */
export function wrappedStatuslinePath(): string {
  return join(termchatHome(), "wrapped-statusline.json");
}

export function credentialsPath(): string {
  return join(termchatHome(), "credentials.json");
}

/** Read the stored session credentials, or null if absent/invalid. */
export function readCredentials(): StoredCredentials | null {
  const path = credentialsPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = StoredCredentials.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeCredentials(credentials: StoredCredentials): void {
  ensureHome();
  const path = credentialsPath();
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies on create; enforce 0600 on an existing (possibly looser) file.
  chmodSync(path, 0o600);
}

export function clearCredentials(): void {
  try {
    if (existsSync(credentialsPath())) rmSync(credentialsPath());
  } catch {
    // best effort
  }
}

/**
 * Stable per-machine client id. Created once and reused by both the daemon
 * (which opens the WebSocket) and the hooks (which POST state for it), so the
 * two are decoupled and order-independent.
 */
export function getOrCreateClientId(): string {
  ensureHome();
  const path = clientIdPath();
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  }
  const id = randomUUID();
  writeFileSync(path, `${id}\n`, { mode: 0o600 });
  return id;
}

export interface EdgeEndpoints {
  httpBase: string;
  wsBase: string;
}

/**
 * Resolve the edge base URL. Precedence: `TERMCHAT_EDGE` env → `config.json` →
 * the production default. Returns both http(s) and ws(s) forms. For local dev
 * against `wrangler dev`, set `TERMCHAT_EDGE=http://127.0.0.1:8787` (or your port).
 */
export function resolveEdge(): EdgeEndpoints {
  const base = process.env.TERMCHAT_EDGE?.trim() || readConfiguredEdge() || "https://termchat.sh";
  const httpBase = base.replace(/^ws(s?):\/\//i, "http$1://").replace(/\/+$/, "");
  const wsBase = httpBase.replace(/^http(s?):\/\//i, "ws$1://");
  return { httpBase, wsBase };
}

function readConfiguredEdge(): string | undefined {
  const path = configFilePath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { edge?: unknown };
    return typeof parsed.edge === "string" ? parsed.edge : undefined;
  } catch {
    return undefined;
  }
}

export function writeConfiguredEdge(edge: string): void {
  ensureHome();
  writeFileSync(configFilePath(), `${JSON.stringify({ edge }, null, 2)}\n`);
}
