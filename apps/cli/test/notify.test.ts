import { afterEach, expect, test } from "bun:test";
import {
  crossedExpertAvailable,
  dmReceivedBody,
  expertAvailableBody,
  notifyDmReceived,
  notifyExpertAvailable,
} from "../src/notify.ts";

const saved = process.env.TERMCHAT_DISABLE_NOTIFY;
afterEach(() => {
  if (saved === undefined) delete process.env.TERMCHAT_DISABLE_NOTIFY;
  else process.env.TERMCHAT_DISABLE_NOTIFY = saved;
});

// §11.3 redaction: the body may carry ONLY a coarse topic — never anything else.
test("notification body carries only a coarse topic, or a generic line", () => {
  expect(expertAvailableBody("rust")).toBe("An expert is available for #rust");
  expect(expertAvailableBody(null)).toBe("An expert is now available");
  expect(expertAvailableBody()).toBe("An expert is now available");
});

test("the body never contains anything but the title-less generic text + the tag", () => {
  // The function signature only accepts a TopicTag, so prompt/question text cannot be
  // passed; the rendered body for a tag mentions only that tag.
  const body = expertAvailableBody("python");
  expect(body).toContain("#python");
  expect(body).not.toMatch(/[?]|prompt|question|cwd|http/i); // no content/PII shapes
});

// Availability edge: fire once on 0/absent → ≥1, not on every snapshot.
test("crossedExpertAvailable triggers only on the 0→≥1 transition", () => {
  expect(crossedExpertAvailable(0, 1)).toBe(true);
  expect(crossedExpertAvailable(0, 3)).toBe(true);
  expect(crossedExpertAvailable(1, 2)).toBe(false); // already available
  expect(crossedExpertAvailable(2, 0)).toBe(false); // went away
  expect(crossedExpertAvailable(0, 0)).toBe(false); // still none
});

// Non-blocking: never throws, returns synchronously, no-op under the disable flag.
test("notifyExpertAvailable is non-blocking and never throws", () => {
  process.env.TERMCHAT_DISABLE_NOTIFY = "1";
  expect(() => notifyExpertAvailable("rust")).not.toThrow();
  expect(notifyExpertAvailable("rust")).toBeUndefined();
  expect(() => notifyExpertAvailable()).not.toThrow();
});

// §11.3: the DM banner names only the SENDER — never message content. The signature
// takes just `from`, so plaintext physically can't be passed.
test("dmReceivedBody carries only the sender handle, never content", () => {
  expect(dmReceivedBody("alice")).toBe("New message from @alice");
  const body = dmReceivedBody("bob");
  expect(body).toContain("@bob");
  expect(body).not.toMatch(/[?]|prompt|cipher|nonce|http/i);
});

test("notifyDmReceived is non-blocking and never throws", () => {
  process.env.TERMCHAT_DISABLE_NOTIFY = "1";
  expect(() => notifyDmReceived("alice")).not.toThrow();
  expect(notifyDmReceived("alice")).toBeUndefined();
});
