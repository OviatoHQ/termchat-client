import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Shared, agent-neutral install primitives (Phase 3B). Both the Claude and Codex
 * adapters merge termchat's command hooks into a JSON config that uses the SAME group
 * structure (`{ hooks: { Event: [{ matcher?, hooks: [{type:"command", command}] }] } }`).
 * The merge is ownership-marker tagged so a re-install replaces only our entries and an
 * uninstall removes ONLY ours — a user's own hooks are never touched. Ported once here
 * so the safety properties (backup, no-clobber, idempotent, clean uninstall) are
 * single-sourced rather than reimplemented per agent.
 */
export const HOOK_MARKER = "TERMCHAT_HOOK=1";

export interface HookCommand {
  type: "command";
  command: string;
}
export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
export interface HookConfig {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

export type HookArg = "session-start" | "prompt-submit" | "stop" | "session-end";

/** POSIX single-quote: nothing inside is expanded; embedded quotes escaped. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function hookCommand(launcher: string, arg: HookArg): string {
  return `${HOOK_MARKER} ${shellQuote(launcher)} hook ${arg}`;
}

export function isOurHookGroup(group: unknown): boolean {
  if (typeof group !== "object" || group === null) return false;
  const hooks = (group as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) => {
    if (typeof hook !== "object" || hook === null) return false;
    const command = (hook as { command?: unknown }).command;
    return typeof command === "string" && command.includes(HOOK_MARKER);
  });
}

/** Remove only our hook groups from every event (idempotent install / uninstall). */
export function stripOurHooks(config: HookConfig): void {
  const hooks = config.hooks;
  if (!hooks) return;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((group) => !isOurHookGroup(group));
    if (kept.length > 0) {
      hooks[event] = kept;
    } else {
      delete hooks[event];
    }
  }
  if (Object.keys(hooks).length === 0) delete config.hooks;
}

/** Strip any prior termchat hooks, then append a fresh group per event. */
export function mergeOurHooks(
  config: HookConfig,
  launcher: string,
  events: ReadonlyArray<{ event: string; arg: HookArg }>,
): void {
  stripOurHooks(config);
  const hooks: Record<string, HookGroup[]> = config.hooks ?? {};
  config.hooks = hooks;
  for (const { event, arg } of events) {
    const groups = hooks[event] ?? [];
    groups.push({ hooks: [{ type: "command", command: hookCommand(launcher, arg) }] });
    hooks[event] = groups;
  }
}

/** Read a JSON object config (`{}` when absent/empty); throw on invalid/non-object
 *  so we never silently overwrite a file we can't safely merge. */
export function readJsonConfig(path: string): HookConfig {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON — refusing to modify it (fix or move it first).`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object — refusing to modify it.`);
  }
  return parsed as HookConfig;
}

export function backupFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.termchat-bak-${stamp}`;
  copyFileSync(path, backup);
  return backup;
}

export function writeJsonConfig(path: string, config: HookConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function binDir(): string {
  return process.env.TERMCHAT_BIN_DIR ?? join(homedir(), ".local", "bin");
}
export function launcherPath(): string {
  return join(binDir(), "termchat");
}

/** Write the shared launcher (execs the Bun CLI by absolute path — hook shells run
 *  with a minimal PATH, PRD §9). Agent-neutral; both adapters reference it. */
export function writeLauncher(): string {
  const dir = binDir();
  mkdirSync(dir, { recursive: true });
  const launcher = join(dir, "termchat");
  const cliEntry = join(import.meta.dir, "cli.ts");
  const script = `#!/usr/bin/env bash
# termchat launcher (generated — do not edit). Execs the Bun CLI by absolute
# path because hook shells run with a minimal PATH (PRD §9).
exec ${shellQuote(process.execPath)} ${shellQuote(cliEntry)} "$@"
`;
  writeFileSync(launcher, script, { mode: 0o755 });
  return launcher;
}

export function removeIfExists(path: string): void {
  try {
    if (existsSync(path)) rmSync(path);
  } catch {
    // best effort
  }
}
