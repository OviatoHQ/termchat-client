import { detectAdapters } from "./adapters.ts";
import type { AgentAdapter, InstallOptions } from "./agent-adapter.ts";
import { printBanner } from "./banner.ts";

/**
 * `termchat install` — wires termchat into every detected coding agent. Presence
 * HOOKS always install (they're what makes termchat work); the ambient STATUS LINE is
 * opt-in and asked one agent at a time, but only for agents that actually support a
 * command-backed status line (Claude Code — not Codex). Under `curl … | sh` the shell
 * shim reattaches stdin to /dev/tty so this can prompt; when there's no TTY (CI, pipes)
 * or `--yes`/`--statusline`/`--no-statusline` is passed, it runs non-interactively.
 */
export interface InstallFlags {
  edge?: string;
  /** Explicit status-line choice; `undefined` means "ask (or default on if non-interactive)". */
  statusline?: boolean;
  /** Assume the default answer for every prompt (non-interactive). */
  yes?: boolean;
}

const AGENT_LABEL: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

function label(adapter: AgentAdapter): string {
  return AGENT_LABEL[adapter.name] ?? adapter.name;
}

export function parseInstallArgs(args: string[]): InstallFlags {
  const flags: InstallFlags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--statusline") {
      flags.statusline = true;
    } else if (arg === "--no-statusline") {
      flags.statusline = false;
    } else if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
    } else if (arg === "--edge") {
      const value = args[i + 1];
      if (value) {
        flags.edge = value;
        i += 1;
      }
    }
  }
  return flags;
}

export async function runInstall(args: string[]): Promise<void> {
  const flags = parseInstallArgs(args);
  printBanner();

  const adapters = detectAdapters();
  // Prompt only when we have a real terminal AND the caller left the choice open.
  const interactive =
    process.stdin.isTTY === true && flags.yes !== true && flags.statusline === undefined;

  for (const adapter of adapters) {
    const options: InstallOptions = {
      statusline: decideStatusline(adapter, flags, interactive),
    };
    if (flags.edge !== undefined) options.edge = flags.edge;
    report(adapter, adapter.install(options));
  }

  if (!interactive) {
    console.log(
      "\nRun `termchat claude removestatus` (or `codex removestatus`) any time to undo the status line.",
    );
  }
}

function decideStatusline(
  adapter: AgentAdapter,
  flags: InstallFlags,
  interactive: boolean,
): boolean {
  // Agents without a command-backed status line (Codex) get hooks only — never prompt.
  if (!adapter.commandStatusLine) return false;
  // Non-interactive: honor an explicit flag, else default the status line ON (this
  // preserves the historical `curl … | sh --statusline` behavior for CI/pipes).
  if (!interactive) return flags.statusline ?? true;
  return promptYesNo(`Add the termchat status line to ${label(adapter)}?`, true);
}

function promptYesNo(question: string, defaultYes: boolean): boolean {
  process.stdout.write(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `);
  const answer = readTtyLine().trim().toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

/**
 * Read one line from the controlling terminal by delegating to the shell's `read`
 * builtin against `/dev/tty` — the one tty-read primitive that works everywhere.
 *
 * Bun's own stdin stream silently dropped terminal input on a `/dev/tty` reopened
 * from inside a piped `curl … | sh` shell (both `readline`'s raw mode and a plain
 * `data` listener failed live), so we never let Bun touch the terminal for the read:
 * `/bin/sh` does it, and Bun only captures its stdout. If there is no readable tty
 * (no controlling terminal, EOF, spawn failure) this returns "" and the caller falls
 * back to its default — so the prompt degrades to the default and can never hang.
 */
function readTtyLine(): string {
  try {
    const proc = Bun.spawnSync(["sh", "-c", 'IFS= read -r reply </dev/tty; printf %s "$reply"']);
    if (!proc.success) return "";
    return proc.stdout.toString();
  } catch {
    return "";
  }
}

function report(adapter: AgentAdapter, result: ReturnType<AgentAdapter["install"]>): void {
  console.log(`\n▸ ${label(adapter)}`);
  console.log(`  wired into ${result.settingsPath}`);
  if (result.backupPath) console.log(`  backup:   ${result.backupPath}`);
  if (result.statuslineInstalled)
    console.log(
      result.statuslineAppended
        ? "  status line: presence appended to your existing one"
        : "  status line: installed",
    );
  if (result.statuslineSkippedReason)
    console.log(`  status line: ${result.statuslineSkippedReason}`);
  if (!adapter.commandStatusLine)
    console.log("  status line: not supported here — presence shows via notifications + the TUI");
  if (result.followUp) console.log(`  ⚠ ${result.followUp}`);
}
