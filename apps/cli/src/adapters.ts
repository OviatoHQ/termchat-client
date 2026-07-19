import type {
  AgentAdapter,
  InstallOptions,
  InstallResult,
  UninstallResult,
} from "./agent-adapter.ts";
import { claudeAdapter } from "./claude-adapter.ts";
import { codexAdapter } from "./codex-adapter.ts";
import { launcherPath, removeIfExists } from "./hook-merge.ts";

/**
 * Multi-agent resolution (Phase 3B Step 2). `install`/`uninstall` in installer.ts stay
 * Claude-specific (the unchanged test path); the CLI uses these to wire EVERY agent the
 * machine has. Claude is the default/primary when none is detected (a fresh machine
 * still gets termchat wired into Claude Code).
 */
export const ALL_ADAPTERS: readonly AgentAdapter[] = [claudeAdapter, codexAdapter];

/** Adapters whose config dir exists; Claude as the default when none is present. */
export function detectAdapters(): AgentAdapter[] {
  const present = ALL_ADAPTERS.filter((adapter) => adapter.detect());
  return present.length > 0 ? present : [claudeAdapter];
}

export function installDetected(options: InstallOptions = {}): InstallResult[] {
  return detectAdapters().map((adapter) => adapter.install(options));
}

export function uninstallDetected(): UninstallResult[] {
  const results = detectAdapters().map((adapter) => adapter.uninstall());
  // The launcher is shared across agents — remove it once, after every detected agent
  // has been uninstalled, so a co-installed agent is never left with a dead launcher.
  removeIfExists(launcherPath());
  return results;
}
