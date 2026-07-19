import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const UNREACHABLE = "http://127.0.0.1:59999"; // nothing listens here

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tc-hook-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function runHook(
  event: string,
  stdin: string,
  edge: string,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, CLI, "hook", event], {
    env: { ...process.env, TERMCHAT_HOME: home, TERMCHAT_EDGE: edge, ...extraEnv },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("prompt-submit exits 0 quickly even when the edge is unreachable (never blocks)", async () => {
  const start = Date.now();
  const proc = runHook(
    "prompt-submit",
    JSON.stringify({ session_id: "s1", prompt: "secret" }),
    UNREACHABLE,
  );
  const code = await proc.exited;
  expect(code).toBe(0);
  expect(Date.now() - start).toBeLessThan(3000);
});

test("session-start exits 0 and does not block (daemon spawn disabled)", async () => {
  const proc = runHook("session-start", "{}", UNREACHABLE, { TERMCHAT_DISABLE_DAEMON_SPAWN: "1" });
  expect(await proc.exited).toBe(0);
});

test("prompt-submit never sends raw prompt, cwd, or transcript paths (PRD §11.3)", async () => {
  let captured: Record<string, unknown> | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/presence/state") {
        captured = (await request.json()) as Record<string, unknown>;
      }
      return new Response(JSON.stringify({ ok: true, applied: false }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  try {
    const edge = `http://127.0.0.1:${server.port}`;
    // A classifiable keyword ("rust") plus secrets that must NOT leak.
    const stdin = JSON.stringify({
      session_id: "s1",
      prompt: "fix my failing rust test; api token sk-secret-12345",
      cwd: "/Users/secret/project",
      transcript_path: "/Users/secret/.claude/transcript.jsonl",
    });
    const proc = runHook("prompt-submit", stdin, edge);
    const code = await proc.exited;

    expect(code).toBe(0);
    expect(captured).toBeDefined();
    expect(captured?.state).toBe("busy");
    expect(captured?.sessionId).toBe("s1");
    expect(typeof captured?.clientId).toBe("string");
    // Only the coarse, locally-derived topic tag crosses the wire.
    expect(captured?.topic).toBe("rust");
    // The whole point: nothing prompt-derived may cross the wire.
    expect(captured && "prompt" in captured).toBe(false);
    expect(captured && "cwd" in captured).toBe(false);
    expect(captured && "transcript_path" in captured).toBe(false);
    expect(JSON.stringify(captured).includes("secret")).toBe(false);
    expect(JSON.stringify(captured).includes("sk-secret")).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("stop posts an idle state", async () => {
  let captured: Record<string, unknown> | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/presence/state") {
        captured = (await request.json()) as Record<string, unknown>;
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  });

  try {
    const proc = runHook(
      "stop",
      JSON.stringify({ session_id: "s1" }),
      `http://127.0.0.1:${server.port}`,
    );
    expect(await proc.exited).toBe(0);
    expect(captured?.state).toBe("idle");
    expect(captured?.sessionId).toBe("s1");
  } finally {
    server.stop(true);
  }
});
