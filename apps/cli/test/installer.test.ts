import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter } from "../src/claude-adapter.ts";
import { install, uninstall } from "../src/installer.ts";

type HookGroup = { hooks: Array<{ command: string }> };
type HookMap = Record<string, HookGroup[]>;

let tmp: string;
let configDir: string;
const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  if (!(key in saved)) saved[key] = process.env[key];
  process.env[key] = value;
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function hookMap(settings: Record<string, unknown>): HookMap {
  return (settings.hooks ?? {}) as HookMap;
}

/** Commands registered for an event (empty array if the event is absent). */
function commandsFor(settings: Record<string, unknown>, event: string): string[] {
  return (hookMap(settings)[event] ?? []).map((group) => group.hooks[0]?.command ?? "");
}

function seedSettings(value: unknown): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "settings.json"), JSON.stringify(value, null, 2));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tc-install-"));
  configDir = join(tmp, "claude");
  setEnv("CLAUDE_CONFIG_DIR", configDir);
  setEnv("TERMCHAT_HOME", join(tmp, "home"));
  setEnv("TERMCHAT_BIN_DIR", join(tmp, "bin"));
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    delete saved[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

test("install wires the four Phase 0 hook events and writes a launcher", () => {
  const result = install();
  const settings = readSettings();

  expect(Object.keys(hookMap(settings)).sort()).toEqual([
    "SessionEnd",
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
  ]);
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]) {
    const commands = commandsFor(settings, event);
    expect(commands.some((command) => command.includes("TERMCHAT_HOOK=1"))).toBe(true);
    expect(commands.some((command) => command.includes("hook"))).toBe(true);
  }
  expect(existsSync(result.launcherPath)).toBe(true);
});

test("install preserves a user's existing hooks and unrelated keys", () => {
  seedSettings({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo mine" }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "echo pre" }] }],
    },
    statusLine: { type: "command", command: "my-statusline" },
    model: "opus",
  });

  install({ statusline: true });
  const settings = readSettings();

  const userPrompt = commandsFor(settings, "UserPromptSubmit");
  expect(userPrompt).toContain("echo mine");
  expect(userPrompt.some((command) => command.includes("TERMCHAT_HOOK=1"))).toBe(true);

  expect(commandsFor(settings, "PreToolUse")).toEqual(["echo pre"]);
  expect(settings.model).toBe("opus");
});

function readGeneratedStatusline(): string {
  return readFileSync(join(process.env.TERMCHAT_HOME as string, "statusline.sh"), "utf8");
}

test("install --statusline appends to (wraps) an existing status line", () => {
  seedSettings({ statusLine: { type: "command", command: "my-statusline" } });

  const result = install({ statusline: true });
  expect(result.statuslineInstalled).toBe(true);
  expect(result.statuslineAppended).toBe(true);

  // The setting now points at our wrapper…
  const command = (readSettings().statusLine as { command?: string }).command ?? "";
  expect(command).toContain("TERMCHAT_STATUSLINE=1");
  expect(command).toContain("statusline.sh");

  // …and the generated wrapper runs the original AND appends the presence line.
  const script = readGeneratedStatusline();
  expect(script).toContain("my-statusline");
  expect(script).toContain("online.line");
  // termchat's own contribution never touches the network.
  for (const forbidden of ["curl", "wget", "/dev/tcp", "http://", "https://"]) {
    expect(script.includes(forbidden)).toBe(false);
  }
});

test("re-running install --statusline over an appended one does not double-wrap", () => {
  seedSettings({ statusLine: { type: "command", command: "my-statusline" } });
  install({ statusline: true });
  install({ statusline: true });

  const script = readGeneratedStatusline();
  // The original appears exactly once (we wrap the sidecar original, not our wrapper).
  expect(script.split("my-statusline").length - 1).toBe(1);
  expect(script).not.toContain("TERMCHAT_STATUSLINE=1");
});

test("uninstall restores the wrapped original status line verbatim", () => {
  seedSettings({ statusLine: { type: "command", command: "my-statusline", padding: 2 } });
  install({ statusline: true });
  uninstall();

  const restored = readSettings().statusLine as { command?: string; padding?: number };
  expect(restored.command).toBe("my-statusline");
  expect(restored.padding).toBe(2);
});

test("re-running install is idempotent (no duplicate termchat entries)", () => {
  install();
  install();
  const settings = readSettings();
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]) {
    const ours = commandsFor(settings, event).filter((command) =>
      command.includes("TERMCHAT_HOOK=1"),
    );
    expect(ours).toHaveLength(1);
  }
});

test("install --statusline installs a fresh status line when none exists", () => {
  const result = install({ statusline: true });
  expect(result.statuslineInstalled).toBe(true);
  expect(result.statuslineAppended).toBe(false);
  const command = (readSettings().statusLine as { command?: string }).command ?? "";
  expect(command).toContain("TERMCHAT_STATUSLINE=1");
  expect(command).toContain("statusline.sh");
});

test("the wrapper composes the prior line and presence on one line", async () => {
  const home = process.env.TERMCHAT_HOME as string;
  seedSettings({ statusLine: { type: "command", command: "printf 'PRIOR'" } });
  install({ statusline: true });
  writeFileSync(join(home, "online.line"), "▄▀ tc 12 online\n");

  const script = join(home, "statusline.sh");
  const proc = Bun.spawn(["bash", script], {
    env: { ...process.env, TERMCHAT_HOME: home },
    stdin: new Response("{}"),
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out.trim()).toBe("PRIOR  ▄▀ tc 12 online");
});

test("install backs up an existing settings.json", () => {
  seedSettings({ model: "x" });
  const result = install();
  expect(result.backupPath).not.toBeNull();
  if (result.backupPath) expect(existsSync(result.backupPath)).toBe(true);
});

test("install refuses to touch invalid JSON", () => {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "settings.json"), "{ not valid json ");
  expect(() => install()).toThrow();
});

test("uninstall removes termchat entries but keeps foreign ones", () => {
  seedSettings({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
    statusLine: { type: "command", command: "my-statusline" },
  });
  install({ statusline: true });
  uninstall();

  const settings = readSettings();
  const all = Object.values(hookMap(settings)).flat();
  expect(all.some((group) => (group.hooks[0]?.command ?? "").includes("TERMCHAT_HOOK=1"))).toBe(
    false,
  );
  expect(commandsFor(settings, "UserPromptSubmit")).toEqual(["echo mine"]);
  expect((settings.statusLine as { command?: string }).command).toBe("my-statusline");
});

test("uninstall removes our own status line", () => {
  install({ statusline: true });
  uninstall();
  expect(readSettings().statusLine).toBeUndefined();
});

test("removeStatus pulls our status line but leaves the presence hooks in place", () => {
  install({ statusline: true });
  const result = claudeAdapter.removeStatus();
  expect(result.removed).toBe(true);

  const settings = readSettings();
  expect(settings.statusLine).toBeUndefined();
  const stillWired = Object.values(hookMap(settings))
    .flat()
    .some((group) => (group.hooks[0]?.command ?? "").includes("TERMCHAT_HOOK=1"));
  expect(stillWired).toBe(true);
});

test("removeStatus is a no-op when no termchat status line is present", () => {
  install(); // hooks only, no status line
  const result = claudeAdapter.removeStatus();
  expect(result.removed).toBe(false);
  expect(result.backupPath).toBeNull();
});

test("removeStatus restores the foreign status line it wrapped (never destroys it)", () => {
  seedSettings({ statusLine: { type: "command", command: "my-statusline" } });
  install({ statusline: true }); // wraps the foreign line so presence appends to it
  const result = claudeAdapter.removeStatus();
  expect(result.removed).toBe(true);
  // The user's own status line is put back, not deleted.
  expect((readSettings().statusLine as { command?: string }).command).toBe("my-statusline");
});
