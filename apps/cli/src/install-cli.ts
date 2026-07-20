import { createInterface } from "node:readline/promises";
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

  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    for (const adapter of adapters) {
      const options: InstallOptions = { statusline: await decideStatusline(adapter, flags, rl) };
      if (flags.edge !== undefined) options.edge = flags.edge;
      report(adapter, adapter.install(options));
    }
  } finally {
    rl?.close();
  }

  if (!interactive) {
    console.log(
      "\nRun `termchat claude removestatus` (or `codex removestatus`) any time to undo the status line.",
    );
  }
}

async function decideStatusline(
  adapter: AgentAdapter,
  flags: InstallFlags,
  rl: ReturnType<typeof createInterface> | null,
): Promise<boolean> {
  // Agents without a command-backed status line (Codex) get hooks only — never prompt.
  if (!adapter.commandStatusLine) return false;
  // Non-interactive: honor an explicit flag, else default the status line ON (this
  // preserves the historical `curl … | sh --statusline` behavior for CI/pipes).
  if (!rl) return flags.statusline ?? true;
  return promptYesNo(rl, `Add the termchat status line to ${label(adapter)}?`, true);
}

async function promptYesNo(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  const answer = (await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `))
    .trim()
    .toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
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
