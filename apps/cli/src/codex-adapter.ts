import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentAdapter,
  InstallOptions,
  InstallResult,
  UninstallResult,
} from "./agent-adapter.ts";
import { writeConfiguredEdge } from "./config.ts";
import {
  type HookArg,
  backupFile,
  mergeOurHooks,
  readJsonConfig,
  stripOurHooks,
  writeJsonConfig,
  writeLauncher,
} from "./hook-merge.ts";

/**
 * Codex adapter (Phase 3B Step 2) — wires termchat into `~/.codex/hooks.json`. Codex's
 * hook config uses the same group structure as Claude's settings.json, so the merge
 * (backup-first, no-clobber, idempotent, ownership-tagged uninstall) is the SAME
 * hook-merge.ts machinery — ported, not reinvented. Differences from Claude:
 *  - target file is `~/.codex/hooks.json` (JSON), honoring the `CODEX_HOME` override;
 *  - no `SessionEnd` event (Codex lacks it — `Stop` drives idle, the daemon self-manages);
 *  - no command-backed status line (`commandStatusLine: false`) — presence surfaces via
 *    the daemon desktop notification + the termchat TUI instead;
 *  - a one-time `/hooks` trust step is required (surfaced as `followUp`).
 */
const HOOK_EVENTS: ReadonlyArray<{ event: string; arg: HookArg }> = [
  { event: "SessionStart", arg: "session-start" },
  { event: "UserPromptSubmit", arg: "prompt-submit" },
  { event: "Stop", arg: "stop" },
];

const TRUST_FOLLOWUP =
  "Run `/hooks` in Codex once to trust termchat's hooks (Codex gates newly-added hooks until trusted).";

/** Codex config dir — `CODEX_HOME` override, else `~/.codex` (the CLAUDE_CONFIG_DIR equivalent). */
function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}
function hooksPath(): string {
  return join(codexHome(), "hooks.json");
}

export const codexAdapter: AgentAdapter = {
  name: "codex",
  commandStatusLine: false,

  detect(): boolean {
    return existsSync(codexHome());
  },

  install(options: InstallOptions = {}): InstallResult {
    const path = hooksPath();
    const config = readJsonConfig(path); // {} if absent; throws on invalid JSON
    const backupPath = backupFile(path);

    const launcher = writeLauncher();
    if (options.edge) writeConfiguredEdge(options.edge);

    mergeOurHooks(config, launcher, HOOK_EVENTS); // strip-ours + append, no-clobber
    writeJsonConfig(path, config);

    return {
      agent: "codex",
      settingsPath: path,
      backupPath,
      launcherPath: launcher,
      statuslineInstalled: false,
      statuslineSkippedReason: options.statusline
        ? "Codex has no command-backed status line — presence shows via desktop notification + the termchat TUI"
        : null,
      followUp: TRUST_FOLLOWUP,
    };
  },

  uninstall(): UninstallResult {
    const path = hooksPath();
    const config = readJsonConfig(path);
    const backupPath = backupFile(path);
    stripOurHooks(config); // removes ONLY our marked groups
    writeJsonConfig(path, config);
    // The launcher is shared with the Claude adapter — the CLI removes it once, after
    // all detected agents are uninstalled, so a co-installed Claude never breaks.
    return { agent: "codex", settingsPath: path, backupPath };
  },
};
