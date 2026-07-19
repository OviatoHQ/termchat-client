import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAdapters, installDetected, uninstallDetected } from "../src/adapters.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};
function setEnv(key: string, value: string): void {
  if (!(key in saved)) saved[key] = process.env[key];
  process.env[key] = value;
}
const names = (): string[] =>
  detectAdapters()
    .map((a) => a.name)
    .sort();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tc-adapters-"));
  setEnv("CLAUDE_CONFIG_DIR", join(tmp, "claude"));
  setEnv("CODEX_HOME", join(tmp, "codex"));
  setEnv("TERMCHAT_HOME", join(tmp, "home"));
  setEnv("TERMCHAT_BIN_DIR", join(tmp, "bin"));
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

test("detect: none present → defaults to Claude (a fresh machine still wires Claude)", () => {
  expect(names()).toEqual(["claude"]);
});

test("detect: only Codex present → Codex", () => {
  mkdirSync(join(tmp, "codex"), { recursive: true });
  expect(names()).toEqual(["codex"]);
});

test("detect: both present → both adapters", () => {
  mkdirSync(join(tmp, "claude"), { recursive: true });
  mkdirSync(join(tmp, "codex"), { recursive: true });
  expect(names()).toEqual(["claude", "codex"]);
});

test("installDetected wires every present agent; uninstallDetected removes them + the shared launcher", () => {
  mkdirSync(join(tmp, "claude"), { recursive: true });
  mkdirSync(join(tmp, "codex"), { recursive: true });

  const results = installDetected();
  expect(results.map((r) => r.agent).sort()).toEqual(["claude", "codex"]);
  // Both agent configs written, plus the shared launcher.
  expect(existsSync(join(tmp, "claude", "settings.json"))).toBe(true);
  expect(existsSync(join(tmp, "codex", "hooks.json"))).toBe(true);
  const launcher = results[0]?.launcherPath ?? "";
  expect(existsSync(launcher)).toBe(true);

  const removed = uninstallDetected();
  expect(removed.map((r) => r.agent).sort()).toEqual(["claude", "codex"]);
  // Neither config still carries a termchat hook, and the shared launcher is gone.
  const claude = readFileSync(join(tmp, "claude", "settings.json"), "utf8");
  const codex = readFileSync(join(tmp, "codex", "hooks.json"), "utf8");
  expect(claude).not.toContain("TERMCHAT_HOOK=1");
  expect(codex).not.toContain("TERMCHAT_HOOK=1");
  expect(existsSync(launcher)).toBe(false);
});
