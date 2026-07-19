import type { TopicTag } from "@termchat/protocol";

/**
 * Agent-neutral "expert available" desktop notification (Phase 3B) — the cross-agent
 * presence surface, and the substitute for the ambient status line where the agent has
 * none (Codex). Two hard guarantees:
 *  - NON-BLOCKING: the notifier is spawned detached and EVERY error is swallowed — a
 *    missing OS notification daemon or a failed spawn must never wedge or slow the
 *    presence loop (same exit-clean discipline as hooks).
 *  - §11.3 REDACTION: the body may carry ONLY a coarse `TopicTag` — never the seeker's
 *    question, prompt-derived text, or anything beyond an allow-list tag. The function
 *    signature enforces this (it accepts only a TopicTag), and `expertAvailableBody`
 *    never interpolates anything else.
 */

/** The (redacted) notification body. Exported so the redaction guarantee is testable. */
export function expertAvailableBody(topic?: TopicTag | null): string {
  return topic ? `An expert is available for #${topic}` : "An expert is now available";
}

/** True when the live `experts` count crosses 0/absent → ≥1 (the availability edge). */
export function crossedExpertAvailable(prev: number, next: number): boolean {
  return prev < 1 && next >= 1;
}

function asAppleString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Platform notifier argv, or null when unsupported (→ no-op, never block). */
function notifierCommand(title: string, body: string): string[] | null {
  switch (process.platform) {
    case "darwin":
      return [
        "osascript",
        "-e",
        `display notification ${asAppleString(body)} with title ${asAppleString(title)}`,
      ];
    case "linux":
      return ["notify-send", title, body];
    default:
      return null;
  }
}

/**
 * Fire a best-effort desktop notification that an expert is available. Never throws,
 * never blocks. `TERMCHAT_DISABLE_NOTIFY=1` makes it a no-op (tests / opt-out).
 */
export function notifyExpertAvailable(topic?: TopicTag | null): void {
  if (process.env.TERMCHAT_DISABLE_NOTIFY === "1") return;
  try {
    const cmd = notifierCommand("termchat", expertAvailableBody(topic));
    if (!cmd) return; // unsupported platform → silently skip
    const child = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
  } catch {
    // A missing notifier / spawn failure must never wedge the presence loop.
  }
}

/**
 * The (redacted) DM notification body. §11.3: the signature accepts ONLY the sender
 * handle — never message text — so plaintext physically cannot reach the OS notifier
 * (same type-enforced discipline as `expertAvailableBody`). Do not add a body/preview
 * parameter. Exported so the redaction guarantee is testable.
 */
export function dmReceivedBody(from: string): string {
  return `New message from @${from}`;
}

/**
 * Best-effort desktop notification that a DM arrived, raised by the presence daemon on
 * a `dm_notify` nudge. Same non-blocking, swallow-all discipline as the expert path.
 */
export function notifyDmReceived(from: string): void {
  if (process.env.TERMCHAT_DISABLE_NOTIFY === "1") return;
  try {
    const cmd = notifierCommand("termchat", dmReceivedBody(from));
    if (!cmd) return;
    const child = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
  } catch {
    // A missing notifier / spawn failure must never wedge the presence loop.
  }
}
