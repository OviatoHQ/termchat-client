#!/usr/bin/env bun
import { OnlineResponse } from "@termchat/protocol";
import { removeStatusFor, uninstallDetected } from "./adapters.ts";
import { login, logout, whoami } from "./auth.ts";
import { openBillingLink, openDashboard } from "./billing.ts";
import { runChat } from "./chat.tsx";
import { resolveEdge } from "./config.ts";
import { runDaemon } from "./daemon.ts";
import { runDm } from "./dm.ts";
import { runHook } from "./hooks.ts";
import { runInstall } from "./install-cli.ts";
import { renderLine } from "./line.ts";
import { VERSION } from "./version.ts";

const USAGE = `termchat — terminal presence for the AI era

usage:
  termchat                                         open the lounge chat TUI (default)
  termchat chat [room]                             open the lounge chat TUI in a room
  termchat dm setup                                publish your DM identity key
  termchat dm fingerprint <user>                   show the safety number with a user
  termchat login                                   link this terminal via GitHub
  termchat logout                                  forget the stored session
  termchat whoami                                  show the current identity
  termchat dashboard                               open your web dashboard (browser)
  termchat card                                    save a payment card (browser)
  termchat onboard                                 set up expert payouts (browser)
  termchat install [--yes] [--edge <url>]          wire detected agents (asks to add the status line)
  termchat uninstall                               remove termchat's entries
  termchat claude removestatus                     remove the termchat status line from Claude Code
  termchat codex removestatus                      remove termchat's hooks from Codex
  termchat daemon                                  run the presence daemon
  termchat hook <event>                            one-shot hook (used by the coding agent)
  termchat online                                  print the current presence line
  termchat version                                 print the client version
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    // Bare `termchat` (no subcommand) opens the lounge chat — the primary thing.
    case undefined:
    case "chat":
      await runChat(rest[0]);
      return;
    case "dm":
      await runDm(rest);
      return;
    case "login":
      await login();
      return;
    case "logout":
      logout();
      return;
    case "whoami":
      await whoami();
      return;
    case "dashboard":
      await openDashboard();
      return;
    case "card":
      await openBillingLink("card");
      return;
    case "onboard":
      await openBillingLink("onboard");
      return;
    case "daemon":
      await runDaemon();
      return;
    case "hook":
      await runHook(rest[0]);
      return;
    case "install":
      // Wire every detected agent (Claude + Codex); Claude by default if none found.
      // Prompts, one agent at a time, before adding a status line (see install-cli.ts).
      await runInstall(rest);
      return;
    case "claude":
    case "codex":
      runAgentStatus(command, rest);
      return;
    case "uninstall": {
      const results = uninstallDetected();
      for (const result of results) {
        console.log(`termchat removed from ${result.agent} (${result.settingsPath})`);
        if (result.backupPath) console.log(`  backup: ${result.backupPath}`);
      }
      return;
    }
    case "online":
      await printOnline();
      return;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    case "version":
    case "--version":
    case "-v":
      console.log(`termchat ${VERSION}`);
      return;
    default:
      // Unknown subcommand — show usage (and flag it so a typo isn't silent).
      process.stderr.write(`termchat: unknown command '${command}'\n\n`);
      process.stdout.write(USAGE);
      process.exitCode = 1;
  }
}

/** `termchat claude|codex removestatus` — stop showing termchat in one agent. */
function runAgentStatus(agent: "claude" | "codex", rest: string[]): void {
  if (rest[0] !== "removestatus") {
    process.stderr.write(`usage: termchat ${agent} removestatus\n`);
    process.exitCode = 1;
    return;
  }
  const result = removeStatusFor(agent);
  console.log(result.message);
  if (result.removed) {
    console.log(`  ${result.settingsPath}`);
    if (result.backupPath) console.log(`  backup: ${result.backupPath}`);
  }
}

async function printOnline(): Promise<void> {
  const { httpBase } = resolveEdge();
  try {
    const res = await fetch(`${httpBase}/online`, { signal: AbortSignal.timeout(2_000) });
    const parsed = OnlineResponse.safeParse(await res.json());
    if (parsed.success) {
      console.log(renderLine(parsed.data, false));
      return;
    }
  } catch {
    // fall through
  }
  console.log("termchat: offline");
}

// Exit explicitly once a command finishes. Some commands (e.g. `login`) leave
// stdin open, which keeps Bun's event loop alive and hangs the process after the
// work is done. Long-running commands (`chat`, `daemon`) only resolve when they're
// actually finished, so exiting here is correct for them too.
main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
