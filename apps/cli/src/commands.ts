/**
 * Pure slash-command parser for the TUI input (ported from the prototype's
 * command surface). Anything not starting with "/" is a chat message.
 */
export type Command =
  | { kind: "message"; text: string }
  | { kind: "join"; room: string }
  | { kind: "topic"; tag: string }
  | { kind: "report"; user: string }
  | { kind: "nick"; name: string }
  | { kind: "dm"; user: string; message?: string }
  | { kind: "rooms" }
  | { kind: "who" }
  | { kind: "help" }
  | { kind: "quit" }
  // identity / account (browser-backed)
  | { kind: "login" }
  | { kind: "logout" }
  | { kind: "whoami" }
  | { kind: "dashboard" }
  | { kind: "card" }
  | { kind: "onboard" }
  // marketplace
  | { kind: "expert"; on: boolean; rate?: number; topics: string[] }
  /** `maxRate` is absent exactly for a comped (`code`) call — those bill $0 and always
   *  name a `target`; the edge enforces both pairings. */
  | { kind: "summon"; maxRate?: number; problem: string; target?: string; code?: string }
  | { kind: "accept"; reqId?: string }
  | { kind: "decline"; reqId?: string }
  | { kind: "end" }
  | { kind: "review"; stars: number; text?: string }
  | { kind: "experts" }
  | { kind: "earnings" }
  | { kind: "dispute"; sessionId: number; reason?: string }
  | { kind: "bounty"; priceCents: number; question: string }
  | { kind: "claim"; bountyId: number }
  | { kind: "bounty_answer"; bountyId: number; answer: string }
  | { kind: "bounty_accept"; bountyId: number }
  | { kind: "bounty_reject"; bountyId: number }
  | { kind: "invalid"; reason: string }
  | { kind: "unknown"; name: string };

/** One row in the slash-command autocomplete menu (the `/`-triggered palette). */
export interface CommandInfo {
  /** Canonical name, without the leading slash (also what the palette filters on). */
  name: string;
  /** One-line description shown to the right of the name. */
  desc: string;
  /** True when the command takes arguments — the palette completes to `/name ` and
   *  waits; false runs it immediately on accept (e.g. /help, /quit). */
  args: boolean;
}

/**
 * The slash commands offered by the `/` autocomplete menu, in display order. Grouped
 * loosely (chat · you · need help · give help) but kept a flat list so the palette can
 * filter it by prefix. Aliases are intentionally omitted — a prefix like `/j` already
 * matches `join`. Descriptions mirror /help; keep them in sync with parseCommand below.
 */
export const COMMAND_INFO: readonly CommandInfo[] = [
  // chat
  { name: "call", desc: "Call a paid expert for a live session", args: true },
  { name: "dm", desc: "Open a direct message with someone", args: true },
  { name: "join", desc: "Switch to another lounge room", args: true },
  { name: "topic", desc: "Set the room's topic tag", args: true },
  { name: "rooms", desc: "List the available rooms", args: false },
  { name: "who", desc: "List who's in the current room", args: false },
  { name: "nick", desc: "Change your display name", args: true },
  { name: "report", desc: "Report a user to moderators", args: true },
  { name: "help", desc: "Show all commands", args: false },
  { name: "quit", desc: "Close termchat and exit", args: false },
  // you / account
  { name: "login", desc: "Sign in with GitHub", args: false },
  { name: "logout", desc: "Sign out, back to guest", args: false },
  { name: "whoami", desc: "Show who you're signed in as", args: false },
  { name: "dashboard", desc: "Open your web dashboard", args: false },
  { name: "card", desc: "Add or manage your payment card", args: false },
  { name: "onboard", desc: "Set up expert payouts", args: false },
  // need help (seeker)
  { name: "bounty", desc: "Post an async paid question", args: true },
  { name: "experts", desc: "List experts online now", args: false },
  { name: "approve", desc: "Approve an answered bounty (pays out)", args: true },
  { name: "reject", desc: "Reject an answered bounty", args: true },
  { name: "review", desc: "Rate a finished call (1–5)", args: true },
  { name: "dispute", desc: "Dispute a charge for a session", args: true },
  // give help (expert)
  { name: "expert", desc: "Go online/offline as a paid expert", args: true },
  { name: "accept", desc: "Accept an incoming call offer", args: false },
  { name: "decline", desc: "Decline an incoming call offer", args: false },
  { name: "end", desc: "End the active call", args: false },
  { name: "claim", desc: "Claim an open bounty to answer", args: true },
  { name: "answer", desc: "Answer a bounty you claimed", args: true },
  { name: "earnings", desc: "Show your earnings summary", args: false },
];

/** Commands whose canonical name starts with the text typed after `/` (case-insensitive).
 *  `partial` is the raw draft INCLUDING the leading slash, e.g. "/ca". Returns [] when the
 *  draft isn't a bare command prefix (empty, no slash, or already has a space/args). */
export function matchCommands(partial: string): readonly CommandInfo[] {
  if (!partial.startsWith("/") || /\s/.test(partial)) return [];
  const q = partial.slice(1).toLowerCase();
  const hits = COMMAND_INFO.filter((c) => c.name.startsWith(q));
  // Float an EXACT name-match to the top so Enter picks what was typed, not a longer
  // command it's a prefix of (e.g. "/expert" → expert, not experts). Otherwise keep order.
  return hits.slice().sort((a, b) => (a.name === q ? -1 : 0) - (b.name === q ? -1 : 0));
}

export function parseCommand(input: string): Command | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("/")) return { kind: "message", text: trimmed };

  const [rawName, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = (rawName ?? "").toLowerCase();
  const arg = rest.join(" ").trim();
  switch (name) {
    case "join":
    case "j":
      return { kind: "join", room: arg };
    case "topic":
    case "t":
      return { kind: "topic", tag: arg };
    case "report":
      return { kind: "report", user: arg };
    case "dm":
    case "msg": {
      // /dm <user> [message…] — open a DM thread, optionally sending a first line.
      const target = rest[0] ?? "";
      if (!target) return { kind: "invalid", reason: "usage: /dm <user> [message]" };
      const message = rest.slice(1).join(" ").trim();
      return { kind: "dm", user: target, ...(message ? { message } : {}) };
    }
    case "nick":
    case "name":
      return arg ? { kind: "nick", name: arg } : { kind: "invalid", reason: "usage: /nick <name>" };
    case "rooms":
      return { kind: "rooms" };
    case "who":
    case "roster":
      return { kind: "who" };
    case "help":
    case "h":
    case "?":
      return { kind: "help" };
    case "quit":
    case "q":
    case "exit":
      return { kind: "quit" };
    case "login":
    case "signin":
      return { kind: "login" };
    case "logout":
    case "signout":
      return { kind: "logout" };
    case "whoami":
      return { kind: "whoami" };
    case "dashboard":
    case "dash":
      return { kind: "dashboard" };
    case "card":
      return { kind: "card" };
    case "onboard":
      return { kind: "onboard" };
    case "expert":
      return parseExpert(rest);
    case "call":
    case "summon": {
      // /call [@handle] <maxRate> <problem…>            (/summon is a legacy alias)
      // /call --code <CODE> @handle <problem…>          free call — no rate, handle required
      // A leading @handle targets ONE named expert directly; without it, the call
      // is the open topic/rate auction. The @ sigil is required to disambiguate a
      // handle from a (malformed) rate. The rate cap applies in both forms.
      // --code carries an OPAQUE free-call promo code; the edge validates it (an
      // invalid code just gets rejected server-side — it grants nothing on its own).
      let parts = rest;
      let code: string | undefined;
      const codeIdx = parts.indexOf("--code");
      if (codeIdx !== -1) {
        code = parts[codeIdx + 1]?.trim();
        if (!code) {
          return {
            kind: "invalid",
            reason: "usage: /call --code <CODE> @<handle> <problem>",
          };
        }
        parts = parts.filter((_, i) => i !== codeIdx && i !== codeIdx + 1);
      }
      let target: string | undefined;
      if (parts[0]?.startsWith("@")) {
        target = parts[0].slice(1).trim();
        parts = parts.slice(1);
        if (!target) {
          return { kind: "invalid", reason: "usage: /call @<handle> <maxRate> <problem>" };
        }
      }
      // A free call takes NO rate: it's $0 by construction, and it must name someone
      // (there's no free auction). Everything after the handle is the problem — so a
      // problem may legitimately start with a number.
      if (code) {
        const problem = parts.join(" ").trim();
        if (!target || !problem) {
          return {
            kind: "invalid",
            reason: "usage: /call --code <CODE> @<handle> <problem>",
          };
        }
        return { kind: "summon", problem, target, code };
      }
      const maxRate = Number.parseFloat(parts[0] ?? "");
      const problem = parts.slice(1).join(" ").trim();
      if (!Number.isFinite(maxRate) || !problem) {
        return {
          kind: "invalid",
          reason:
            "usage: /call [@handle] <maxRate> <problem>  |  /call --code <CODE> @<handle> <problem>",
        };
      }
      return {
        kind: "summon",
        maxRate,
        problem,
        ...(target ? { target } : {}),
      };
    }
    case "accept":
      // Real-time call offer only. Bounty answers are approved with /approve.
      return rest[0] ? { kind: "accept", reqId: rest[0] } : { kind: "accept" };
    case "approve": {
      // /approve <bountyId> — the seeker approves a delivered bounty answer.
      const bountyId = Number.parseInt(rest[0] ?? "", 10);
      if (!Number.isInteger(bountyId) || bountyId <= 0) {
        return { kind: "invalid", reason: "usage: /approve <bountyId>" };
      }
      return { kind: "bounty_accept", bountyId };
    }
    case "decline":
      return rest[0] ? { kind: "decline", reqId: rest[0] } : { kind: "decline" };
    case "end":
      return { kind: "end" };
    case "review": {
      // /review <stars> [text…]
      const stars = Number.parseInt(rest[0] ?? "", 10);
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
        return { kind: "invalid", reason: "usage: /review <1-5> [comment]" };
      }
      const text = rest.slice(1).join(" ").trim();
      return text ? { kind: "review", stars, text } : { kind: "review", stars };
    }
    case "experts":
      return { kind: "experts" };
    case "earnings":
      return { kind: "earnings" };
    case "dispute": {
      // /dispute <sessionId> [reason…]
      const sessionId = Number.parseInt(rest[0] ?? "", 10);
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return { kind: "invalid", reason: "usage: /dispute <sessionId> [reason]" };
      }
      const reason = rest.slice(1).join(" ").trim();
      return reason ? { kind: "dispute", sessionId, reason } : { kind: "dispute", sessionId };
    }
    case "bounty": {
      // /bounty <price$> <question…> — post an async bounty (no expert online).
      const price = Number.parseFloat(rest[0] ?? "");
      const question = rest.slice(1).join(" ").trim();
      if (!Number.isFinite(price) || price <= 0 || !question) {
        return { kind: "invalid", reason: "usage: /bounty <price> <question>" };
      }
      return { kind: "bounty", priceCents: Math.round(price * 100), question };
    }
    case "claim": {
      // /claim <bountyId> — an expert claims an open bounty.
      const bountyId = Number.parseInt(rest[0] ?? "", 10);
      if (!Number.isInteger(bountyId) || bountyId <= 0) {
        return { kind: "invalid", reason: "usage: /claim <bountyId>" };
      }
      return { kind: "claim", bountyId };
    }
    case "answer": {
      // /answer <bountyId> <answer…> — the claiming expert answers/resubmits.
      const bountyId = Number.parseInt(rest[0] ?? "", 10);
      const answer = rest.slice(1).join(" ").trim();
      if (!Number.isInteger(bountyId) || bountyId <= 0 || !answer) {
        return { kind: "invalid", reason: "usage: /answer <bountyId> <answer>" };
      }
      return { kind: "bounty_answer", bountyId, answer };
    }
    case "reject": {
      // /reject <bountyId> — the seeker rejects an answered bounty.
      const bountyId = Number.parseInt(rest[0] ?? "", 10);
      if (!Number.isInteger(bountyId) || bountyId <= 0) {
        return { kind: "invalid", reason: "usage: /reject <bountyId>" };
      }
      return { kind: "bounty_reject", bountyId };
    }
    default:
      return { kind: "unknown", name };
  }
}

function parseExpert(rest: string[]): Command {
  const sub = (rest[0] ?? "").toLowerCase();
  if (sub === "off") return { kind: "expert", on: false, topics: [] };
  if (sub === "on") {
    // /expert on <rate> [topic,topic,…]
    const rate = Number.parseFloat(rest[1] ?? "");
    if (!Number.isFinite(rate)) {
      return { kind: "invalid", reason: "usage: /expert on <rate> [topics]" };
    }
    const topics = (rest[2] ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    return { kind: "expert", on: true, rate, topics };
  }
  return { kind: "invalid", reason: "usage: /expert on <rate> [topics] | /expert off" };
}
