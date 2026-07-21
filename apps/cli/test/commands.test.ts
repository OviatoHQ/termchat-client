import { expect, test } from "bun:test";
import { COMMAND_INFO, matchCommands, parseCommand } from "../src/commands.ts";

test("plain text becomes a message", () => {
  expect(parseCommand("hello there")).toEqual({ kind: "message", text: "hello there" });
});

test("matchCommands: '/' lists every command", () => {
  expect(matchCommands("/").length).toBe(COMMAND_INFO.length);
});

test("matchCommands: prefix filters by canonical name", () => {
  expect(matchCommands("/ca").map((c) => c.name)).toEqual(["call", "card"]);
  expect(matchCommands("/HE").map((c) => c.name)).toEqual(["help"]); // case-insensitive
  // "expert" is a prefix of both — but the EXACT match floats to the top so Enter picks it.
  expect(matchCommands("/expert").map((c) => c.name)).toEqual(["expert", "experts"]);
  expect(matchCommands("/experts").map((c) => c.name)).toEqual(["experts"]);
});

test("matchCommands: not a bare command prefix → no menu", () => {
  expect(matchCommands("")).toEqual([]); // empty
  expect(matchCommands("hi")).toEqual([]); // no slash
  expect(matchCommands("/call 4 fix")).toEqual([]); // has args (space)
  expect(matchCommands("/zzz")).toEqual([]); // no match
});

test("every COMMAND_INFO name is parseable (metadata ↔ parser in sync)", () => {
  for (const c of COMMAND_INFO) {
    const parsed = parseCommand(`/${c.name}`);
    // A bare command is never "unknown" (it may be "invalid" if it needs args).
    expect(parsed?.kind).not.toBe("unknown");
  }
});

test("blank input is null", () => {
  expect(parseCommand("   ")).toBeNull();
});

test("slash commands parse with args and aliases", () => {
  expect(parseCommand("/join rust")).toEqual({ kind: "join", room: "rust" });
  expect(parseCommand("/j nextjs")).toEqual({ kind: "join", room: "nextjs" });
  expect(parseCommand("/topic docker")).toEqual({ kind: "topic", tag: "docker" });
  expect(parseCommand("/report spammer")).toEqual({ kind: "report", user: "spammer" });
  expect(parseCommand("/rooms")).toEqual({ kind: "rooms" });
  expect(parseCommand("/who")).toEqual({ kind: "who" });
  expect(parseCommand("/help")).toEqual({ kind: "help" });
  expect(parseCommand("/q")).toEqual({ kind: "quit" });
});

test("parses account/browser commands including /dashboard", () => {
  expect(parseCommand("/whoami")).toEqual({ kind: "whoami" });
  expect(parseCommand("/dashboard")).toEqual({ kind: "dashboard" });
  expect(parseCommand("/dash")).toEqual({ kind: "dashboard" });
  expect(parseCommand("/card")).toEqual({ kind: "card" });
  expect(parseCommand("/onboard")).toEqual({ kind: "onboard" });
});

test("unknown slash command is reported", () => {
  expect(parseCommand("/frobnicate now")).toEqual({ kind: "unknown", name: "frobnicate" });
});

test("parses marketplace commands", () => {
  expect(parseCommand("/expert on 2 rust,go")).toEqual({
    kind: "expert",
    on: true,
    rate: 2,
    topics: ["rust", "go"],
  });
  expect(parseCommand("/expert off")).toEqual({ kind: "expert", on: false, topics: [] });
  expect(parseCommand("/call 5 borrow checker help")).toEqual({
    kind: "summon",
    maxRate: 5,
    problem: "borrow checker help",
  });
  // /summon stays as a legacy alias for /call, parsing to the same kind.
  expect(parseCommand("/summon 5 borrow checker help")).toEqual({
    kind: "summon",
    maxRate: 5,
    problem: "borrow checker help",
  });
  // Targeted call: a leading @handle addresses one named expert; rate cap still applies.
  expect(parseCommand("/call @chef 5 borrow checker help")).toEqual({
    kind: "summon",
    maxRate: 5,
    problem: "borrow checker help",
    target: "chef",
  });
  // Free-call promo code: --code carries an opaque token (validated on the edge),
  // stripped from the args before the @handle / problem are parsed. A free call takes
  // NO rate (it bills $0) and MUST name a handle — the target needn't be a listed expert.
  expect(parseCommand("/call --code FREE123 @chef borrow checker help")).toEqual({
    kind: "summon",
    problem: "borrow checker help",
    target: "chef",
    code: "FREE123",
  });
  // --code composes with the @handle in any order.
  expect(parseCommand("/call @chef --code FREE123 risotto")).toEqual({
    kind: "summon",
    problem: "risotto",
    target: "chef",
    code: "FREE123",
  });
  // With --code there's no rate slot, so a problem may start with a number and keeps it.
  expect(parseCommand("/call --code FREE123 @chef 2 tests failing")).toEqual({
    kind: "summon",
    problem: "2 tests failing",
    target: "chef",
    code: "FREE123",
  });
  // A free call with no handle is a usage error — there is no free open auction.
  expect(parseCommand("/call --code FREE123 borrow checker help")).toEqual({
    kind: "invalid",
    reason: "usage: /call --code <CODE> @<handle> <problem>",
  });
  // --code with no value is a usage error, not a silent no-op.
  expect(parseCommand("/call --code")).toEqual({
    kind: "invalid",
    reason: "usage: /call --code <CODE> @<handle> <problem>",
  });
  expect(parseCommand("/accept")).toEqual({ kind: "accept" });
  expect(parseCommand("/accept r1")).toEqual({ kind: "accept", reqId: "r1" });
  expect(parseCommand("/end")).toEqual({ kind: "end" });
  expect(parseCommand("/review 5 thanks")).toEqual({ kind: "review", stars: 5, text: "thanks" });
  expect(parseCommand("/experts")).toEqual({ kind: "experts" });
  expect(parseCommand("/earnings")).toEqual({ kind: "earnings" });
  expect(parseCommand("/dispute 7")).toEqual({ kind: "dispute", sessionId: 7 });
  expect(parseCommand("/dispute 7 never connected")).toEqual({
    kind: "dispute",
    sessionId: 7,
    reason: "never connected",
  });
  expect(parseCommand("/bounty 5 fix my borrow checker")).toEqual({
    kind: "bounty",
    priceCents: 500,
    question: "fix my borrow checker",
  });
  expect(parseCommand("/claim 12")).toEqual({ kind: "claim", bountyId: 12 });
  expect(parseCommand("/answer 12 use Arc not Rc")).toEqual({
    kind: "bounty_answer",
    bountyId: 12,
    answer: "use Arc not Rc",
  });
  expect(parseCommand("/approve 12")).toEqual({ kind: "bounty_accept", bountyId: 12 }); // bounty answer
  expect(parseCommand("/accept 12")).toEqual({ kind: "accept", reqId: "12" }); // call offer, no numeric overload
  expect(parseCommand("/accept")).toEqual({ kind: "accept" }); // bare → call offer
  expect(parseCommand("/reject 12")).toEqual({ kind: "bounty_reject", bountyId: 12 });
});

test("rejects malformed marketplace commands with a usage hint", () => {
  expect(parseCommand("/call notanumber")).toMatchObject({ kind: "invalid" });
  expect(parseCommand("/call @chef")).toMatchObject({ kind: "invalid" }); // handle but no rate/problem
  expect(parseCommand("/call @ 5 help")).toMatchObject({ kind: "invalid" }); // empty handle
  expect(parseCommand("/approve notanumber")).toMatchObject({ kind: "invalid" });
  expect(parseCommand("/expert on")).toMatchObject({ kind: "invalid" });
  expect(parseCommand("/review 9")).toMatchObject({ kind: "invalid" });
  expect(parseCommand("/dispute notanumber")).toMatchObject({ kind: "invalid" });
  expect(parseCommand("/bounty 5")).toMatchObject({ kind: "invalid" }); // no question
  expect(parseCommand("/claim notanumber")).toMatchObject({ kind: "invalid" });
});

test("parses account/identity commands", () => {
  expect(parseCommand("/login")).toEqual({ kind: "login" });
  expect(parseCommand("/signin")).toEqual({ kind: "login" });
  expect(parseCommand("/logout")).toEqual({ kind: "logout" });
  expect(parseCommand("/whoami")).toEqual({ kind: "whoami" });
  expect(parseCommand("/card")).toEqual({ kind: "card" });
  expect(parseCommand("/onboard")).toEqual({ kind: "onboard" });
});

test("/dm parses a target and optional first message", () => {
  expect(parseCommand("/dm bob")).toEqual({ kind: "dm", user: "bob" });
  expect(parseCommand("/dm bob yo bro ssup")).toEqual({
    kind: "dm",
    user: "bob",
    message: "yo bro ssup",
  });
  expect(parseCommand("/dm")).toEqual({ kind: "invalid", reason: "usage: /dm <user> [message]" });
});
