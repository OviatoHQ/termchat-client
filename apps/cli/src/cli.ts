#!/usr/bin/env bun
import { OnlineResponse } from "@termchat/protocol";
import { installDetected, uninstallDetected } from "./adapters.ts";
import type { InstallOptions } from "./agent-adapter.ts";
import { login, logout, whoami } from "./auth.ts";
import { openBillingLink, openDashboard } from "./billing.ts";
import { runChat } from "./chat.tsx";
import { resolveEdge } from "./config.ts";
import { runDaemon } from "./daemon.ts";
import { runDm } from "./dm.ts";
import { runHook } from "./hooks.ts";
import { renderLine } from "./line.ts";

const USAGE = `termchat — terminal presence for the AI era

usage:
  termchat chat [room]                             open the lounge chat TUI
  termchat dm setup                                publish your DM identity key
  termchat dm fingerprint <user>                   show the safety number with a user
  termchat login                                   link this terminal via GitHub
  termchat logout                                  forget the stored session
  termchat whoami                                  show the current identity
  termchat dashboard                               open your web dashboard (browser)
  termchat card                                    save a payment card (browser)
  termchat onboard                                 set up expert payouts (browser)
  termchat install [--statusline] [--edge <url>]   wire detected agents (Claude Code, Codex)
  termchat uninstall                               remove termchat's entries
  termchat daemon                                  run the presence daemon
  termchat hook <event>                            one-shot hook (used by the coding agent)
  termchat online                                  print the current presence line
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
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
    case "install": {
      // Wire every detected agent (Claude + Codex); Claude by default if none found.
      const results = installDetected(parseInstallArgs(rest));
      for (const result of results) {
        console.log(`termchat wired into ${result.agent} (${result.settingsPath})`);
        console.log(`  launcher: ${result.launcherPath}`);
        if (result.backupPath) console.log(`  backup:   ${result.backupPath}`);
        if (result.statuslineInstalled) console.log("  status line installed");
        if (result.statuslineSkippedReason)
          console.log(`  status line: ${result.statuslineSkippedReason}`);
        if (result.followUp) console.log(`  ⚠ ${result.followUp}`);
      }
      return;
    }
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
    default:
      process.stdout.write(USAGE);
  }
}

function parseInstallArgs(args: string[]): InstallOptions {
  const options: InstallOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--statusline") {
      options.statusline = true;
    } else if (arg === "--edge") {
      const value = args[i + 1];
      if (value) {
        options.edge = value;
        i += 1;
      }
    }
  }
  return options;
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
