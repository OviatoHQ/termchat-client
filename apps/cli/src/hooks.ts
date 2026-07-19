import type { TopicTag } from "@termchat/protocol";
import { z } from "zod";
import { classifyTopic } from "./classify.ts";
import { getOrCreateClientId, resolveEdge } from "./config.ts";
import { ensureDaemonRunning } from "./daemon.ts";

const HOOK_DEADLINE_MS = 1_500;
const REQUEST_TIMEOUT_MS = 500;
const STDIN_TIMEOUT_MS = 300;

/**
 * Hook stdin. We read the session id and (for UserPromptSubmit) the prompt —
 * but the prompt is used ONLY to derive a coarse topic tag locally and is then
 * discarded. It, `cwd`, paths, and transcripts are never forwarded (PRD §11.3);
 * Zod strips every other key so nothing else can leak by accident.
 */
const HookInput = z.object({
  session_id: z.string().min(1).max(128).optional(),
  prompt: z.string().optional(),
});
type HookInput = z.infer<typeof HookInput>;

type HookEvent = "session-start" | "prompt-submit" | "stop" | "session-end";

const EVENTS: Record<string, HookEvent> = {
  "session-start": "session-start",
  "prompt-submit": "prompt-submit",
  stop: "stop",
  "session-end": "session-end",
};

/**
 * Run a single one-shot hook. Hard-capped by a deadline, swallows every error,
 * and always exits 0 — a hook must never block or fail Claude Code (PRD §6.4).
 */
export async function runHook(rawEvent: string | undefined): Promise<void> {
  const deadline = setTimeout(() => process.exit(0), HOOK_DEADLINE_MS);
  deadline.unref?.();
  try {
    const event = rawEvent ? EVENTS[rawEvent] : undefined;
    if (!event) return;
    const input = await readHookInput();
    await dispatch(event, input);
  } catch {
    // never propagate
  } finally {
    clearTimeout(deadline);
    process.exit(0);
  }
}

async function dispatch(event: HookEvent, input: HookInput): Promise<void> {
  switch (event) {
    case "session-start":
      ensureDaemonRunning();
      return;
    case "prompt-submit": {
      // Derive the coarse topic LOCALLY; only the tag (never the prompt) is sent.
      const topic = input.prompt ? classifyTopic(input.prompt) : null;
      await postState("busy", input.session_id, topic);
      return;
    }
    case "stop":
    case "session-end":
      await postState("idle", input.session_id);
      return;
  }
}

async function postState(
  state: "busy" | "idle",
  sessionId: string | undefined,
  topic?: TopicTag | null,
): Promise<void> {
  const { httpBase } = resolveEdge();
  const clientId = getOrCreateClientId();
  // Build the body explicitly so only allow-listed fields can ever be sent.
  const body: Record<string, string> = { clientId, state };
  if (sessionId) body.sessionId = sessionId;
  if (topic) body.topic = topic;
  try {
    await fetch(`${httpBase}/presence/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Edge unreachable → presence simply doesn't update. Never block.
  }
}

async function readHookInput(): Promise<HookInput> {
  const raw = await readStdin();
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  const parsed = HookInput.safeParse(value);
  return parsed.success ? parsed.data : {};
}

async function readStdin(): Promise<string> {
  try {
    const text = Bun.stdin.text();
    const timeout = new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve(""), STDIN_TIMEOUT_MS);
      timer.unref?.();
    });
    return await Promise.race([text, timeout]);
  } catch {
    return "";
  }
}
