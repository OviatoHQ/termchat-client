import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentAdapter,
  InstallOptions,
  InstallResult,
  UninstallResult,
} from "./agent-adapter.ts";
import {
  ensureHome,
  onlineLinePath,
  statuslineScriptPath,
  wrappedStatuslinePath,
  writeConfiguredEdge,
} from "./config.ts";
import {
  type HookArg,
  backupFile,
  launcherPath,
  mergeOurHooks,
  readJsonConfig,
  removeIfExists,
  shellQuote,
  stripOurHooks,
  writeJsonConfig,
  writeLauncher,
} from "./hook-merge.ts";

/**
 * Claude Code adapter — wires termchat into `~/.claude/settings.json`. The hook merge
 * (backup, no-clobber, idempotent, ownership-tagged) lives in hook-merge.ts; the
 * Claude-specific parts are the settings path and the command-backed `statusLine`.
 */
const STATUSLINE_MARKER = "TERMCHAT_STATUSLINE=1";

const HOOK_EVENTS: ReadonlyArray<{ event: string; arg: HookArg }> = [
  { event: "SessionStart", arg: "session-start" },
  { event: "UserPromptSubmit", arg: "prompt-submit" },
  { event: "Stop", arg: "stop" },
  { event: "SessionEnd", arg: "session-end" },
];

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}
function settingsPath(): string {
  return join(claudeConfigDir(), "settings.json");
}

function statuslineCommand(scriptPath: string): string {
  return `${STATUSLINE_MARKER} bash ${shellQuote(scriptPath)}`;
}
function isOurStatusLine(statusLine: unknown): boolean {
  if (typeof statusLine !== "object" || statusLine === null) return false;
  const command = (statusLine as { command?: unknown }).command;
  return typeof command === "string" && command.includes(STATUSLINE_MARKER);
}

/** The shell command a (foreign) `statusLine` runs, or null if it isn't a command
 *  status line we can compose with. */
function priorCommandOf(statusLine: unknown): string | null {
  if (typeof statusLine !== "object" || statusLine === null) return null;
  const command = (statusLine as { command?: unknown }).command;
  return typeof command === "string" && command.length > 0 ? command : null;
}

/** Read the sidecar-stored original `statusLine` (what was there before we wrapped),
 *  or null if we've never wrapped. */
function readWrappedOriginal(): Record<string, unknown> | null {
  const path = wrappedStatuslinePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Write the termchat status-line script. When `priorCommand` is null this is a pure
 * `cat` of the local presence line — no network, no subprocess beyond cat, so it can
 * never block the bar. When a foreign status line was present at install time we
 * ALSO run that pre-existing command (exactly as Claude Code would have, forwarding
 * the same per-render JSON on stdin) and append presence on the same line. termchat's
 * own contribution stays a network-free file read; the wrapped command is the user's
 * own and is run as-is, so we never introduce blocking or a network call of our own.
 */
function writeStatuslineScript(priorCommand: string | null): string {
  ensureHome();
  const scriptPath = statuslineScriptPath();
  const online = shellQuote(onlineLinePath());
  const script = priorCommand
    ? `#!/usr/bin/env bash
# termchat status line (generated — do not edit). Appends termchat presence to the
# status line that was already configured when termchat was installed. termchat's own
# part is a pure local file read; the wrapped command below is the user's own, run
# exactly as the agent would have (same stdin JSON), so termchat adds no network call
# and no blocking of its own. See PRD §6.3.
input=$(cat)
prior=$(printf '%s' "$input" | ( ${priorCommand} ) 2>/dev/null)
online=$(cat ${online} 2>/dev/null || true)
if [ -n "$prior" ] && [ -n "$online" ]; then
  printf '%s  %s\\n' "$prior" "$online"
elif [ -n "$prior" ]; then
  printf '%s\\n' "$prior"
elif [ -n "$online" ]; then
  printf '%s\\n' "$online"
fi
`
    : `#!/usr/bin/env bash
# termchat status line (generated — do not edit). Pure local file read; no
# sockets, no subprocess beyond cat, so it can never block the bar (PRD §6.3).
cat ${online} 2>/dev/null || true
`;
  writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

export const claudeAdapter: AgentAdapter = {
  name: "claude",
  commandStatusLine: true,

  detect(): boolean {
    return existsSync(claudeConfigDir());
  },

  install(options: InstallOptions = {}): InstallResult {
    const path = settingsPath();
    const settings = readJsonConfig(path);
    const backupPath = backupFile(path);

    const launcher = writeLauncher();
    if (options.edge) writeConfiguredEdge(options.edge);

    mergeOurHooks(settings, launcher, HOOK_EVENTS);

    let statuslineInstalled = false;
    let statuslineAppended = false;
    const statuslineSkippedReason: string | null = null;
    if (options.statusline) {
      // Determine the ORIGINAL status line to compose with. If the current one is
      // ours (re-install), the original lives in the sidecar — read it there so we
      // never wrap our own wrapper. If it's foreign, that's the original: persist it.
      // Otherwise there is none.
      let original: Record<string, unknown> | null;
      if (isOurStatusLine(settings.statusLine)) {
        original = readWrappedOriginal();
      } else if (settings.statusLine) {
        original = settings.statusLine as Record<string, unknown>;
        ensureHome();
        writeFileSync(wrappedStatuslinePath(), `${JSON.stringify(original, null, 2)}\n`);
      } else {
        original = null;
      }

      const priorCommand = priorCommandOf(original);
      const scriptPath = writeStatuslineScript(priorCommand);
      settings.statusLine = {
        ...(original ?? {}),
        type: "command",
        command: statuslineCommand(scriptPath),
        padding: 0,
        refreshInterval: 3,
      };
      statuslineInstalled = true;
      statuslineAppended = priorCommand !== null;
    } else {
      // Keep the generated script in sync even when not (re)wiring the setting.
      writeStatuslineScript(priorCommandOf(readWrappedOriginal()));
    }

    writeJsonConfig(path, settings);
    return {
      agent: "claude",
      settingsPath: path,
      backupPath,
      launcherPath: launcher,
      statuslineInstalled,
      statuslineAppended,
      statuslineSkippedReason,
      followUp: null,
    };
  },

  uninstall(): UninstallResult {
    const path = settingsPath();
    const settings = readJsonConfig(path);
    const backupPath = backupFile(path);

    stripOurHooks(settings);
    // Only touch the status line if it's still ours (don't clobber a hand-edit made
    // since install). Restore the original we wrapped, if any; else remove it.
    if (isOurStatusLine(settings.statusLine)) {
      const original = readWrappedOriginal();
      if (original) {
        settings.statusLine = original;
      } else {
        delete settings.statusLine;
      }
    }
    writeJsonConfig(path, settings);

    removeIfExists(launcherPath());
    removeIfExists(statuslineScriptPath());
    removeIfExists(wrappedStatuslinePath());
    return { agent: "claude", settingsPath: path, backupPath };
  },
};
