import type { InstallOptions, InstallResult, UninstallResult } from "./agent-adapter.ts";
import { claudeAdapter } from "./claude-adapter.ts";

/**
 * Install facade. The per-agent wiring lives in AgentAdapters (Phase 3B); these
 * thin wrappers preserve the original Claude-Code entry points. `install`/`uninstall`
 * target Claude Code specifically — multi-agent selection (`detect`) is layered on in
 * the CLI without changing this behavior, so the existing Claude path is unchanged.
 */
export type { InstallOptions, InstallResult, UninstallResult };

export function install(options: InstallOptions = {}): InstallResult {
  return claudeAdapter.install(options);
}

export function uninstall(): UninstallResult {
  return claudeAdapter.uninstall();
}
