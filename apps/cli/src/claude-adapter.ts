import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentAdapter,
  InstallOptions,
  InstallResult,
  UninstallResult,
} from "./agent-adapter.ts";
import { ensureHome, onlineLinePath, statuslineScriptPath, writeConfiguredEdge } from "./config.ts";
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

function writeStatuslineScript(): string {
  ensureHome();
  const scriptPath = statuslineScriptPath();
  const script = `#!/usr/bin/env bash
# termchat status line (generated — do not edit). Pure local file read; no
# sockets, no subprocess beyond cat, so it can never block the bar (PRD §6.3).
cat ${shellQuote(onlineLinePath())} 2>/dev/null || true
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
    const scriptPath = writeStatuslineScript();
    if (options.edge) writeConfiguredEdge(options.edge);

    mergeOurHooks(settings, launcher, HOOK_EVENTS);

    let statuslineInstalled = false;
    let statuslineSkippedReason: string | null = null;
    if (options.statusline) {
      if (settings.statusLine && !isOurStatusLine(settings.statusLine)) {
        statuslineSkippedReason = "an existing statusLine is present — left untouched";
      } else {
        settings.statusLine = {
          type: "command",
          command: statuslineCommand(scriptPath),
          padding: 0,
          refreshInterval: 3,
        };
        statuslineInstalled = true;
      }
    }

    writeJsonConfig(path, settings);
    return {
      agent: "claude",
      settingsPath: path,
      backupPath,
      launcherPath: launcher,
      statuslineInstalled,
      statuslineSkippedReason,
      followUp: null,
    };
  },

  uninstall(): UninstallResult {
    const path = settingsPath();
    const settings = readJsonConfig(path);
    const backupPath = backupFile(path);

    stripOurHooks(settings);
    if (isOurStatusLine(settings.statusLine)) delete settings.statusLine;
    writeJsonConfig(path, settings);

    removeIfExists(launcherPath());
    removeIfExists(statuslineScriptPath());
    return { agent: "claude", settingsPath: path, backupPath };
  },
};
