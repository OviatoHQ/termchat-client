import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "statusline.sh");

test("statusline.sh makes no network calls (hot-path invariant, PRD §6.3)", () => {
  const source = readFileSync(SCRIPT, "utf8");
  for (const forbidden of ["curl", "wget", "nc ", "/dev/tcp", "http://", "https://", "fetch"]) {
    expect(source.includes(forbidden)).toBe(false);
  }
  expect(source).toContain("cat");
});

test("statusline.sh only emits the local online line", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-sl-"));
  try {
    writeFileSync(join(home, "online.line"), "● termchat: 7 online\n");
    const proc = Bun.spawn(["bash", SCRIPT], {
      env: { ...process.env, TERMCHAT_HOME: home },
      stdout: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe("● termchat: 7 online");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("statusline.sh prints nothing (and does not fail) when the line is absent", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-sl-empty-"));
  try {
    const proc = Bun.spawn(["bash", SCRIPT], {
      env: { ...process.env, TERMCHAT_HOME: home },
      stdout: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(out).toBe("");
    expect(code).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
