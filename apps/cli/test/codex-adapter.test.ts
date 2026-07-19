import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAdapter } from "../src/codex-adapter.ts";

type HookGroup = { hooks: Array<{ command: string }> };
type Config = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

let tmp: string;
let codexHome: string;
const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  if (!(key in saved)) saved[key] = process.env[key];
  process.env[key] = value;
}
const hooksPath = (): string => join(codexHome, "hooks.json");
function readConfig(): Config {
  return JSON.parse(readFileSync(hooksPath(), "utf8")) as Config;
}
function commandsFor(config: Config, event: string): string[] {
  return (config.hooks?.[event] ?? []).map((g) => g.hooks[0]?.command ?? "");
}
function seed(value: unknown): void {
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(hooksPath(), JSON.stringify(value, null, 2));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tc-codex-"));
  codexHome = join(tmp, "codex");
  setEnv("CODEX_HOME", codexHome);
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

test("install wires the three Codex hook events (no SessionEnd) into hooks.json", () => {
  const result = codexAdapter.install();
  const config = readConfig();
  expect(Object.keys(config.hooks ?? {}).sort()).toEqual([
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
  ]);
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
    expect(commandsFor(config, event).some((c) => c.includes("TERMCHAT_HOOK=1"))).toBe(true);
  }
  expect(existsSync(result.launcherPath)).toBe(true);
  expect(result.agent).toBe("codex");
});

test("CODEX_HOME override targets ~/.codex/hooks.json (the config-dir override)", () => {
  const result = codexAdapter.install();
  expect(result.settingsPath).toBe(hooksPath());
});

test("install surfaces the one-time /hooks trust follow-up and skips the status line", () => {
  const result = codexAdapter.install({ statusline: true });
  expect(result.statuslineInstalled).toBe(false);
  expect(result.statuslineSkippedReason).toContain("no command-backed status line");
  expect(result.followUp).toContain("/hooks");
  expect(codexAdapter.commandStatusLine).toBe(false);
});

test("install preserves the user's existing Codex hooks (no-clobber)", () => {
  seed({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo mine" }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "echo pre" }] }],
    },
    model: "gpt-5",
  });
  codexAdapter.install();
  const config = readConfig();
  expect(commandsFor(config, "UserPromptSubmit")).toContain("echo mine");
  expect(commandsFor(config, "UserPromptSubmit").some((c) => c.includes("TERMCHAT_HOOK=1"))).toBe(
    true,
  );
  expect(commandsFor(config, "PreToolUse")).toEqual(["echo pre"]); // untouched
  expect(config.model).toBe("gpt-5"); // foreign keys preserved
});

test("re-running install is idempotent (one termchat group per event)", () => {
  codexAdapter.install();
  codexAdapter.install();
  const config = readConfig();
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
    expect(commandsFor(config, event).filter((c) => c.includes("TERMCHAT_HOOK=1"))).toHaveLength(1);
  }
});

test("install backs up an existing hooks.json", () => {
  seed({ hooks: {} });
  const result = codexAdapter.install();
  expect(result.backupPath).not.toBeNull();
  if (result.backupPath) expect(existsSync(result.backupPath)).toBe(true);
});

test("install refuses to touch invalid JSON", () => {
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(hooksPath(), "{ not json ");
  expect(() => codexAdapter.install()).toThrow();
});

test("uninstall removes termchat entries but keeps the user's", () => {
  seed({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo mine" }] }] } });
  codexAdapter.install();
  codexAdapter.uninstall();
  const config = readConfig();
  const all = Object.values(config.hooks ?? {}).flat();
  expect(all.some((g) => (g.hooks[0]?.command ?? "").includes("TERMCHAT_HOOK=1"))).toBe(false);
  expect(commandsFor(config, "UserPromptSubmit")).toEqual(["echo mine"]);
});

test("detect() is true only when ~/.codex exists", () => {
  expect(codexAdapter.detect()).toBe(false); // CODEX_HOME points at a not-yet-created dir
  mkdirSync(codexHome, { recursive: true });
  expect(codexAdapter.detect()).toBe(true);
});
