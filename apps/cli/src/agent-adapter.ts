/**
 * Cross-agent install seam (Phase 3B). termchat integrates with a coding agent via
 * (1) lifecycle hooks that flip presence busy/idle + spawn the daemon, and
 * (2) optionally an ambient status line. Those wiring details differ per agent
 * (Claude Code: `~/.claude/settings.json`; Codex: `~/.codex/hooks.json`), so each
 * agent gets an `AgentAdapter`. Everything else — the daemon, `hooks.ts` (its event
 * args + stdin contract are identical across agents), the TUI, and the entire edge —
 * is agent-neutral. This seam touches NO edge/money code.
 */

export interface InstallOptions {
  /** Also install the ambient status line (only where the agent supports a
   *  command-backed status line; ignored when `commandStatusLine` is false). */
  statusline?: boolean;
  /** Override the edge base URL written to `~/.termchat/config.json`. */
  edge?: string;
}

export interface InstallResult {
  /** Which agent this install targeted ("claude" | "codex"). */
  agent: string;
  /** The agent config file we merged into. */
  settingsPath: string;
  backupPath: string | null;
  launcherPath: string;
  statuslineInstalled: boolean;
  /** True when our status line was composed on top of a pre-existing one (presence
   *  appended) rather than installed fresh. */
  statuslineAppended: boolean;
  /** Why the status line was not installed (e.g. the agent has no command-backed
   *  status line to inject into). */
  statuslineSkippedReason: string | null;
  /** A one-time manual step the user must take to activate the install, if any
   *  (e.g. Codex requires `/hooks` to trust a newly-added hook). */
  followUp: string | null;
}

export interface UninstallResult {
  agent: string;
  settingsPath: string;
  backupPath: string | null;
}

export interface AgentAdapter {
  /** Stable agent id, used in reporting + `detect` selection. */
  readonly name: string;
  /** True iff the agent supports a command-backed status line we can inject our
   *  `cat online.line` string into (Claude: yes; Codex: no). */
  readonly commandStatusLine: boolean;
  /** Is this agent present on the machine (its config dir exists)? */
  detect(): boolean;
  /** Merge termchat's hooks (+ optional status line) into the agent's config. */
  install(options?: InstallOptions): InstallResult;
  /** Remove ONLY termchat's entries from the agent's config. */
  uninstall(): UninstallResult;
}
