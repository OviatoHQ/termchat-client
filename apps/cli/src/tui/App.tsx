import {
  type BountyCard,
  type ExpertCard,
  LOUNGE_ROOMS,
  NickName,
  RoomName,
  type RosterEntry,
  type ServerMarketplaceMessage,
  type SessionCard,
  TopicTag,
} from "@termchat/protocol";
import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { beginLogin, submitLoginCode } from "../auth.ts";
import { billingLinkNotice, dashboardNotice } from "../billing.ts";
import { type Command, type CommandInfo, matchCommands, parseCommand } from "../commands.ts";
import { clearCredentials, writeCredentials } from "../config.ts";
import type { DmLine } from "../dm-client.ts";
import { type DmController, type DmControllerState, createDmController } from "../dm-controller.ts";
import { writeCallState } from "../line.ts";
import type { ChatLine, LoungeClient, LoungeState } from "../lounge-client.ts";
import { MarketplaceClient } from "../marketplace-client.ts";
import { openUrl } from "../open-url.ts";
import { PresenceNotifyClient } from "../presence-notify.ts";
import { VERSION_LABEL } from "../version.ts";
import {
  BODY_TOP,
  BOUNTIES_LIST_OFFSET,
  CALLS_LIST_OFFSET,
  DMS_INBOX_OFFSET,
  EXPERTS_LIST_OFFSET,
  ME_LIST_OFFSET,
  hitTest,
  regionsForView,
} from "./hit-test.ts";
import { wrappedRows } from "./measure.ts";
import type { MouseEvent } from "./mouse.ts";
import {
  type DmView,
  type LoungeFocus,
  type ScrollTo,
  type TabId,
  reduceKey,
  windowStripCells,
} from "./nav.ts";
import {
  listWindow,
  rawOffsetForAnchor,
  stepRowOffset,
  windowByRows,
  windowTail,
} from "./scroll.ts";
import { C, G, cellWidth, selFg } from "./theme.ts";
import { ageShort, timeAgo } from "./timeago.ts";
import { useMouse } from "./use-mouse.ts";

/** The idle notice: what sits above the input when nothing else needs saying. Kept SHORT
 *  on purpose — the notice row wraps, and a line that spills onto a second row leaves an
 *  orphan fragment (`<user>`) hanging above the prompt. `/help` prints the full list. */
/** Tabs the marketplace event log is shown on — the ones whose actions produce it. */
const MARKET_TABS: ReadonlySet<TabId> = new Set<TabId>(["experts", "bounties", "calls", "me"]);

const IDLE_HINT = "type to chat · /help commands · Ctrl+U roster · Tab window";

const HELP_LINES = [
  "chat: /nick <name> · /join <room> · /rooms · /topic <tag> · /who · /dm <user> [msg] · /report <user>",
  "you: /login · /logout · /whoami · /dashboard · /card · /quit",
  "need help: /call [@handle] <maxRate> <problem> · /call --code <CODE> @handle <problem> (free) · /bounty <price> <question> · /experts · /approve <id> · /reject <id> · /review <1-5> · /dispute <id>",
  "give help: /expert on <rate> [topics] · /expert off · /accept · /decline · /end · /claim <id> · /answer <id> <text> · /earnings · /onboard",
  "/help · anything else is a chat message.",
];

const MKT_LOG_MAX = 8;

/** A `[Y/n]` answer: yes on "y"/"yes"/empty (Enter = default yes); anything else is no. */
export function confirmsYes(line: string): boolean {
  const a = line.trim().toLowerCase();
  return a === "" || a === "y" || a === "yes";
}

export type NickIntent =
  | { kind: "invalid"; message: string }
  | { kind: "confirm"; name: string } // verified: needs [Y/n] before saving
  | { kind: "apply"; name: string }; // guest: apply session-only immediately

/**
 * Decide what a `/nick <name>` should do, given whether the caller is verified.
 * Validates the name locally (so an invalid one gives a hint instead of being
 * silently dropped by the server's schema). Pure — the React handler applies it.
 */
export function nickIntent(rawName: string, isVerified: boolean): NickIntent {
  const parsed = NickName.safeParse(rawName);
  if (!parsed.success) {
    return { kind: "invalid", message: "Nick must be 2–24 chars: letters, digits, - or _." };
  }
  return isVerified ? { kind: "confirm", name: parsed.data } : { kind: "apply", name: parsed.data };
}

/** One row of the roster member's action menu (Ctrl+U → ↑/↓ → Enter, or a click). Built
 *  per-person: no "Send DM" on your own row, and the call/bounty row only exists when
 *  the marketplace lists that handle as an expert. */
export interface RosterMenuItem {
  kind: "dm" | "tag" | "call" | "bounty";
  label: string;
}

export interface AppProps {
  client: LoungeClient;
  /** Initial paid-marketplace client (present when already logged in at launch). */
  marketplace?: MarketplaceClient;
  /** Initial display handle (the verified user, or null when browsing anonymously). */
  user: string | null;
  /** Initial session token (for building call URLs and the fallback onCall). */
  token?: string | null;
  /** Edge config — enables in-TUI /login to reconnect + hot-attach the marketplace. */
  session?: { wsBase: string; httpBase: string; clientId: string };
  /** Fallback call opener when `session` isn't provided (e.g. tests). */
  onCall?: (sessionId: number, rate: number) => void;
  /** DM controller (docs/DMS.md stage 3b) — drives the DMs tab. Absent → DMs read-only
   *  "sign in" state (guests can't DM). */
  dmController?: DmController;
  /** Test seam: render once and skip raw-mode input wiring. */
  staticInput?: boolean;
  /** Initial status-line notice (e.g. a stale-session warning). Defaults to help. */
  notice?: string;
}

function fmtMembers(members: RosterEntry[]): string[] {
  return members.map((m) => {
    const name = m.verified ? `${m.user} ✓` : m.user;
    return m.topic ? `${name} · ${m.topic}` : name;
  });
}

const readTermSize = () => ({
  rows: process.stdout.rows || 24,
  cols: process.stdout.columns || 80,
});

/** Track terminal dimensions, updating on resize (falls back to 80×24 in tests). */
function useTerminalSize(): { rows: number; cols: number } {
  const [size, setSize] = useState(readTermSize);
  useEffect(() => {
    const onResize = () => setSize(readTermSize());
    process.stdout.on("resize", onResize);
    return () => void process.stdout.off("resize", onResize);
  }, []);
  return size;
}

/** A ~2 Hz cursor blink toggle. Held steady-on when `active` is false (tests, or
 *  when the message input isn't focused) so it never opens a timer under `bun test`. */
function useBlink(active: boolean): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!active) {
      setOn(true);
      return;
    }
    const id = setInterval(() => setOn((v) => !v), 500);
    return () => clearInterval(id);
  }, [active]);
  return on;
}

/** A coarse (~30 s) wall-clock tick that drives the DM inbox's "2 mins ago" labels.
 *  Held steady (no timer) when `active` is false — off the inbox and under `bun test`
 *  (mirrors {@link useBlink}) — so nothing repaints idly. Refreshes `now` immediately
 *  on becoming active so entering the inbox shows current times, not a stale mount value.
 *  Flicker-safe: the App renders one row under the terminal height, so periodic
 *  re-renders do smooth partial updates. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/** `HH:MM` for a millisecond timestamp — irssi-style transcript timestamps. */
function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** `MM:SS` for a live-meter elapsed-seconds count. */
function clock(secs: number): string {
  return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
}

/**
 * The `@…` handle being typed at the END of a draft, lowercased and without its `@`, or
 * null when the trailing word isn't a mention. `"hi @bo"` → `"bo"`, `"hi @bob "` → null
 * (the word is finished), `"a@b"` → null (an `@` mid-word is an email, not a mention).
 * A bare `"@"` returns `""`, which lists everyone — same as a bare `/`.
 */
export function mentionPrefix(draft: string): string | null {
  const word = draft.split(/\s/).at(-1) ?? "";
  if (!word.startsWith("@")) return null;
  const q = word.slice(1);
  // Handles are the nick alphabet; anything else means this isn't a handle being typed.
  return /^[a-z0-9_-]*$/i.test(q) ? q.toLowerCase() : null;
}

/** The color for a chat/roster nick: YOU render bright + bold, everyone else shares one
 *  color (`C.nick`), so your own handle is the only thing that stands out. */
function nickProps(isSelf: boolean): { color: string; bold?: boolean } {
  return isSelf ? { color: C.fgBright, bold: true } : { color: C.nick };
}

/** Render a marketplace event as a single transcript-style line. */
function fmtMarket(m: ServerMarketplaceMessage): string {
  switch (m.type) {
    case "expert_ok":
      return `listed as expert @ $${m.rate}/min (${m.topics.join(", ") || "any topic"})`;
    case "expert_off":
      return "no longer listed as an expert";
    case "summon_pending":
      return m.target
        ? `call sent to ${m.target} — waiting for them to accept…`
        : `call sent to ${m.candidates} expert(s) — waiting…`;
    case "no_experts":
      return `no experts available under $${m.maxRate}/min${m.topic ? ` for ${m.topic}` : ""}`;
    case "summon_request":
      return m.free
        ? `⚡ ${m.from} needs help${m.topic ? ` (${m.topic})` : ""} — FREE CALL (no payout) up to ${m.maxMinutes}min: "${m.problem}" — /accept`
        : `⚡ ${m.from} needs help${m.topic ? ` (${m.topic})` : ""} @ $${m.rate}/min up to ${m.maxMinutes}min: "${m.problem}" — /accept`;
    case "summon_closed":
      return "an offer closed";
    case "session_start":
      return m.free
        ? `session #${m.sessionId} with ${m.peer} — FREE CALL (cap ${m.maxMinutes}min) — /end to finish`
        : `session #${m.sessionId} with ${m.peer} @ $${m.rate}/min (cap ${m.maxMinutes}min) — /end to finish`;
    case "session_end":
      return `session #${m.sessionId} ended: ${m.minutes}min, ${m.role === "seeker" ? `you paid ${usd(m.chargeCents)}` : `you earned ${usd(m.payoutCents)}`}`;
    case "expert_list":
      return m.experts.length === 0
        ? "no experts listed"
        : `experts: ${m.experts.map((e) => `${e.user} $${e.rate}/min${e.online ? "" : " (offline)"}`).join(", ")}`;
    // Rendered by dedicated tabs, not the log — captured before this in subscribe.
    case "bounty_list":
      return "";
    case "session_list":
      return "";
    case "earnings":
      return `lifetime earnings ${usd(m.lifetimeCents)} over ${m.sessions} session(s)`;
    case "bounty_posted":
      return `bounty #${m.bountyId} posted (${usd(m.priceCents)} held) — waiting for an expert to claim`;
    case "bounty_offer":
      return `💰 bounty #${m.bountyId} from ${m.from}${m.topic ? ` (${m.topic})` : ""} — ${usd(m.priceCents)}: "${m.question}" — /claim ${m.bountyId}`;
    case "bounty_claimed":
      return `claimed bounty #${m.bountyId} (${usd(m.priceCents)}) — answer with /answer ${m.bountyId} <text>`;
    case "bounty_answered":
      return `📩 bounty #${m.bountyId} answered by ${m.from} (${usd(m.priceCents)}): "${m.answer}" — /approve ${m.bountyId} or /reject ${m.bountyId}`;
    case "bounty_expired":
      return `bounty #${m.bountyId} expired — your ${usd(m.priceCents)} hold was released, no charge`;
    case "system":
      return m.text;
  }
}

/** The plain (unstyled) text a lounge row renders as — used to measure how many rows it
 *  wraps to. MUST mirror {@link ChatRow}'s output exactly, or the window over-/under-fills. */
function chatLineText(l: ChatLine): string {
  const time = hhmm(l.ts);
  if (l.kind === "system") return `${time} -!- ${l.text}`;
  return `${time} <${l.from ?? ""}> ${l.text}`;
}

/** A DM message's sender label (the same rule {@link DmsBody}'s thread view renders):
 *  "me" for my own lines, the peer's display name for theirs. */
function dmSenderLabel(dm: DmControllerState | null, from: string): string {
  const active = dm?.active ?? null;
  if (active?.self && from === active.self) return "me";
  if (from === dm?.activePeer) return (dm?.activeLabel ?? from) || from;
  return from;
}

/** The plain text a DM thread row renders as — mirrors {@link DmsBody}'s thread map for
 *  wrap measurement. */
function dmLineText(l: DmLine, senderOf: (from: string) => string): string {
  const body = l.undecryptable ? "[can't decrypt]" : `${l.text}${l.pending ? " …" : ""}`;
  return ` <${senderOf(l.from)}> ${body}`;
}

/** Split-screen lounge + paid-marketplace command surface. */
export function App({
  client,
  marketplace: initialMarketplace,
  user: initialUser,
  token: initialToken,
  session,
  onCall,
  dmController: initialDmController,
  staticInput,
  notice: initialNotice,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<LoungeState>(client.getState());
  const [dmController, setDmController] = useState<DmController | undefined>(initialDmController);
  const [dmState, setDmState] = useState<DmControllerState | null>(
    initialDmController?.getState() ?? null,
  );
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string>(initialNotice ?? IDLE_HINT);
  const [mktLog, setMktLog] = useState<string[]>([]);
  // Identity/session state is mutable so /login and /logout work in place.
  const [user, setUser] = useState<string | null>(initialUser);
  const [token, setToken] = useState<string | null>(initialToken ?? null);
  const [marketplace, setMarketplace] = useState<MarketplaceClient | undefined>(initialMarketplace);
  const [pendingLogin, setPendingLogin] = useState<{ pairingId: string } | null>(null);
  // A verified user's /nick asks for confirmation before changing the saved name.
  const [pendingNick, setPendingNick] = useState<{ name: string } | null>(null);
  // ---- tabbed navigation (docs/UI-EXPLORATION.md, steps 1–2) ----
  const [activeTab, setActiveTab] = useState<TabId>("lounge");
  const [selection, setSelection] = useState(0);
  // Scrollback position for the two id-anchored transcripts. `null` = pinned to the
  // newest line (stick-to-bottom); otherwise the id of the line on the bottom visible
  // row. Anchoring on an id (not a row count) keeps the view put even as the client's
  // capped ring drops old lines off the top (scroll.ts). The lounge anchor resets on
  // tab switch; the DM anchor resets when the open thread changes (effects below).
  const [loungeAnchor, setLoungeAnchor] = useState<string | null>(null);
  const [dmAnchor, setDmAnchor] = useState<string | null>(null);
  // Highlighted row in the `/` command autocomplete menu.
  const [paletteSel, setPaletteSel] = useState(0);
  // Highlighted row in the `@` mention menu, and the draft an Esc dismissed it against.
  const [mentionSel, setMentionSel] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
  // Lounge roster focus (Ctrl+U). The selection is keyed by HANDLE, not index: the roster
  // reorders live as presence changes, so an index would slide the highlight onto someone
  // else between keypresses — and Enter would then DM the wrong person.
  const [loungeFocus, setLoungeFocus] = useState<LoungeFocus>("composer");
  const [rosterSelUser, setRosterSelUser] = useState<string | null>(null);
  const [rosterMenuOpen, setRosterMenuOpen] = useState(false);
  const [rosterMenuSel, setRosterMenuSel] = useState(0);
  // DMs "compose a new DM" mode: the inbox's "+ Send new DM" row switches the bottom
  // bar to an "@username …" composer. Cleared when a thread opens or we leave the tab.
  const [dmComposeNew, setDmComposeNew] = useState(false);
  const [experts, setExperts] = useState<ExpertCard[]>([]);
  const [bounties, setBounties] = useState<BountyCard[]>([]);
  const [sessions, setSessions] = useState<SessionCard[]>([]);
  // When set, the next /review targets this specific session (chosen in the Calls
  // tab) instead of the client's last-ended one.
  const [reviewTarget, setReviewTarget] = useState<{ sessionId: number; peer: string } | null>(
    null,
  );
  // The summon-confirm view (design 2a): rendered in place of the Experts body when an
  // expert's [summon] is activated. Not a tab — a body-state gated on the Experts tab.
  const [summonExpert, setSummonExpert] = useState<ExpertCard | null>(null);
  // Live in-call meter (design 2a bars + status line). Captured on `session_start`,
  // cleared on `session_end`; the estimate rides connected minutes only. The edge stays
  // the billing authority — this is the local at-a-glance readout.
  const [call, setCall] = useState<{ sessionId: number; peer: string; rate: number } | null>(null);
  const [callSecs, setCallSecs] = useState(0);
  useEffect(() => {
    if (!call || staticInput) return;
    const id = setInterval(() => setCallSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [call, staticInput]);

  useEffect(() => {
    setState(client.getState());
    return client.subscribe((next) => setState({ ...next }));
  }, [client]);

  useEffect(() => {
    if (!dmController) return;
    setDmState(dmController.getState());
    return dmController.subscribe((next) => setDmState({ ...next }));
  }, [dmController]);

  // The open DM thread is "read" only while it's actually on-screen — i.e. the DMs tab
  // is active AND a thread is open (not the inbox). Off it, incoming messages accumulate
  // as unread (the badge lights up); back on the thread, they mark read.
  useEffect(() => {
    dmController?.setFocused(activeTab === "dms" && Boolean(dmState?.activePeer));
  }, [dmController, activeTab, dmState?.activePeer]);

  // Opening a different thread (or closing to the inbox) starts that conversation pinned
  // to its newest message — a stale scroll position from another peer would be confusing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keys off the peer only.
  useEffect(() => {
    setDmAnchor(null);
  }, [dmState?.activePeer]);

  // DM notifications are PUSH, not polled: hold a presence socket and refresh the inbox
  // only when the edge nudges us that a DM arrived (the same channel the daemon uses for
  // desktop toasts). One initial refresh shows any unread at launch. No `session`/token
  // (e.g. tests) → no subscription; the daemon still raises desktop toasts when running.
  useEffect(() => {
    if (!dmController) return;
    void dmController.refreshInbox();
    if (!session || !token) return;
    const notify = new PresenceNotifyClient({
      wsBase: session.wsBase,
      clientId: session.clientId,
      token,
      onDmNotify: () => void dmController.refreshInbox(),
    });
    notify.connect();
    return () => notify.close();
  }, [dmController, session, token]);

  // The SERVER decides who you are. If we hold saved credentials but the lounge says this
  // socket is unverified, that token is dead (expired, or issued by another environment):
  // stand down to guest instead of keeping a marketplace socket whose every frame the edge
  // answers with "sign in first" — which is exactly how one stale token turned each tab
  // switch into another line of rejection spam.
  useEffect(() => {
    if (!user || state.self === null || state.verified) return;
    marketplace?.close();
    setMarketplace(undefined);
    dmController?.close();
    setDmController(undefined);
    setUser(null);
    setToken(null);
    // NB: the saved credentials are deliberately left on disk. They carry no host, so a
    // prod token pointed at a local `wrangler dev` also lands here — deleting them would
    // throw away a working session just because you ran the edge locally.
    setNotice("This session isn't valid on this server — /login to sign back in.");
  }, [user, state.self, state.verified, marketplace, dmController]);

  useEffect(() => {
    if (!marketplace) return;
    return marketplace.subscribe((m) => {
      // The Experts / Bounties tabs render these lists directly, not in the log.
      if (m.type === "expert_list") {
        setExperts(m.experts);
        return;
      }
      if (m.type === "bounty_list") {
        setBounties(m.bounties);
        return;
      }
      if (m.type === "session_list") {
        setSessions(m.sessions);
        return;
      }
      setMktLog((log) => {
        // Collapse an immediate repeat: a rejected request retried on every tab switch
        // stacked identical lines until the log filled the pane. One is the information.
        const line = fmtMarket(m);
        return log.at(-1) === line ? log : [...log, line].slice(-MKT_LOG_MAX);
      });
      // Opening a session pops the relay-only audio call page in the browser + starts
      // the local in-call meter shown in both status bars, and records call.json so the
      // presence daemon can render the same meter in the Claude Code status line.
      if (m.type === "session_start") {
        // A free/comped call bills $0 — show the meter, status line, and call page as
        // $0.00 rather than accruing the expert's real per-minute rate (honest UX;
        // the edge is still the billing authority and settles it at $0).
        const meterRate = m.free ? 0 : m.rate;
        setCall({ sessionId: m.sessionId, peer: m.peer, rate: meterRate });
        setCallSecs(0);
        writeCallState({ peer: m.peer, rate: meterRate, startedAt: Date.now() });
        if (session && token) {
          openUrl(
            `${session.httpBase}/call#session=${m.sessionId}&token=${token}&rate=${meterRate}`,
          );
        } else {
          onCall?.(m.sessionId, meterRate);
        }
      }
      // Ending it stops the meter (the ended session lands in the Calls tab to rate).
      if (m.type === "session_end") {
        setCall(null);
        writeCallState(null);
      }
    });
  }, [marketplace, session, token, onCall]);

  // ---- identity: /login (guest → verified) and /logout (verified → guest) ----
  const doLogin = (): void => {
    if (user) {
      setNotice(`Already signed in as ${user}.`);
      return;
    }
    if (!session) {
      setNotice("Login isn't available here.");
      return;
    }
    setNotice("Opening your browser — sign in with GitHub…");
    void beginLogin().then((start) => {
      if (!start) {
        setNotice("Couldn't reach the edge to start login.");
        return;
      }
      setPendingLogin({ pairingId: start.pairingId });
      // Code entry uses the Lounge input; force it so capture works even when
      // login was started from the Me tab (tabs are frozen while pending).
      setActiveTab("lounge");
      setNotice("Paste the one-time code from your browser and press Enter (or /cancel).");
    });
  };

  const finishLogin = (code: string): void => {
    if (!pendingLogin || !session) return;
    const { pairingId } = pendingLogin;
    setNotice("Verifying…");
    void submitLoginCode(pairingId, code).then((outcome) => {
      setPendingLogin(null);
      if (!outcome.ok) {
        setNotice(
          outcome.reason === "pending"
            ? "Sign-in isn't finished yet — /login to retry."
            : `Login ${outcome.reason} — /login to retry.`,
        );
        return;
      }
      const creds = outcome.credentials;
      writeCredentials(creds);
      setUser(creds.githubLogin);
      setToken(creds.token);
      client.reauthenticate(creds.token); // rejoin the lounge as the verified identity
      // Hot-attach the paid marketplace so /summon, /expert, … work without a restart.
      marketplace?.close();
      const mkt = new MarketplaceClient({
        wsBase: session.wsBase,
        clientId: session.clientId,
        token: creds.token,
      });
      mkt.connect();
      setMarketplace(mkt);
      // Hot-attach DMs too (login-only): the DMs tab lights up without a restart.
      if (session) {
        setDmController(
          createDmController({
            wsBase: session.wsBase,
            httpBase: session.httpBase,
            token: creds.token,
          }),
        );
      }
      setNotice(`Signed in as ${creds.githubLogin} ✓ — marketplace unlocked.`);
    });
  };

  const doLogout = (): void => {
    if (!user) {
      setNotice("You're already browsing as a guest.");
      return;
    }
    clearCredentials();
    marketplace?.close();
    setMarketplace(undefined);
    dmController?.close();
    setDmController(undefined);
    if (activeTab === "dms") setActiveTab("lounge"); // don't strand the user on a dead tab
    setUser(null);
    setToken(null);
    client.reauthenticate(undefined); // rejoin as an anonymous guest
    setNotice("Logged out — you're a guest now. /login to sign back in.");
  };

  const handleMarket = (command: Command): void => {
    if (!marketplace || !user) {
      setNotice("Sign in with /login to use the marketplace.");
      return;
    }
    switch (command.kind) {
      case "expert":
        if (command.on) {
          const topics = (command.topics ?? []).flatMap((t) => {
            const parsed = TopicTag.safeParse(t);
            return parsed.success ? [parsed.data] : [];
          });
          marketplace.expertOn(command.rate ?? 0, topics);
        } else {
          marketplace.expertOff();
        }
        return;
      case "summon":
        marketplace.summon({
          problem: command.problem,
          ...(command.maxRate !== undefined ? { maxRate: command.maxRate } : {}),
          ...(command.target ? { target: command.target } : {}),
          ...(command.code ? { code: command.code } : {}),
        });
        setNotice(
          command.code
            ? `Calling ${command.target} (free call)…`
            : command.target
              ? `Calling ${command.target}…`
              : "Looking for an expert…",
        );
        return;
      case "accept":
        if (!marketplace.accept(command.reqId)) setNotice("No pending offer to accept.");
        return;
      case "decline":
        if (!marketplace.decline(command.reqId)) setNotice("No pending offer to decline.");
        return;
      case "end":
        marketplace.end();
        return;
      case "review": {
        // If the Calls tab picked a session, review THAT one; else the last-ended.
        const ok = marketplace.review(command.stars, command.text, reviewTarget?.sessionId);
        if (!ok) {
          setNotice("No ended session to review yet — pick one in the Calls tab.");
        } else if (reviewTarget) {
          setNotice(`Rating ${reviewTarget.peer}…`);
          setReviewTarget(null);
          marketplace.mySessions(); // refresh so the row flips to "reviewed"
        }
        return;
      }
      case "experts":
        marketplace.experts();
        return;
      case "earnings":
        marketplace.earnings();
        return;
      case "dispute":
        marketplace.dispute(command.sessionId, command.reason);
        setNotice("Filing dispute…");
        return;
      case "bounty":
        marketplace.bountyPost(command.priceCents, command.question);
        setNotice("Posting bounty…");
        return;
      case "claim":
        marketplace.bountyClaim(command.bountyId);
        return;
      case "bounty_answer":
        marketplace.bountyAnswer(command.bountyId, command.answer);
        return;
      case "bounty_accept":
        marketplace.bountyAccept(command.bountyId);
        return;
      case "bounty_reject":
        marketplace.bountyReject(command.bountyId);
        return;
    }
  };

  // Open a DM thread (and optionally send a first line): the `/dm <user>` command, a
  // clicked username, or Enter on a thread row all funnel here. Login-gated.
  const openDm = (peer: string, message?: string): void => {
    if (!dmController || !user) {
      setNotice("Sign in with /login to send direct messages.");
      return;
    }
    setActiveTab("dms");
    setSelection(0);
    setDmComposeNew(false);
    void dmController.openThread(peer).then(() => {
      if (message) dmController.sendMessage(message);
      // The thread + safety number now render in the pane; drop the transient notice
      // so it doesn't linger as if still loading.
      setNotice((n) => (n === `Opening DM with ${peer}…` ? "" : n));
    });
    setNotice(`Opening DM with ${peer}…`);
  };

  // "+ Send new DM" composer submit: parse `@handle [message…]` (a leading @ is optional),
  // then open/create that thread — reusing openDm so it lands in the thread view with the
  // [@handle] prompt. An empty handle just keeps the composer up with a hint.
  const startNewDm = (line: string): void => {
    const trimmed = line.trim().replace(/^@/, "");
    const sp = trimmed.search(/\s/);
    const handle = (sp === -1 ? trimmed : trimmed.slice(0, sp)).trim();
    const message = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
    if (!handle) {
      setNotice('Type "@username" (optionally followed by a message) to start a DM.');
      return;
    }
    openDm(handle, message || undefined);
  };

  // "‹ see all DMs" / Esc: return to the inbox. From the composer, just cancel it; from a
  // thread, close it (keeps the controller alive and reloads the inbox).
  const dmBack = (): void => {
    setDraft("");
    if (dmComposeNew) {
      setDmComposeNew(false);
      setNotice("");
      return;
    }
    if (dmState?.activePeer) {
      dmController?.closeThread();
      setSelection(0);
    }
  };

  const submit = (line: string): void => {
    // While a login is pending, the input captures the pasted code, not chat.
    if (pendingLogin) {
      const entry = line.trim();
      if (entry === "" || entry === "/cancel") {
        setPendingLogin(null);
        setNotice("Login cancelled.");
        return;
      }
      finishLogin(entry);
      return;
    }
    // While a nick change is pending, the input captures the [Y/n] answer.
    // Default (Enter) confirms; the server stays the availability authority.
    if (pendingNick) {
      const name = pendingNick.name;
      setPendingNick(null);
      if (confirmsYes(line)) {
        // The server confirms (or rejects) with an in-chat system line, so point the
        // user there rather than leaving a notice that looks stuck.
        client.setNick(name);
        setNotice("Name change sent — see the chat for confirmation.");
      } else {
        setNotice("Name change cancelled.");
      }
      return;
    }
    const command = parseCommand(line);
    if (!command) return;
    switch (command.kind) {
      case "message":
        // Anyone connected can post — anonymous guests included. Paid actions
        // (below, via handleMarket) still require a signed-in identity.
        client.sendMessage(command.text);
        // Clear any lingering status (e.g. the multi-line /help block) once you send —
        // otherwise it hangs around on screen after you've moved on to chatting.
        setNotice("");
        break;
      case "dm":
        openDm(command.user, command.message);
        break;
      case "login":
        doLogin();
        break;
      case "logout":
        doLogout();
        break;
      case "whoami":
        setNotice(
          user
            ? `Signed in as ${user} ✓`
            : `Guest: ${state.self ?? "connecting…"} — /login to claim a name`,
        );
        break;
      case "dashboard":
        setNotice("Opening your dashboard…");
        void dashboardNotice().then(setNotice);
        break;
      case "card":
        setNotice("Fetching your card link…");
        void billingLinkNotice("card").then(setNotice);
        break;
      case "onboard":
        setNotice("Fetching expert onboarding…");
        void billingLinkNotice("onboard").then(setNotice);
        break;
      case "nick": {
        const intent = nickIntent(command.name, Boolean(user));
        if (intent.kind === "invalid") {
          setNotice(intent.message);
          return;
        }
        if (intent.kind === "confirm") {
          // Verified: confirm before changing the SAVED display name (identity handle
          // stays fixed). The server re-checks availability and may still reject.
          setPendingNick({ name: intent.name });
          setNotice(`Change nick name from ${state.self ?? user} → ${intent.name}? [Y/n]`);
          return;
        }
        client.setNick(intent.name); // guest: session-only, applied immediately
        break;
      }
      case "join": {
        const room = RoomName.safeParse(command.room);
        if (!room.success) {
          setNotice(`Unknown room. Try: ${LOUNGE_ROOMS.join(", ")}`);
          return;
        }
        client.switchRoom(room.data);
        setNotice(`Joined #${room.data}.`);
        break;
      }
      case "topic": {
        const tag = TopicTag.safeParse(command.tag);
        if (!tag.success) {
          setNotice("Unknown topic tag.");
          return;
        }
        client.setTopic(tag.data);
        setNotice(`Topic set to ${tag.data}.`);
        break;
      }
      case "report": {
        if (!user) {
          setNotice("Sign in with /login to report someone.");
          return;
        }
        if (!command.user) {
          setNotice("Usage: /report <user>");
          return;
        }
        client.report(command.user);
        setNotice(`Reported ${command.user}.`);
        break;
      }
      case "rooms": {
        const others = LOUNGE_ROOMS.filter((r) => r !== state.room);
        setNotice(
          others.length
            ? `You're in #${state.room} · switch with /join <room>: ${others.join(", ")}`
            : `You're in #${state.room} — the only room right now.`,
        );
        break;
      }
      case "who": {
        const names = fmtMembers(state.members).join(", ") || "(nobody here yet)";
        const n = state.members.length;
        setNotice(
          n > 0
            ? `#${state.room} · ${n} here: ${names} · /dm <name> to message`
            : `#${state.room} · nobody here yet — say hi to break the ice.`,
        );
        break;
      }
      case "help":
        setNotice(HELP_LINES.join("  "));
        break;
      case "quit":
        writeCallState(null); // don't leave a stale meter in the status line
        marketplace?.close();
        client.close();
        exit();
        break;
      case "invalid":
        setNotice(command.reason);
        break;
      case "unknown":
        setNotice(`Unknown command: /${command.name}. Try /help.`);
        break;
      default:
        handleMarket(command);
        break;
    }
  };

  // The name to render for "me": prefer the server's effective (display) name —
  // it's what the roster + message `from` carry, so after `/nick` self-highlighting
  // and the status bar match "chef" instead of the stored GitHub handle. `user` is
  // still the sign-in/verified gate everywhere else; this is display only.
  const who = state.self ?? user;
  // Total unread DMs across threads — drives the DMs-tab highlight + a status-line
  // count (the in-app "you have DMs" cue that needs no presence daemon).
  const dmUnread = (dmState?.threads ?? []).reduce((n, t) => n + t.unread, 0);
  // Which DMs sub-view is showing: an open thread wins; else the "new DM" composer if
  // armed; else the inbox (DM-IMPROVEMENTS.md). Used for input/nav/hit-test routing.
  const dmView: DmView = dmState?.activePeer ? "thread" : dmComposeNew ? "new" : "inbox";
  const dmThreadCount = dmState?.threads.length ?? 0;
  const { rows, cols } = useTerminalSize();
  // The inbox's relative-time labels tick while the inbox is on-screen (gated, so no
  // idle repaint elsewhere / under tests).
  const now = useNow(staticInput !== true && activeTab === "dms" && dmView === "inbox");

  // `/` command autocomplete — only for the lounge command line (not a pending
  // login/nick prompt, the summon-confirm, or a DM message). Open iff the draft is a bare
  // command prefix that matches something; the menu captures ↑/↓/Tab/Enter/Esc.
  const paletteMatches: readonly CommandInfo[] =
    activeTab === "lounge" && !summonExpert && !pendingLogin && !pendingNick
      ? matchCommands(draft)
      : [];
  const paletteOpen = paletteMatches.length > 0;
  const palSel = paletteOpen ? Math.min(paletteSel, paletteMatches.length - 1) : 0;

  // `@` mention autocomplete — the same idea as the `/` menu, over who's actually in the
  // room. Matches on the LAST word of the draft (the composer only ever appends, so the
  // word being typed is the trailing one) and never on yourself. Dismissed with Esc: the
  // dismissal is remembered against that exact draft, so the menu doesn't spring straight
  // back on the next render but does return as soon as you type another character.
  const mentionQuery = mentionPrefix(draft);
  const mentionMatches: readonly string[] =
    activeTab === "lounge" &&
    !summonExpert &&
    !pendingLogin &&
    !pendingNick &&
    !paletteOpen &&
    // Composer only. Ctrl+U doesn't clear the draft, so a half-typed `@bob` would
    // otherwise keep the mention menu alive underneath roster focus — and since the
    // mention branch sits above the roster branch in the reducer, ↑/↓ would drive the
    // wrong list. (The branch ORDER is load-bearing: it's what lets Tab complete a
    // mention while still switching windows from roster focus. Gate here, not there.)
    loungeFocus === "composer" &&
    mentionQuery !== null &&
    mentionDismissed !== draft
      ? state.members
          .map((m) => m.user)
          .filter((u) => u !== who && u.toLowerCase().startsWith(mentionQuery))
          .slice(0, 8)
      : [];
  const mentionOpen = mentionMatches.length > 0;
  const mentionIdx = mentionOpen ? Math.min(mentionSel, mentionMatches.length - 1) : 0;

  // ---- Me tab: account actions as a selectable, Enter-activatable list ----
  const meActions: { label: string; run: () => void }[] = user
    ? [
        {
          label: "Open web dashboard",
          run: () => {
            setNotice("Opening your dashboard…");
            void dashboardNotice().then(setNotice);
          },
        },
        {
          label: "Manage payment card",
          run: () => {
            setNotice("Fetching your card link…");
            void billingLinkNotice("card").then(setNotice);
          },
        },
        {
          label: "Expert onboarding",
          run: () => {
            setNotice("Fetching expert onboarding…");
            void billingLinkNotice("onboard").then(setNotice);
          },
        },
        { label: "Log out", run: doLogout },
      ]
    : [
        { label: "Log in with GitHub", run: doLogin },
        {
          label: "Who am I?",
          run: () => setNotice(`Guest: ${state.self ?? "connecting…"} — /login to claim a name`),
        },
      ];

  // Selectable-item count for the active tab (0 = nothing to select). `sel` is the
  // highlight, clamped here so an async `expert_list`/`bounty_list` shrinking the
  // list can't leave the highlight (or an Enter-activate) at a stale index. The
  // Bounties tab has one extra row past the list: the "Post a bounty" action.
  const itemCount =
    activeTab === "experts"
      ? experts.length
      : activeTab === "bounties"
        ? bounties.length + 1
        : activeTab === "calls"
          ? sessions.length
          : activeTab === "me"
            ? meActions.length
            : activeTab === "dms"
              ? // Inbox is a list of [+ Send new DM, ...threads]; thread/new have no list.
                dmView === "inbox"
                ? 1 + dmThreadCount
                : 0
              : 0;
  const sel = itemCount > 0 ? Math.min(selection, itemCount - 1) : 0;

  // Roster focus/menu teardown, shared by Esc, tab switches, and every menu action. The
  // help line only gets restored if we were actually in roster focus, so an unrelated tab
  // switch can't wipe a notice someone else just set.
  const closeRosterFocus = (): void => {
    if (loungeFocus === "roster") setNotice(IDLE_HINT);
    setLoungeFocus("composer");
    setRosterMenuOpen(false);
    setRosterMenuSel(0);
  };

  const switchTab = (tab: TabId): void => {
    setActiveTab(tab);
    setSelection(0);
    setLoungeAnchor(null); // re-pin the lounge to the newest line on every tab switch
    closeRosterFocus(); // leaving the Lounge hands the keyboard back to the composer
    setSummonExpert(null); // leaving Experts abandons an open summon-confirm
    // Refresh a tab's data on entry — but ONLY when signed in. A guest (or a stale
    // token) has a marketplace socket the edge answers with "sign in first" for every
    // frame, so an un-gated refresh spammed that rejection into the log on each tab
    // switch. The tabs already render their own sign-in wall; nothing to fetch.
    if (marketplace && user) {
      if (tab === "experts") marketplace.experts(); // refresh the directory on entry
      if (tab === "bounties") marketplace.bounties(); // refresh the board on entry
      if (tab === "calls") marketplace.mySessions(); // refresh your sessions on entry
    }
    if (tab === "dms") {
      // Land on the inbox ("show all my DMs"): close any open thread and cancel compose.
      // closeThread() also reloads the inbox; if signed out there's nothing to close.
      setDmComposeNew(false);
      if (dmController) dmController.closeThread();
    }
  };

  // Activate an item by (tab, index) so the keyboard (Enter on the highlight) and the
  // mouse (click a row) share ONE path. `index` is explicit because a click can't
  // rely on the async `selection` state having caught up.
  const activate = (tab: TabId, index: number): void => {
    if (tab === "experts") {
      const e = experts[index];
      if (!e) return;
      if (!marketplace || !user) {
        setNotice("Sign in with /login to call an expert.");
        return;
      }
      if (!e.online) {
        setNotice(`${e.user} is offline — post an async bounty: /bounty <price> <question>.`);
        return;
      }
      // Open the summon-confirm view (design 2a): the seeker reviews the hold, types the
      // problem into the input line, and authorizes. Confirm dispatches a targeted summon.
      setSummonExpert(e);
      setDraft("");
      setNotice(`Describe your problem, then Enter to authorize the hold for ${e.user}.`);
      return;
    }
    if (tab === "bounties") {
      if (!marketplace || !user) {
        setNotice("Sign in with /login to use bounties.");
        return;
      }
      // The last row is the "Post a bounty" action; earlier rows claim a bounty.
      if (index >= bounties.length) {
        setDraft("/bounty ");
        setActiveTab("lounge");
        setSelection(0);
        setNotice("Type: /bounty <price> <question> then Enter to post.");
        return;
      }
      const b = bounties[index];
      if (!b) return;
      marketplace.bountyClaim(b.bountyId);
      setNotice(`Claiming bounty #${b.bountyId} (${usd(b.priceCents)}) — answer with /answer.`);
      return;
    }
    if (tab === "calls") {
      const s = sessions[index];
      if (!s) return;
      if (s.reviewed) {
        setNotice(`You already reviewed session #${s.sessionId} (${s.peer}).`);
        return;
      }
      if (!s.reviewable) {
        setNotice("You can only review a paid call you completed as the seeker.");
        return;
      }
      // Target this session, then hand off to the Lounge input for the star rating.
      setReviewTarget({ sessionId: s.sessionId, peer: s.peer });
      setDraft("/review ");
      setActiveTab("lounge");
      setSelection(0);
      setNotice(`Rate ${s.peer} (session #${s.sessionId}): type /review <1-5> [comment].`);
      return;
    }
    if (tab === "me") meActions[index]?.run();
    if (tab === "dms") {
      if (!dmController || !user) {
        setNotice("Sign in with /login to send direct messages.");
        return;
      }
      // Inbox convention: index 0 = "+ Send new DM"; index ≥1 = threads[index-1].
      if (index === 0) {
        setDmComposeNew(true);
        setDraft("");
        setNotice('New DM — type "@username" then your message, Enter to send. Esc to cancel.');
        return;
      }
      const thread = dmState?.threads[index - 1];
      if (thread) {
        setDmComposeNew(false);
        setDraft("");
        void dmController?.openThread(thread.peer);
      }
    }
  };

  // Authorize the hold from the summon-confirm view: a TARGETED summon at the expert's
  // rate with the typed problem. Returns to the Lounge so the pending/accept lines show.
  const confirmSummon = (): void => {
    const e = summonExpert;
    if (!e) return;
    if (!marketplace || !user) {
      setNotice("Sign in with /login to call an expert.");
      return;
    }
    const problem = draft.trim();
    if (!problem) {
      setNotice("Describe your problem first, then Enter to authorize the hold.");
      return;
    }
    marketplace.summon({ problem, maxRate: e.rate, target: e.user });
    setSummonExpert(null);
    setDraft("");
    setActiveTab("lounge");
    setSelection(0);
    setNotice(`Calling ${e.user} @ ≤ $${e.rate}/min…`);
  };

  // ---- scroll geometry: row budgets + windows shared by the wheel/key handlers AND
  //      the render below, so a scroll and its redraw always agree on what fits. ----
  const contentRows = Math.max(1, rows - 1);
  // The marketplace log belongs to the marketplace tabs. It used to render everywhere,
  // so a rejection picked up on the Experts tab followed you back into the Lounge and sat
  // over the chat until restart — money/status events are only meaningful next to the
  // surface that produced them.
  const showMktLog = mktLog.length > 0 && MARKET_TABS.has(activeTab);
  const mktRows = showMktLog ? mktLog.length + 1 : 0;
  // Footer chrome = the horizontal rule (1) + the notice line + the input/hint line. The
  // notice can wrap (the long help text is 2 rows on a narrow terminal), so measure it the
  // same way it draws instead of guessing — otherwise a 2-row notice overflows the box and
  // corrupts the redraw (the very bug this whole change fixes for the transcript).
  const noticeRows = wrappedRows(
    `[${state.self ?? user ?? "guest"}(✓)] ${notice}`,
    Math.max(1, cols),
  );
  // An open autocomplete menu draws BETWEEN the notice and the input, so its rows are
  // footer chrome too. Without this the transcript keeps its full budget, the column
  // overflows, and Ink silently drops interior rows to make it fit — messages vanish
  // mid-scrollback while a menu is open. (`CommandPalette` caps at 8 + an overflow hint;
  // `mentionMatches` is pre-sliced to 8.)
  const paletteRows =
    paletteMatches.length === 0
      ? 0
      : Math.min(paletteMatches.length, 8) + (paletteMatches.length > 8 ? 1 : 0);
  const footerReserve =
    1 /* rule */ + noticeRows + paletteRows + mentionMatches.length + 1; /* input/hint */
  // Content rows minus header chrome (title bar + window strip) and the footer, plus any
  // marketplace log. Mirrors the flex layout below; shared with the scroll windows and
  // hit-test's BODY_TOP.
  const baseVisible = Math.max(3, contentRows - 2 /* header */ - footerReserve - mktRows);
  // Sidebar ~22% of width (clamped); the chat column gets the rest, minus a 1-col margin.
  const sidebarWidth = Math.min(26, Math.max(14, Math.floor(cols * 0.22)));

  // Lounge transcript, id-anchored (ids coerced to string; the client numbers lines).
  // WRAP-AWARE: a ChatRow that wraps spans >1 terminal row, so we window by *rendered
  // rows* (measured exactly as Ink wraps — measure.ts), never by line count. Counting a
  // wrapped line as one row would overflow the fixed-height box and corrupt the redraw.
  const loungeColW = Math.max(8, cols - 1 /* margin */ - sidebarWidth);
  const loungeRowsOf = (l: ChatLine): number => wrappedRows(chatLineText(l), loungeColW);
  const loungeIds = state.lines.map((l) => String(l.id));
  const loungeRaw = rawOffsetForAnchor(loungeIds, loungeAnchor);
  // Probe with the full budget to learn if we're scrolled up; if so, reserve one row for
  // the "▾ N newer" hint so drawing it never pushes past the terminal height.
  const loungeProbe = windowByRows(state.lines, baseVisible, loungeRaw, loungeRowsOf);
  const loungeVisibleRows = Math.max(3, baseVisible - (loungeProbe.hiddenBelow > 0 ? 1 : 0));
  const loungeWin = windowByRows(state.lines, loungeVisibleRows, loungeRaw, loungeRowsOf);

  // Roster sidebar. It used to be a static top-slice (it wasn't selectable, and members
  // reorder as presence changes) — with Ctrl+U focus it has to scroll to follow the
  // highlight, so it windows like the list tabs. The selection is stored as a handle and
  // resolved to an index HERE, every render: if that person left, fall back to row 0.
  const rosterMembers = state.members;
  const rosterSel = Math.max(
    0,
    rosterMembers.findIndex((m) => m.user === rosterSelUser),
  );
  const rosterFocused = activeTab === "lounge" && loungeFocus === "roster";
  // The selected member's action menu (DM / tag / call), built per-person: you can't DM
  // yourself, and Call only exists for someone the marketplace lists as an online expert.
  const rosterMenuUser = rosterMembers[rosterSel]?.user ?? null;
  const rosterMenuExpert = rosterMenuUser
    ? (experts.find((e) => e.user === rosterMenuUser) ?? null)
    : null;
  const rosterMenuItems: RosterMenuItem[] = useMemo(() => {
    if (!rosterMenuUser) return [];
    const items: RosterMenuItem[] = [];
    if (rosterMenuUser !== who) items.push({ kind: "dm", label: "Send DM" });
    items.push({ kind: "tag", label: `Tag in #${state.room}` });
    if (rosterMenuExpert && rosterMenuUser !== who) {
      // Labels stay short: the sidebar is ~14–26 cells, and a label that wrapped would
      // eat a second row out of the budget these items are counted against.
      items.push(
        rosterMenuExpert.online
          ? { kind: "call", label: `Call $${rosterMenuExpert.rate}/min` }
          : // Same fallback the Experts tab gives for an offline expert: the async board.
            { kind: "bounty", label: "Post a bounty" },
      );
    }
    return items;
  }, [rosterMenuUser, rosterMenuExpert, who, state.room]);
  const rosterMenuIdx = rosterMenuItems.length
    ? Math.min(rosterMenuSel, rosterMenuItems.length - 1)
    : 0;
  // Row budget: the `#ROOM · N` header, the menu when it's open, and a `+N more` line
  // when the list overflows all come out of the sidebar's share of `baseVisible`, so the
  // column can never draw past the box. The window then follows the highlight.
  const rosterMenuRows = rosterMenuOpen ? rosterMenuItems.length : 0;
  const rosterCap = Math.max(1, baseVisible - 1 /* header */ - rosterMenuRows);
  const rosterRows = Math.max(
    1,
    rosterMembers.length > rosterCap ? rosterCap - 1 /* "+N more" */ : rosterCap,
  );
  // Modal geometry, computed HERE (not inside the component) because the click hit-tester
  // needs the same numbers: Ink has no absolute positioning, so the box is placed with an
  // explicit margin and its absolute rows are derived from that margin.
  const rosterMenuBox: RosterMenuBox | null = (() => {
    if (!rosterMenuOpen || rosterMenuItems.length === 0 || !rosterMenuUser) return null;
    const hint = "↑↓ choose · Enter run · Esc cancel";
    const inner = Math.max(
      rosterMenuUser.length + 4 /* "─ name ─" */,
      hint.length,
      ...rosterMenuItems.map((i) => i.label.length + 2 /* "› " */),
    );
    const width = Math.min(loungeColW, inner + 4 /* borders + padding */);
    const height = rosterMenuItems.length + 5; /* borders + title + rule + hint */
    const marginTop = Math.max(0, Math.floor((baseVisible - height) / 2));
    const marginLeft = Math.max(0, Math.floor((loungeColW - width) / 2));
    return {
      marginTop,
      marginLeft,
      width,
      hint,
      // Absolute 1-based cells for hit-testing: the first item sits below the top border
      // and the title row; items are the only clickable rows.
      itemTop: BODY_TOP + marginTop + 2,
      itemLeft: 1 + marginLeft + 1,
      itemWidth: Math.max(1, width - 2),
    };
  })();

  const rosterWinRaw = listWindow(rosterMembers.length, rosterRows, rosterSel);
  // The menu draws under the list, so while it's open scroll the window to END on the
  // selected member — the items then sit directly beneath the name they act on instead
  // of floating at the bottom of a long roster. (Rows below would otherwise shift under
  // the menu and desync the click regions.)
  const rosterWin =
    rosterMenuOpen && rosterWinRaw.count > 0
      ? {
          start: Math.min(
            Math.max(0, rosterSel - rosterWinRaw.count + 1),
            Math.max(0, rosterMembers.length - rosterWinRaw.count),
          ),
          count: rosterWinRaw.count,
        }
      : rosterWinRaw;
  const rosterHidden = rosterMembers.length - rosterWin.count;

  // Move the roster highlight by whole rows, remembering the HANDLE (not the index).
  // Resolve off the PREVIOUS handle inside the updater: a held arrow key fires several
  // keypresses inside one render, and reading `rosterSel` from this closure would make
  // them all step from the same stale row (they'd collapse into a single move).
  const moveRoster = (delta: number): void => {
    if (rosterMembers.length === 0) return;
    setRosterSelUser((prev) => {
      const from = Math.max(
        0,
        rosterMembers.findIndex((m) => m.user === prev),
      );
      const next = Math.min(Math.max(from + delta, 0), rosterMembers.length - 1);
      return rosterMembers[next]?.user ?? null;
    });
  };

  // Focus a roster row by index (a click, or Ctrl+U landing on the first row) and
  // optionally open its menu — keyboard and mouse share this one path.
  const focusRosterRow = (index: number, openMenu: boolean): void => {
    const m = rosterMembers[index];
    if (!m) return;
    setLoungeFocus("roster");
    setRosterSelUser(m.user);
    setRosterMenuSel(0);
    setRosterMenuOpen(openMenu);
    setNotice(
      openMenu
        ? `${m.user}: ↑↓ choose · Enter to run · Esc back to the roster`
        : "Roster: ↑↓ pick someone · Enter for actions · Esc back to chat",
    );
  };

  // Run the highlighted menu item. Every branch ends back at the composer — the menu is
  // a one-shot chooser, not a mode you linger in.
  const runRosterMenuItem = (item: RosterMenuItem | undefined, peer: string | null): void => {
    if (!item || !peer) return;
    closeRosterFocus();
    if (item.kind === "dm") {
      openDm(peer);
      return;
    }
    if (item.kind === "tag") {
      // Drop an `@handle` into the composer and hand typing back — the mention itself is
      // click/Enter-hittable in the transcript (docs/DMS.md entry point 3).
      setDraft((d) => (d.endsWith(" ") || d === "" ? `${d}@${peer} ` : `${d} @${peer} `));
      return;
    }
    if (item.kind === "bounty") {
      setDraft("/bounty ");
      setNotice(`${peer} is offline — post an async bounty: /bounty <price> <question>.`);
      return;
    }
    // call: reuse the Experts tab's summon-confirm rather than starting a hold from here.
    const e = experts.find((x) => x.user === peer);
    if (!e) return;
    if (!marketplace || !user) {
      setNotice("Sign in with /login to call an expert.");
      return;
    }
    setActiveTab("experts");
    setSelection(Math.max(0, experts.indexOf(e)));
    setSummonExpert(e);
    setDraft("");
    setNotice(`Describe your problem, then Enter to authorize the hold for ${e.user}.`);
  };

  // Open DM thread, same wrap-aware windowing over the FULL body width (no sidebar), with
  // tighter header chrome (back row + query line + a wrapping safety-number line).
  const dmThreadLines = dmState?.active?.lines ?? [];
  const dmColW = Math.max(8, cols);
  const dmRowsOf = (l: (typeof dmThreadLines)[number]): number =>
    wrappedRows(
      dmLineText(l, (from) => dmSenderLabel(dmState, from)),
      dmColW,
    );
  const dmIds = dmThreadLines.map((l) => String(l.id));
  const dmRaw = rawOffsetForAnchor(dmIds, dmAnchor);
  const dmThreadBase = Math.max(3, baseVisible - 3);
  const dmProbe = windowByRows(dmThreadLines, dmThreadBase, dmRaw, dmRowsOf);
  const dmThreadVisibleRows = Math.max(3, dmThreadBase - (dmProbe.hiddenBelow > 0 ? 1 : 0));
  const dmWin = windowByRows(dmThreadLines, dmThreadVisibleRows, dmRaw, dmRowsOf);

  // Re-anchor a transcript on the line that should sit on the bottom visible row for a
  // given item offset (null = pinned to the newest, so new messages keep the view live).
  const anchorAt = (ids: string[], offset: number, max: number): string | null => {
    const next = Math.min(Math.max(0, offset), Math.max(0, max));
    return next === 0 ? null : (ids[ids.length - 1 - next] ?? null);
  };
  // Apply a keyboard scroll intent to whichever transcript is focused.
  const scrollActive = (to: ScrollTo): void => {
    if (activeTab === "lounge") {
      const next = stepRowOffset(loungeWin.offset, loungeWin.maxOffset, loungeVisibleRows, to);
      setLoungeAnchor(anchorAt(loungeIds, next, loungeWin.maxOffset));
    } else if (activeTab === "dms" && dmView === "thread") {
      const next = stepRowOffset(dmWin.offset, dmWin.maxOffset, dmThreadVisibleRows, to);
      setDmAnchor(anchorAt(dmIds, next, dmWin.maxOffset));
    }
  };
  // Wheel: a notch nudges ~3 items in one shot (computed from the current offset, so a
  // multi-notch flick isn't collapsed by React batching the way repeated key steps are).
  const wheelActive = (dir: "up" | "down"): void => {
    const delta = dir === "up" ? 3 : -3;
    if (activeTab === "lounge") {
      setLoungeAnchor(anchorAt(loungeIds, loungeWin.offset + delta, loungeWin.maxOffset));
    } else if (activeTab === "dms" && dmView === "thread") {
      setDmAnchor(anchorAt(dmIds, dmWin.offset + delta, dmWin.maxOffset));
    }
  };

  // Mouse (step 3): route a left-click through the same region map the layout draws,
  // to the same `switchTab`/`activate` handlers the keyboard uses. The wheel scrolls the
  // transcript under the cursor. This is redefined each render (reading current values
  // via closure); `useMouse` keeps the latest in a ref and subscribes once.
  const handleMouse = (event: MouseEvent): void => {
    // Wheel: scroll the focused transcript (lounge log / open DM thread). ~3 items a notch
    // (smaller than a PageUp) matches typical terminal feel; list tabs follow selection.
    if (event.type === "scroll") {
      wheelActive(event.scroll === "up" ? "up" : "down");
      return;
    }
    if (event.type !== "down" || event.button !== "left") return;
    const regions = regionsForView({
      activeTab,
      cols,
      dmUnread,
      dmView,
      dmThreadCount,
      expertsCount: experts.length,
      meCount: meActions.length,
      bountiesCount: bounties.length,
      sessionsCount: sessions.length,
      // Mirror the on-screen list window so a click on a scrolled list maps to the true
      // index, not the screen row (scroll.ts + the body window props must agree).
      ...(activeListWin ? { listStart: activeListWin.start, listCount: activeListWin.count } : {}),
      // Same deal for the roster sidebar, which windows independently of the body.
      rosterCount: rosterMembers.length,
      sidebarWidth,
      rosterStart: rosterWin.start,
      rosterVisible: rosterWin.count,
      ...(rosterMenuBox
        ? {
            rosterMenu: {
              top: rosterMenuBox.itemTop,
              left: rosterMenuBox.itemLeft,
              width: rosterMenuBox.itemWidth,
              count: rosterMenuItems.length,
            },
          }
        : {}),
    });
    const target = hitTest(regions, event.x, event.y);
    if (!target) return;
    if (target.kind === "tab") {
      switchTab(target.tab);
    } else if (target.kind === "expert") {
      setSelection(target.index);
      activate("experts", target.index);
    } else if (target.kind === "me-action") {
      setSelection(target.index);
      activate("me", target.index);
    } else if (target.kind === "bounty") {
      setSelection(target.index);
      activate("bounties", target.index);
    } else if (target.kind === "bounty-post") {
      // The Post row is the sentinel index just past the list.
      activate("bounties", bounties.length);
    } else if (target.kind === "session") {
      setSelection(target.index);
      activate("calls", target.index);
    } else if (target.kind === "dm-row") {
      // Inbox row: index 0 = "+ Send new DM", ≥1 = open threads[index-1] (same as Enter).
      setSelection(target.index);
      activate("dms", target.index);
    } else if (target.kind === "dm-back") {
      dmBack();
    } else if (target.kind === "roster-row") {
      // Clicking a name = Ctrl+U onto that row + Enter: highlight them and open the menu.
      focusRosterRow(target.index, true);
    } else if (target.kind === "roster-menu") {
      // Clicking a menu row runs it, exactly as Enter on the highlight would.
      runRosterMenuItem(rosterMenuItems[target.index], rosterMenuUser);
    }
  };
  useMouse(staticInput !== true, handleMouse);

  // Raw-mode keypress handling is skipped in tests (no TTY). All key→action mapping
  // lives in the pure `reduceKey` reducer (unit-tested in test/nav.test.ts); this
  // just applies the resulting action to state + clients.
  useInput(
    (input, key) => {
      // Mouse reporting shares stdin: Ink surfaces a mouse chunk (ESC[<b;x;y M) as a
      // keypress whose `input` begins "[<". Swallow it here — `useMouse` handles the
      // real event — so it never lands in the chat draft.
      if (input.startsWith("[<") || input.startsWith("\x1b[<")) return;
      // The summon-confirm view (design 2a) captures the input line as the `problem`
      // field: type to edit, Enter authorizes the hold, Esc cancels back to Experts.
      if (summonExpert) {
        if (key.escape) {
          setSummonExpert(null);
          setNotice("Call cancelled.");
          return;
        }
        if (key.return) {
          confirmSummon();
          return;
        }
        if (key.backspace || key.delete) {
          setDraft((d) => d.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) setDraft((d) => d + input);
        return;
      }
      const action = reduceKey(
        {
          activeTab,
          selection: sel,
          itemCount,
          draft,
          locked: pendingLogin !== null,
          dmView,
          paletteOpen,
          mentionOpen,
          loungeFocus,
          rosterMenuOpen,
        },
        input,
        key,
      );
      switch (action.type) {
        case "switch-tab":
          switchTab(action.tab);
          break;
        case "move-selection":
          setSelection(action.selection);
          break;
        case "roster-focus":
          if (action.focus === "roster") {
            // Ctrl+U with nothing to select is a no-op rather than a mode you're stuck in.
            if (rosterMembers.length === 0) break;
            focusRosterRow(rosterSelUser ? rosterSel : 0, false);
          } else {
            closeRosterFocus();
          }
          break;
        case "roster-move":
          moveRoster(action.delta);
          break;
        case "roster-menu-open":
          if (rosterMenuItems.length > 0) focusRosterRow(rosterSel, true);
          break;
        case "roster-menu-move": {
          const n = rosterMenuItems.length;
          if (n > 0) setRosterMenuSel((s) => (Math.min(s, n - 1) + action.delta + n) % n); // wrap
          break;
        }
        case "roster-menu-accept":
          runRosterMenuItem(rosterMenuItems[rosterMenuIdx], rosterMenuUser);
          break;
        case "roster-menu-close":
          // One level only: back to roster focus, menu shut.
          focusRosterRow(rosterSel, false);
          break;
        case "palette-move": {
          const n = paletteMatches.length;
          if (n > 0) setPaletteSel((s) => (Math.min(s, n - 1) + action.delta + n) % n); // wrap
          break;
        }
        case "palette-accept": {
          const cmd = paletteMatches[palSel];
          if (!cmd) break;
          setPaletteSel(0);
          if (cmd.args) {
            setDraft(`/${cmd.name} `); // complete, wait for args (menu closes: has a space)
          } else {
            setDraft("");
            submit(`/${cmd.name}`); // no args → run it now
          }
          break;
        }
        case "palette-close": // Esc cancels the command entry
          setDraft("");
          setPaletteSel(0);
          break;
        case "mention-move": {
          const n = mentionMatches.length;
          if (n > 0) setMentionSel((s) => (Math.min(s, n - 1) + action.delta + n) % n); // wrap
          break;
        }
        case "mention-accept": {
          // Replace the trailing `@partial` with the full handle and a space, leaving the
          // rest of the sentence untouched — you keep typing where you left off.
          const pick = mentionMatches[mentionIdx];
          if (!pick) break;
          setDraft((d) => `${d.slice(0, d.length - (mentionPrefix(d)?.length ?? 0) - 1)}@${pick} `);
          setMentionSel(0);
          break;
        }
        case "mention-close":
          // Esc dismisses the menu WITHOUT touching the draft (unlike the command menu,
          // where the draft IS the command). Typing another character brings it back.
          setMentionDismissed(draft);
          setMentionSel(0);
          break;
        case "submit":
          setDraft("");
          // In the DMs pane the input is the conversation (thread) or the new-DM composer,
          // not the lounge/command line.
          if (activeTab === "dms") {
            if (dmComposeNew) startNewDm(action.line);
            else dmController?.sendMessage(action.line);
          } else submit(action.line);
          break;
        case "back":
          dmBack();
          break;
        case "edit-draft":
          setDraft(action.draft);
          setPaletteSel(0); // typing re-filters the `/` menu → back to the top row
          break;
        case "activate":
          activate(activeTab, sel);
          break;
        case "scroll":
          scrollActive(action.to);
          break;
      }
    },
    { isActive: staticInput !== true },
  );

  // Blink the input cursor only when a text input is actually focused (Lounge, an open
  // DM thread, or the summon-confirm `[problem]` field).
  const cursorOn = useBlink(
    staticInput !== true &&
      // While the roster has the keyboard the composer isn't listening — parking the
      // cursor says so, instead of blinking at keys that go somewhere else.
      !rosterFocused &&
      (activeTab === "lounge" || activeTab === "dms" || summonExpert != null),
  );

  // Presence + meter readouts for the two olive status bars (design 2a).
  const onlineExperts = useMemo(() => experts.filter((e) => e.online), [experts]);
  const minExpertRate = onlineExperts.length ? Math.min(...onlineExperts.map((e) => e.rate)) : null;
  // In-call meter shows peer + elapsed time only — no running dollar. This surface
  // can't see pause/connect, so a cost would overstate the bill during a pause; the
  // browser call page + Session DO stay the money authorities.
  const meterClock = clock(callSecs);
  // `[nick(✓)]` shown on the notice row — the effective (display) name after /nick.
  // The ✓ follows the SERVER's verdict, not our saved credentials: a stale token used to
  // render a guest name with a tick beside it, which is the opposite of informative.
  const selfTag =
    user && state.verified
      ? `${state.self ?? user}(✓)`
      : (state.self ?? user ?? (state.connected ? "guest" : "connecting…"));

  // The input line context (design 2a): lime `[#general]` in the lounge, `[mira]` in a
  // DM query, `[problem]` while confirming a summon, `code` while pasting a login code.
  // The summon-confirm view owns its own `[problem]` input (in the body), so it's
  // excluded here — the bottom input line serves the Lounge and open DM threads.
  const showInput =
    !summonExpert &&
    (activeTab === "lounge" || (activeTab === "dms" && (dmView === "thread" || dmView === "new")));
  const inputContext = pendingLogin
    ? "code"
    : activeTab === "dms"
      ? dmView === "new"
        ? "new dm"
        : `@${dmState?.activeLabel ?? dmState?.activePeer ?? "dm"}`
      : `#${state.room}`;
  const loungeConnecting = activeTab === "lounge" && !who && !pendingLogin;

  // The always-on footer hint for the list tabs (shown when the input line isn't).
  // Make the verb match the tab — "call"/"claim"/"rate"/"run", not a generic "select" —
  // and, when the body is really a sign-in wall, say so instead of promising an action
  // the guest can't take yet. This line is on-screen constantly, so it's the highest-
  // value place to be contextual (see the notices, which only flash once per action).
  const tail = "· Tab switch window";
  const navHint = ((): string => {
    const gate = `Sign in on the Me tab (/login) to unlock this ${tail}`;
    const listSignedIn = Boolean(marketplace && user);
    switch (activeTab) {
      case "experts":
        return listSignedIn
          ? `↑↓ move · Enter to call the expert (offline → post a bounty) ${tail}`
          : gate;
      case "bounties":
        return listSignedIn ? `↑↓ move · Enter to claim · last row posts a bounty ${tail}` : gate;
      case "calls":
        return listSignedIn ? `↑↓ move · Enter to rate the selected call ${tail}` : gate;
      case "me":
        return `↑↓ move · Enter to run the selected action ${tail}`;
      case "dms":
        return dmController && user ? `↑↓ move · Enter to open · click a name to DM ${tail}` : gate;
      default:
        return `↑↓ move · Enter/click select ${tail}`;
    }
  })();

  // Olive status bars: Ink 5 has no Box background, so each bar is padded Text filling
  // the full row. Pad = cols − left − right, over-estimating the (emoji-bearing) right
  // width so the bar never overflows and wraps (`cellWidth`).
  const topRight = call
    ? `${G.summon} ${call.peer} ${meterClock} [end] `
    : minExpertRate != null
      ? `${G.summon} ${onlineExperts.length} experts from $${minExpertRate}/min `
      : "";
  // Left side is ` ▄▀ termchat ` (13 cells) plus the version, which is no longer a fixed
  // width — measure it rather than baking a constant that a release would falsify.
  const topPad = " ".repeat(Math.max(1, cols - (13 + VERSION_LABEL.length) - cellWidth(topRight)));
  const winCells = windowStripCells(activeTab, dmUnread);
  const winLeftW = winCells.reduce((n, c) => n + c.text.length, 0);
  const winRight = call ? `${G.summon} ${meterClock} ` : "";
  const winPad = " ".repeat(Math.max(1, cols - winLeftW - cellWidth(winRight)));

  // NB: `contentRows`, `baseVisible`, `sidebarWidth`, and the `loungeWin`/`dmWin` scroll
  // windows are computed up by the scroll-geometry block (shared with the wheel + key
  // handlers). The App renders ONE row shorter than the terminal so Ink does smooth
  // partial updates instead of a full flicker-y erase-and-redraw (blink note on useBlink).
  const shown = loungeWin.shown;

  // Window the active list tab to the rows that fit, keeping the selection on screen
  // (scroll.ts `listWindow`). Reserve a row for the "↑/↓ more" hint when it overflows so
  // the footer never gets pushed off. Body chrome (headers) sits above each list, so the
  // usable rows are `baseVisible` minus that tab's offset; matches hit-test's constants.
  const listRows = (offset: number, extra = 0): number => Math.max(1, baseVisible - offset - extra);
  const expertsWin = listWindow(experts.length, listRows(EXPERTS_LIST_OFFSET, 1), sel);
  const bountiesWin = listWindow(bounties.length + 1, listRows(BOUNTIES_LIST_OFFSET, 1), sel);
  const callsWin = listWindow(sessions.length, listRows(CALLS_LIST_OFFSET, 1), sel);
  const meWin = listWindow(meActions.length, listRows(ME_LIST_OFFSET, 1), sel);
  const inboxWin = listWindow(1 + dmThreadCount, listRows(DMS_INBOX_OFFSET, 1), sel);
  // The window whose geometry the click hit-tester must mirror for the active list tab.
  const activeListWin =
    activeTab === "experts"
      ? expertsWin
      : activeTab === "bounties"
        ? bountiesWin
        : activeTab === "calls"
          ? callsWin
          : activeTab === "me"
            ? meWin
            : activeTab === "dms" && dmView === "inbox"
              ? inboxWin
              : null;

  return (
    <Box flexDirection="column" width={cols} height={contentRows}>
      {/* ── top olive bar: ▄▀ brand mark, or the in-call meter + [end] ── */}
      <Box>
        <Text backgroundColor={C.barBg}> </Text>
        <Text backgroundColor={C.barBg} color={C.accent} bold>
          ▄
        </Text>
        <Text backgroundColor={C.barBg} color={C.amber} bold>
          ▀
        </Text>
        <Text backgroundColor={C.barBg} color={C.barFg} bold>
          {" termchat "}
        </Text>
        <Text backgroundColor={C.barBg} color={C.barFg} dimColor>
          {VERSION_LABEL}
        </Text>
        <Text backgroundColor={C.barBg}>{topPad}</Text>
        {call ? (
          <>
            <Text backgroundColor={C.barBg} color={C.amber} bold>
              {`${G.summon} ${call.peer} ${meterClock} `}
            </Text>
            <Text backgroundColor={C.endInverseBg} color={C.barFg} bold>
              [end]
            </Text>
            <Text backgroundColor={C.barBg}> </Text>
          </>
        ) : (
          minExpertRate != null && (
            <Text backgroundColor={C.barBg} color={C.amber}>
              {`${G.summon} ${onlineExperts.length} experts from $${minExpertRate}/min `}
            </Text>
          )
        )}
      </Box>

      {/* ── window bar: irssi-style windows (click / Tab). Darker than the presence
             bar above so the two rows read as separate lines. In-call meter on the right. ── */}
      <Box>
        {winCells.map((cell) => (
          <Text
            key={cell.tab}
            backgroundColor={cell.active ? C.rowHighlight : C.barBg2}
            color={cell.active ? C.rowHighlightFg : cell.unread ? C.accent : "#b9b58c"}
            bold={cell.active || cell.unread}
          >
            {cell.text}
          </Text>
        ))}
        <Text backgroundColor={C.barBg2}>{winPad}</Text>
        <Text backgroundColor={C.barBg2} color={call ? C.amber : C.fgBright}>
          {winRight}
        </Text>
      </Box>

      {/* body: the active tab */}
      {activeTab === "lounge" && (
        <Box flexGrow={1}>
          {/* justifyContent flex-end keeps the newest message hugging the divider/input
              (chat-app style); any slack from a short transcript falls at the TOP, not as
              a gap above the input. */}
          <Box
            flexDirection="column"
            flexGrow={1}
            marginRight={1}
            // The modal is placed by an explicit marginTop (so hit-test can mirror its
            // rows), which only works from the top; the transcript still hugs the bottom.
            justifyContent={rosterMenuBox ? "flex-start" : "flex-end"}
          >
            {rosterMenuBox ? (
              // The roster action menu is a real modal: it takes over the chat column
              // rather than trailing off the bottom of the sidebar, where it read as
              // detached from the name it acts on. The roster keeps its highlight, so
              // "who is this for" is answered in two places at once.
              <RosterMenuModal
                user={rosterMenuUser ?? ""}
                items={rosterMenuItems}
                sel={rosterMenuIdx}
                box={rosterMenuBox}
              />
            ) : shown.length === 0 ? (
              <Text color={C.muted2}>No messages yet. Say hi!</Text>
            ) : (
              shown.map((line) => <ChatRow key={line.id} line={line} self={who} />)
            )}
            {/* scrolled-up marker: only shows when there ARE newer lines below the fold,
                which only happens once the log overflows — so it always lands on the
                bottom row of a full window (its row is reserved out of `loungeVisible`). */}
            {!rosterMenuBox && loungeWin.hiddenBelow > 0 && (
              <Text
                color={C.muted2}
              >{`▾ ${loungeWin.hiddenBelow} newer — PgDn / ↓ · Esc for latest`}</Text>
            )}
          </Box>
          <Box
            flexDirection="column"
            width={sidebarWidth}
            borderStyle="single"
            borderColor={C.line}
            borderTop={false}
            borderRight={false}
            borderBottom={false}
          >
            <Text color={C.muted}>{` #${state.room.toUpperCase()} · ${state.members.length}`}</Text>
            {rosterMembers.length === 0 ? (
              <Text color={C.muted2}> — quiet —</Text>
            ) : (
              <>
                {rosterMembers
                  .slice(rosterWin.start, rosterWin.start + rosterWin.count)
                  .map((m, j) => {
                    const isSelf = m.user === who;
                    // Only paint the highlight while the roster actually HAS the keyboard —
                    // otherwise it reads as a selection that arrow keys refuse to move.
                    const on = rosterFocused && rosterWin.start + j === rosterSel;
                    return (
                      <Text
                        key={m.user}
                        wrap="truncate"
                        {...(on ? { backgroundColor: C.rowHighlight } : {})}
                      >
                        <Text color={on ? C.rowHighlightFg : m.verified ? C.accent : C.muted}>
                          {m.verified ? ` ${G.online}` : ` ${G.offline}`}
                        </Text>
                        <Text
                          {...(on ? { color: C.rowHighlightFg, bold: true } : nickProps(isSelf))}
                        >{` ${m.user}`}</Text>
                        <Text color={on ? C.rowHighlightFg : C.muted2}>
                          {`${m.verified ? " ✓" : ""}${m.topic ? ` ${m.topic}` : ""}`}
                        </Text>
                      </Text>
                    );
                  })}
                {rosterHidden > 0 && <Text color={C.muted2}>{` +${rosterHidden} more`}</Text>}
              </>
            )}
            <Box flexGrow={1} />
          </Box>
        </Box>
      )}
      {activeTab === "experts" &&
        (summonExpert ? (
          <SummonConfirmBody expert={summonExpert} problem={draft} cursorOn={cursorOn} />
        ) : (
          <ExpertsBody
            experts={experts}
            sel={sel}
            signedIn={Boolean(marketplace && user)}
            start={expertsWin.start}
            count={expertsWin.count}
          />
        ))}
      {activeTab === "bounties" && (
        <BountiesBody
          bounties={bounties}
          sel={sel}
          signedIn={Boolean(marketplace && user)}
          now={now}
          start={bountiesWin.start}
          count={bountiesWin.count}
        />
      )}
      {activeTab === "calls" && (
        <CallsBody
          active={marketplace?.activeSessionId ?? null}
          sessions={sessions}
          sel={sel}
          signedIn={Boolean(marketplace && user)}
          start={callsWin.start}
          count={callsWin.count}
        />
      )}
      {activeTab === "me" && (
        <MeBody
          actions={meActions}
          sel={sel}
          user={user}
          self={state.self}
          start={meWin.start}
          count={meWin.count}
        />
      )}
      {activeTab === "dms" && (
        <DmsBody
          dm={dmState}
          sel={sel}
          signedIn={Boolean(dmController && user)}
          dmView={dmView}
          now={now}
          threadLines={dmWin.shown}
          moreBelow={dmWin.hiddenBelow}
          start={inboxWin.start}
          count={inboxWin.count}
        />
      )}

      {/* marketplace event log (only when active) — `-⚡-` money events in amber */}
      {showMktLog && (
        <Box flexDirection="column">
          {mktLog.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only capped log
            <Text key={i} color={C.amber}>
              {` -${G.summon}- ${line}`}
            </Text>
          ))}
        </Box>
      )}

      {/* horizontal rule dividing the transcript above from the notice + input below.
          Full-width; consumes the row the footer budget reserves for it (baseVisible's
          footer allowance), so it costs no extra height and closes the old blank gap. */}
      <Text color={C.line}>{"─".repeat(Math.max(1, cols))}</Text>

      {/* notice row: `[nick(✓)]` + the transient status/help message */}
      <Text>
        <Text color={C.muted2}>{`[${selfTag}] `}</Text>
        <Text color={C.muted}>
          {notice}
          {dmUnread > 0 ? ` · ✉ ${dmUnread} unread DM${dmUnread === 1 ? "" : "s"}` : ""}
        </Text>
      </Text>

      {/* `/` command menu (Claude-Code style): filtered list above the input, ↑↓ + Tab/Enter */}
      <CommandPalette matches={paletteMatches} sel={palSel} />

      {/* `@` mention menu: who's in the room, filtered as you type. Tab completes (Enter
          still sends — a mention is mid-sentence, not the whole message). */}
      <MentionMenu matches={mentionMatches} sel={mentionIdx} />

      {/* input line: lime context prompt + draft + blinking block cursor, or nav hint */}
      {summonExpert ? (
        <Text color={C.muted2}> Enter authorize the hold · Esc cancel</Text>
      ) : showInput ? (
        <Box>
          <Text color={C.accent}>{loungeConnecting ? "connecting… " : `[${inputContext}] `}</Text>
          <Text color={C.fg}>{draft}</Text>
          <Text color={C.fg}>{cursorOn ? "█" : " "}</Text>
        </Box>
      ) : (
        <Text color={C.muted2}>{navHint}</Text>
      )}
    </Box>
  );
}

/** Where the roster action modal sits, in cells. The App computes this so the renderer
 *  and the click hit-tester place the box from the SAME numbers (Ink has no absolute
 *  positioning — the margins below are what actually put it on screen). */
export interface RosterMenuBox {
  marginTop: number;
  marginLeft: number;
  width: number;
  hint: string;
  /** 1-based absolute row of the first clickable item, and its x/width. */
  itemTop: number;
  itemLeft: number;
  itemWidth: number;
}

/** The roster member's action menu, as a bordered modal over the chat column: a titled
 *  box with one row per action and the keys along the bottom. It replaces the transcript
 *  while open — the earlier sidebar version trailed off the end of the member list, which
 *  read as unrelated to the name it acted on. */
export function RosterMenuModal({
  user,
  items,
  sel,
  box,
}: {
  user: string;
  items: readonly RosterMenuItem[];
  sel: number;
  box: RosterMenuBox;
}): React.ReactElement {
  const inner = Math.max(1, box.width - 4); // borders + paddingX
  return (
    <Box marginTop={box.marginTop} marginLeft={box.marginLeft}>
      <Box
        flexDirection="column"
        width={box.width}
        borderStyle="round"
        borderColor={C.line2}
        paddingX={1}
      >
        <Text color={C.fgBright} bold wrap="truncate">
          {user}
        </Text>
        {items.map((item, i) => {
          const on = i === sel;
          // Pad to the inner width so the selected row's block spans the whole box —
          // a highlight that stops at the end of the label looks like a rendering slip.
          const label = `${on ? "›" : " "} ${item.label}`.padEnd(inner);
          return (
            <Text
              key={item.kind}
              wrap="truncate"
              {...(on ? { backgroundColor: C.rowHighlight } : {})}
              color={on ? C.rowHighlightFg : item.kind === "call" ? C.amber : C.fg}
              bold={on}
            >
              {label}
            </Text>
          );
        })}
        <Text color={C.line2}>{"─".repeat(inner)}</Text>
        <Text color={C.muted2} wrap="truncate">
          {box.hint}
        </Text>
      </Box>
    </Box>
  );
}

/** The `@` mention autocomplete menu: room members matching the handle being typed.
 *  Deliberately plainer than the command palette — it's a list of names, and the footer
 *  spells out the one key that isn't obvious (Tab completes, Enter still sends). */
export function MentionMenu({
  matches,
  sel,
}: {
  matches: readonly string[];
  sel: number;
}): React.ReactElement | null {
  if (matches.length === 0) return null;
  return (
    <Box flexDirection="column">
      {matches.map((user, i) => {
        const on = i === sel;
        return (
          <Text key={user} {...(on ? { backgroundColor: C.rowHighlight } : {})}>
            <Text color={selFg(on, C.nick)} bold={on}>{` @${user.padEnd(16)} `}</Text>
            <Text color={selFg(on, C.muted2)}>{on ? "Tab to complete · Enter sends" : ""}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

/** The `/` command autocomplete menu (Claude-Code style): a filtered, windowed list of
 *  commands above the input. `matches` is the filtered set, `sel` the highlighted index.
 *  Renders nothing when there are no matches (menu closed). */
export function CommandPalette({
  matches,
  sel,
}: {
  matches: readonly CommandInfo[];
  sel: number;
}): React.ReactElement | null {
  if (matches.length === 0) return null;
  const MAX = 8;
  // Keep the selected row in view when the list is long (a bare "/" lists everything).
  const start = matches.length > MAX ? Math.min(Math.max(0, sel - 3), matches.length - MAX) : 0;
  const shown = matches.slice(start, start + MAX);
  return (
    <Box flexDirection="column">
      {shown.map((c) => {
        const on = c === matches[sel];
        return (
          <Text key={c.name} {...(on ? { backgroundColor: C.rowHighlight } : {})}>
            <Text color={selFg(on, C.accent)} bold={on}>{` ${`/${c.name}`.padEnd(12)} `}</Text>
            <Text color={selFg(on, C.muted2)} bold={on}>
              {c.desc}
            </Text>
          </Text>
        );
      })}
      {matches.length > shown.length && (
        <Text color={C.muted2}>{`  … ${matches.length - shown.length} more · ↑↓ Tab`}</Text>
      )}
    </Box>
  );
}

/** The visible window of a list: `items.slice(start, start+count)`, mapping the drawn
 *  index `j` back to the true index `start + j`. `count == null` draws the whole list. */
function windowSlice<T>(items: T[], start = 0, count?: number): { item: T; i: number }[] {
  const end = count == null ? items.length : Math.min(items.length, start + count);
  const out: { item: T; i: number }[] = [];
  for (let i = start; i < end; i++) out.push({ item: items[i] as T, i });
  return out;
}

/** A subtle "N above / N below the fold" hint for a windowed list tab, so a scrolled
 *  list still tells you there's more. Renders nothing when the whole list fits. */
function ListMore({ above, below }: { above: number; below: number }): React.ReactElement | null {
  if (above <= 0 && below <= 0) return null;
  const parts = [above > 0 ? `↑ ${above} more` : "", below > 0 ? `↓ ${below} more` : ""].filter(
    Boolean,
  );
  return <Text color={C.muted2}>{`   ${parts.join("  ·  ")}`}</Text>;
}

/** Experts tab: a browsable directory over `marketplace.experts()`. */
export function ExpertsBody({
  experts,
  sel,
  signedIn,
  start = 0,
  count,
}: {
  experts: ExpertCard[];
  sel: number;
  signedIn: boolean;
  /** First on-screen index + how many rows fit (long lists scroll to follow `sel`). */
  start?: number;
  count?: number;
}): React.ReactElement {
  const end = count == null ? experts.length : Math.min(experts.length, start + count);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text color={C.muted}> EXPERTS — LIVE NOW · SORTED BY RATING</Text>
      {!signedIn ? (
        <Text color={C.muted2}> Sign in (Me tab · /login) to browse and call experts.</Text>
      ) : experts.length === 0 ? (
        <Text color={C.muted2}> No experts listed right now.</Text>
      ) : (
        windowSlice(experts, start, count).map(({ item: e, i }) => {
          const active = i === sel;
          const stars = e.rating != null ? `★${e.rating.toFixed(1)} (${e.ratingCount})` : "★ new";
          const topics = e.topics.join(" ") || "any";
          return (
            <Text key={e.user} {...(active ? { backgroundColor: C.rowHighlight } : {})}>
              <Text color={selFg(active, C.accent)}>{active ? "›" : " "}</Text>
              <Text color={selFg(active, e.online ? C.accent : C.muted)}>
                {e.online ? ` ${G.online}` : ` ${G.offline}`}
              </Text>
              <Text color={selFg(active, C.nick)} bold>{` ${e.user}`}</Text>
              <Text color={selFg(active, C.accent)} bold={active}>
                {e.topExpert ? ` ${G.verified}${G.topExpert}` : ` ${G.verified}`}
              </Text>
              <Text color={selFg(active, C.muted)} bold={active}>{`  ${topics}`}</Text>
              <Text color={selFg(active, C.amber)} bold={active}>{`  $${e.rate}/min`}</Text>
              <Text
                color={selFg(active, C.muted2)}
                bold={active}
              >{`  ${G.rating}${stars.replace("★", "")}`}</Text>
              {e.online ? (
                <Text
                  backgroundColor={active ? C.bg : C.accent}
                  color={active ? C.rowHighlight : C.bg}
                  bold
                >
                  {" call "}
                </Text>
              ) : (
                <Text color={selFg(active, C.muted)} bold={active}>
                  {" [bounty]"}
                </Text>
              )}
            </Text>
          );
        })
      )}
      {signedIn && experts.length > 0 && <ListMore above={start} below={experts.length - end} />}
    </Box>
  );
}

/** The summon-confirm view (design 2a): shown in place of the Experts body once an
 *  expert's [summon] is activated. Label/value rows spell out the hold before the
 *  seeker authorizes; the `problem` row is the live input line (Enter authorizes,
 *  Esc cancels — handled in App). Amber marks every money value; lime the action. */
export function SummonConfirmBody({
  expert,
  problem,
  cursorOn,
}: {
  expert: ExpertCard;
  problem: string;
  cursorOn: boolean;
}): React.ReactElement {
  const holdMax = `$${(expert.rate * 30).toFixed(2)} max`;
  const stars = expert.rating != null ? `★${expert.rating.toFixed(1)}` : "★ new";
  const topics = expert.topics.join(" ") || "any";
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text color={C.amber}>{` CALL ${expert.user.toUpperCase()} — CONFIRM THE HOLD`}</Text>
      <Text> </Text>
      <Text>
        <Text color={C.muted2}>{" expert     "}</Text>
        <Text color={C.nick} bold>
          {expert.user}
        </Text>
        <Text color={C.accent}>
          {expert.topExpert ? ` ${G.verified}${G.topExpert}` : ` ${G.verified}`}
        </Text>
        <Text color={C.muted2}>{`  ${topics} · ${stars} · answers in ~45s avg`}</Text>
      </Text>
      <Text>
        <Text color={C.muted2}>{" rate       "}</Text>
        <Text color={C.amber}>{`$${expert.rate}/min`}</Text>
        <Text color={C.muted2}>{"  · billed on connected minutes only · pause anytime"}</Text>
      </Text>
      <Text>
        <Text color={C.muted2}>{" cap        "}</Text>
        <Text color={C.fg}>30 min</Text>
      </Text>
      <Text>
        <Text color={C.muted2}>{" hold now   "}</Text>
        <Text color={C.amber}>{holdMax}</Text>
        <Text color={C.muted2}>{"  · typical call 6–12 min · refund-friendly disputes"}</Text>
      </Text>
      <Text> </Text>
      <Text>
        <Text color={C.muted2}>{" problem    "}</Text>
        <Text color={C.fgBright}>{problem}</Text>
        <Text color={C.fg}>{cursorOn ? "█" : " "}</Text>
      </Text>
      <Text> </Text>
      <Text>
        <Text
          backgroundColor={C.accent}
          color={C.bg}
          bold
        >{` ${G.summon} call — authorize ${holdMax.replace(" max", "")} hold `}</Text>
        <Text color={C.muted}>{"   [cancel]"}</Text>
      </Text>
    </Box>
  );
}

/** Bounties tab: the browsable open-bounty board over `marketplace.bounties()`.
 *  Each open bounty is a claimable row; a "Post a bounty" action follows the list.
 *  Layout matters — the first bounty sits BOUNTIES_LIST_OFFSET below the header and
 *  the Post row directly after the list, matching hit-test.ts. */
export function BountiesBody({
  bounties,
  sel,
  signedIn,
  now,
  start = 0,
  count,
}: {
  bounties: BountyCard[];
  sel: number;
  signedIn: boolean;
  now: number;
  /** Window over the claimable rows + the trailing "post" row (long boards scroll). */
  start?: number;
  count?: number;
}): React.ReactElement {
  if (!signedIn) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text color={C.muted}> BOUNTIES — ASYNC QUESTIONS, FIXED PRICE</Text>
        <Text color={C.muted2}> Sign in (Me tab · /login) to browse and post bounties.</Text>
      </Box>
    );
  }
  // The claimable bounties and the "post a bounty" action are ONE selectable list of
  // `bounties.length + 1` rows (post = the last index) — window over all of them so a
  // long board still shows the post row when scrolled to the bottom.
  const total = bounties.length + 1;
  const end = count == null ? total : Math.min(total, start + count);
  const postIndex = bounties.length;
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text color={C.muted}> BOUNTIES — ASYNC QUESTIONS, FIXED PRICE</Text>
      {Array.from({ length: end - start }, (_, j) => {
        const i = start + j;
        if (i === postIndex) {
          const postActive = sel === postIndex;
          return (
            <Text key="post" {...(postActive ? { backgroundColor: C.rowHighlight } : {})}>
              <Text color={selFg(postActive, C.accent)}>{postActive ? "›" : " "}</Text>
              <Text color={selFg(postActive, C.accent)} bold={postActive}>
                {" [post a bounty]"}
              </Text>
              <Text color={selFg(postActive, C.muted2)} bold={postActive}>
                {"  money is held, not charged — you pay only when you accept"}
              </Text>
            </Text>
          );
        }
        const b = bounties[i] as BountyCard;
        const active = i === sel;
        const topic = b.topic ?? "any";
        const q = b.question.length > 44 ? `${b.question.slice(0, 43)}…` : b.question;
        return (
          <Text key={b.bountyId} {...(active ? { backgroundColor: C.rowHighlight } : {})}>
            <Text color={selFg(active, C.accent)}>{active ? "›" : " "}</Text>
            <Text color={selFg(active, C.fg)} bold={active}>{` #${b.bountyId}`}</Text>
            <Text color={selFg(active, C.amber)} bold={active}>{`  ${usd(b.priceCents)}`}</Text>
            <Text color={selFg(active, C.muted)} bold={active}>{`  ${topic}`}</Text>
            <Text color={selFg(active, C.fg2)} bold={active}>{`  "${q}"`}</Text>
            <Text
              color={selFg(active, C.muted2)}
              bold={active}
            >{`  open ${ageShort(b.createdAt, now)}`}</Text>
            <Text color={selFg(active, C.accent)} bold={active}>
              {"  [claim]"}
            </Text>
          </Text>
        );
      })}
      {bounties.length === 0 && (
        <Text color={C.muted2}> No open bounties yet — post one above.</Text>
      )}
      <ListMore above={start} below={total - end} />
    </Box>
  );
}

/** Calls tab: the active paid session (if any) plus your past sessions, where a
 *  reviewable one can be selected to rate the expert. Layout is fixed so the first
 *  session row lands CALLS_LIST_OFFSET below the header (see hit-test.ts):
 *  header (0) · active-status (1) · subheader (2) · session rows (3+). */
export function CallsBody({
  active,
  sessions,
  sel,
  signedIn,
  start = 0,
  count,
}: {
  active: number | null;
  sessions: SessionCard[];
  sel: number;
  signedIn: boolean;
  /** First on-screen session index + how many rows fit (long histories scroll). */
  start?: number;
  count?: number;
}): React.ReactElement {
  const end = count == null ? sessions.length : Math.min(sessions.length, start + count);
  if (!signedIn) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text color={C.muted}> CALLS</Text>
        <Text color={C.muted2}> Sign in (Me tab · /login) to see your calls.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text color={C.muted}> CALLS</Text>
      {active == null ? (
        <Text color={C.muted2}> no active call</Text>
      ) : (
        <Text>
          <Text color={C.accent}>{` ${G.livePlay} `}</Text>
          <Text color={C.fg}>{`session #${active} live`}</Text>
          <Text color={C.muted2}>{" — /end to finish"}</Text>
        </Text>
      )}
      <Text color={C.muted2}>
        {sessions.length === 0 ? " no past calls yet" : " past calls — select one to review:"}
      </Text>
      {windowSlice(sessions, start, count).map(({ item: s, i }) => {
        const active_ = i === sel;
        const isExpert = s.role === "expert";
        const tag = s.reviewed
          ? `${G.verified} reviewed`
          : s.reviewable
            ? `[${G.rating} rate]`
            : isExpert
              ? `you were the expert · earned ${usd(s.amountCents)}`
              : s.status;
        return (
          <Text key={s.sessionId} {...(active_ ? { backgroundColor: C.rowHighlight } : {})}>
            <Text color={selFg(active_, C.accent)}>{active_ ? "›" : " "}</Text>
            <Text color={selFg(active_, C.fg)} bold={active_}>{` #${s.sessionId}`}</Text>
            <Text color={selFg(active_, C.nick)} bold={active_}>{` ${s.peer}`}</Text>
            <Text color={selFg(active_, C.muted)} bold={active_}>{`  ${s.minutes}min`}</Text>
            <Text color={selFg(active_, C.amber)} bold={active_}>{`  ${usd(s.amountCents)}`}</Text>
            <Text
              color={selFg(active_, s.reviewable ? C.accent : C.muted2)}
              bold={active_}
            >{`  ${tag}`}</Text>
          </Text>
        );
      })}
      <ListMore above={start} below={sessions.length - end} />
    </Box>
  );
}

/** Me tab: identity + account actions as a selectable list. */
export function MeBody({
  actions,
  sel,
  user,
  self,
  start = 0,
  count,
}: {
  actions: { label: string }[];
  sel: number;
  user: string | null;
  self: string | null;
  /** Window over the action rows (the Me list is short, but stays uniform with the rest). */
  start?: number;
  count?: number;
}): React.ReactElement {
  const end = count == null ? actions.length : Math.min(actions.length, start + count);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text color={C.muted}> ME</Text>
      <Text>
        {user ? (
          <>
            <Text color={C.fgBright} bold>{` ${self ?? user}`}</Text>
            <Text color={C.accent}>{` ${G.verified}`}</Text>
            <Text color={C.muted2}>
              {`${self && self !== user ? ` (${user})` : ""} verified via github`}
            </Text>
          </>
        ) : (
          <Text color={C.muted2}>{` guest: ${self ?? "connecting…"}`}</Text>
        )}
      </Text>
      <Text color={C.muted2}>
        {" "}
        card entry and payouts always open in the browser — never the terminal
      </Text>
      {windowSlice(actions, start, count).map(({ item: a, i }) => {
        const active = i === sel;
        return (
          <Text key={a.label} {...(active ? { backgroundColor: C.rowHighlight } : {})}>
            <Text color={selFg(active, C.accent)}>{active ? "›" : " "}</Text>
            <Text color={selFg(active, C.fg)} bold={active}>{` ${a.label}`}</Text>
          </Text>
        );
      })}
      <ListMore above={start} below={actions.length - end} />
    </Box>
  );
}

/** The DMs tab. Three screens (DM-IMPROVEMENTS.md), NOT a split pane:
 *  - inbox:  "+ Send new DM" then the conversations (most-recent first, unread dot,
 *            @name, relative time). Inbox rows are index 0 = new DM, ≥1 = threads[index-1]
 *            (the convention hit-test.ts + activate() + reduceKey share).
 *  - thread: "‹ see all DMs" back action, the verification header, and the conversation.
 *  - new:    a hint for the "@username …" composer that lives on the bottom input line. */
export function DmsBody({
  dm,
  sel,
  signedIn,
  dmView,
  now,
  maxLines = 200,
  offset = 0,
  threadLines,
  moreBelow = 0,
  start = 0,
  count,
}: {
  dm: DmControllerState | null;
  sel: number;
  signedIn: boolean;
  dmView: DmView;
  now: number;
  /** Fallback windowing (tests): last `maxLines` messages scrolled up by `offset`. Used
   *  only when the App doesn't pass a pre-measured `threadLines` window. */
  maxLines?: number;
  offset?: number;
  /** The App's wrap-aware window of the open thread (already the exact rows that fit) and
   *  how many newer messages sit below it (drives the "▾ N newer" hint). When provided,
   *  these win over the `maxLines`/`offset` fallback. */
  threadLines?: DmLine[];
  moreBelow?: number;
  /** Inbox window: first on-screen row + how many rows fit (long inboxes scroll). Rows
   *  are [+ Send new DM, ...threads], so index 0 = new-DM, index i≥1 = threads[i-1]. */
  start?: number;
  count?: number;
}): React.ReactElement {
  if (!signedIn) {
    return (
      <Box flexGrow={1}>
        <Text color={C.muted2}> Sign in with /login to send direct messages.</Text>
      </Box>
    );
  }

  if (dmView === "new") {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text>
          <Text color={C.accent}>{" + "}</Text>
          <Text color={C.fgBright} bold>
            New message
          </Text>
        </Text>
        <Text color={C.muted2}>
          {
            ' Type "@username" below (optionally followed by a message), Enter to send. Esc to cancel.'
          }
        </Text>
      </Box>
    );
  }

  if (dmView === "thread") {
    const active = dm?.active ?? null;
    const name = dm?.activeLabel ?? dm?.activePeer ?? "dm";
    // Render a message's sender by their DISPLAY name: "me" for my own lines, the peer's
    // current display name for theirs (both keyed off the stable handles).
    const senderLabel = (from: string): string => {
      if (active?.self && from === active.self) return "me";
      if (from === dm?.activePeer) return dm?.activeLabel ?? from;
      return from;
    };
    const isMine = (from: string): boolean => Boolean(active?.self && from === active.self);
    // Prefer the App's wrap-aware window; fall back to a simple tail slice for tests.
    const fallback = windowTail(active?.lines ?? [], maxLines, offset);
    const shownLines = threadLines ?? fallback.shown;
    const hiddenNewer = threadLines ? moreBelow : fallback.hiddenBelow;
    return (
      <Box flexDirection="column" flexGrow={1}>
        {/* back action — FIRST body row (hit-test dm-back pins to BODY_TOP) */}
        <Text>
          <Text color={C.accent}>{" ‹ "}</Text>
          <Text color={C.muted}>see all DMs</Text>
        </Text>
        <Text>
          <Text color={C.muted2}>{" -!- query with "}</Text>
          <Text {...nickProps(false)}>{`@${name}`}</Text>
          <Text color={C.accent}>{` ${G.verified}`}</Text>
        </Text>
        <DmHeader keyStatus={dm?.keyStatus ?? null} safetyWords={dm?.safetyWords ?? []} />
        {dm?.error ? (
          <Text color={C.danger}>{` ${dm.error}`}</Text>
        ) : (active?.lines.length ?? 0) === 0 ? (
          <Text color={C.muted2}> No messages yet. Type below to say hi.</Text>
        ) : (
          shownLines.map((l) => (
            // color on the parent so a wrapped message keeps its color on rows 2+ (see ChatRow).
            <Text key={l.id} color={C.fg} {...(l.pending ? { dimColor: true } : {})}>
              <Text color={C.muted}>{" <"}</Text>
              <Text {...nickProps(isMine(l.from))}>{senderLabel(l.from)}</Text>
              <Text color={C.muted}>{"> "}</Text>
              <Text color={C.fg}>
                {l.undecryptable ? "[can't decrypt]" : `${l.text}${l.pending ? " …" : ""}`}
              </Text>
            </Text>
          ))
        )}
        {hiddenNewer > 0 && <Text color={C.muted2}>{`   ▾ ${hiddenNewer} newer — PgDn / ↓`}</Text>}
      </Box>
    );
  }

  // inbox — one selectable list of [+ Send new DM (index 0), ...threads (index i→i-1)].
  // Window over the whole thing so the "new DM" row and a long thread list both scroll
  // to follow the selection; the caret uses the TRUE index so hit-test stays aligned.
  const threads = dm?.threads ?? [];
  const total = 1 + threads.length;
  const end = count == null ? total : Math.min(total, start + count);
  return (
    <Box flexDirection="column" flexGrow={1}>
      {Array.from({ length: end - start }, (_, j) => {
        const i = start + j;
        if (i === 0) {
          return (
            <Text key="new" {...(sel === 0 ? { backgroundColor: C.rowHighlight } : {})}>
              <Text color={selFg(sel === 0, C.accent)}>{sel === 0 ? "›" : " "}</Text>
              <Text color={selFg(sel === 0, C.accent)} bold={sel === 0}>
                {" + Send new DM"}
              </Text>
            </Text>
          );
        }
        const t = threads[i - 1] as (typeof threads)[number];
        const on = sel === i;
        const name = t.displayName ?? t.peer;
        return (
          <Text key={t.peer} {...(on ? { backgroundColor: C.rowHighlight } : {})}>
            <Text color={selFg(on, C.accent)}>{on ? "›" : " "}</Text>
            {/* unread marker: lime ● when unread, else a matching-width blank */}
            <Text color={selFg(on, t.unread > 0 ? C.accent : C.muted2)}>
              {t.unread > 0 ? ` ${G.online}` : "  "}
            </Text>
            <Text color={selFg(on, C.nick)} bold={on}>{` @${name}`}</Text>
            <Text color={selFg(on, C.muted2)} bold={on}>{`  ${timeAgo(t.lastTs, now)}`}</Text>
          </Text>
        );
      })}
      {threads.length === 0 && (
        <Text color={C.muted2}> No conversations yet — start one above.</Text>
      )}
      <ListMore above={start} below={total - end} />
    </Box>
  );
}

/** The thread's verification line: E2E + a comparable safety number, or a loud warning
 *  when the peer's key changed (TOFU — docs/DMS.md). */
function DmHeader({
  keyStatus,
  safetyWords,
}: {
  keyStatus: DmControllerState["keyStatus"];
  safetyWords: string[];
}): React.ReactElement {
  if (keyStatus === "changed") {
    return (
      <Text color={C.danger} bold>
        {" ⚠ safety number changed — re-verify before trusting new messages"}
      </Text>
    );
  }
  // Show the FULL safety number — never a truncated prefix. A partial comparison would
  // only check half the bits, re-opening the birthday-collision hole the 16-word (128-bit)
  // number closes (docs/DMS.md). Ink wraps the words within the pane.
  const words = safetyWords.join(" ");
  return (
    <Text
      color={C.muted2}
    >{` 🔒 e2e-encrypted · verify all ${safetyWords.length} words match: ${words}`}</Text>
  );
}

/** One lounge transcript row: an irssi-style `HH:MM <nick> message`, or a system
 *  `HH:MM -!- text` notice in muted grey. Nicks hash to a stable "wire" color. */
function ChatRow({ line, self }: { line: ChatLine; self: string | null }): React.ReactElement {
  const time = hhmm(line.ts);
  // The color on the OUTER <Text> is load-bearing, not redundant: when a line wraps to 3+
  // rows, Ink/wrap-ansi drops the inner segment's color on the continuation rows, which
  // then render in the terminal's default (bright white). Setting the row's dominant color
  // on the parent makes the wrapped remainder inherit it instead. (Verified: without it,
  // continuation rows have no leading SGR; with it, they carry the parent color.)
  if (line.kind === "system") {
    return (
      <Text color={C.muted2}>
        <Text color={C.muted2}>{`${time} -!- `}</Text>
        <Text color={C.muted2}>{line.text}</Text>
      </Text>
    );
  }
  const isSelf = line.from != null && line.from === self;
  return (
    <Text color={C.fg}>
      <Text color={C.muted2}>{`${time} `}</Text>
      <Text color={C.muted}>{"<"}</Text>
      <Text {...nickProps(isSelf)}>{line.from}</Text>
      <Text color={C.muted}>{"> "}</Text>
      <Text color={C.fg}>{line.text}</Text>
    </Text>
  );
}
