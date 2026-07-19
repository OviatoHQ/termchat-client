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
import { type Command, parseCommand } from "../commands.ts";
import { clearCredentials, writeCredentials } from "../config.ts";
import { type DmController, type DmControllerState, createDmController } from "../dm-controller.ts";
import type { ChatLine, LoungeClient, LoungeState } from "../lounge-client.ts";
import { MarketplaceClient } from "../marketplace-client.ts";
import { openUrl } from "../open-url.ts";
import { PresenceNotifyClient } from "../presence-notify.ts";
import { hitTest, regionsForView } from "./hit-test.ts";
import type { MouseEvent } from "./mouse.ts";
import { TABS, TAB_LABELS, type TabId, reduceKey } from "./nav.ts";
import { useMouse } from "./use-mouse.ts";

const HELP_LINES = [
  "lounge: /nick <name> · /join <room> · /rooms · /topic <tag> · /report <user> · /who",
  "account: /login · /logout · /whoami · /dashboard · /card · /onboard",
  "expert: /expert on <rate> [topics] · /expert off · /summon [@handle] <maxRate> <problem> · /accept · /decline · /end · /review <1-5> · /experts · /earnings · /dispute <id>",
  "bounty: /bounty <price> <question> · /claim <id> · /answer <id> <text> (experts) · /accept <id> · /reject <id> (seeker)",
  "/help · /quit · anything else is a chat message.",
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

/** Distinct color for the local user's own name (chat + roster); others stay cyan. */
const SELF_COLOR = "magenta";

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/** Render a marketplace event as a single transcript-style line. */
function fmtMarket(m: ServerMarketplaceMessage): string {
  switch (m.type) {
    case "expert_ok":
      return `listed as expert @ $${m.rate}/min (${m.topics.join(", ") || "any topic"})`;
    case "expert_off":
      return "no longer listed as an expert";
    case "summon_pending":
      return m.target
        ? `summon sent to ${m.target} — waiting for them to accept…`
        : `summon sent to ${m.candidates} expert(s) — waiting…`;
    case "no_experts":
      return `no experts available under $${m.maxRate}/min${m.topic ? ` for ${m.topic}` : ""}`;
    case "summon_request":
      return `⚡ ${m.from} needs help${m.topic ? ` (${m.topic})` : ""} @ $${m.rate}/min up to ${m.maxMinutes}min: "${m.problem}" — /accept`;
    case "summon_closed":
      return "an offer closed";
    case "session_start":
      return `session #${m.sessionId} with ${m.peer} @ $${m.rate}/min (cap ${m.maxMinutes}min) — /end to finish`;
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
      return `📩 bounty #${m.bountyId} answered by ${m.from} (${usd(m.priceCents)}): "${m.answer}" — /accept ${m.bountyId} or /reject ${m.bountyId}`;
    case "bounty_expired":
      return `bounty #${m.bountyId} expired — your ${usd(m.priceCents)} hold was released, no charge`;
    case "system":
      return m.text;
  }
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
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<LoungeState>(client.getState());
  const [dmController, setDmController] = useState<DmController | undefined>(initialDmController);
  const [dmState, setDmState] = useState<DmControllerState | null>(
    initialDmController?.getState() ?? null,
  );
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string>(HELP_LINES[0] ?? "");
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
  const [experts, setExperts] = useState<ExpertCard[]>([]);
  const [bounties, setBounties] = useState<BountyCard[]>([]);
  const [sessions, setSessions] = useState<SessionCard[]>([]);
  // When set, the next /review targets this specific session (chosen in the Calls
  // tab) instead of the client's last-ended one.
  const [reviewTarget, setReviewTarget] = useState<{ sessionId: number; peer: string } | null>(
    null,
  );

  useEffect(() => {
    setState(client.getState());
    return client.subscribe((next) => setState({ ...next }));
  }, [client]);

  useEffect(() => {
    if (!dmController) return;
    setDmState(dmController.getState());
    return dmController.subscribe((next) => setDmState({ ...next }));
  }, [dmController]);

  // The open DM thread is "read" only while the DMs tab is on-screen. Off it, incoming
  // messages accumulate as unread (the badge lights up); back on it, they mark read.
  useEffect(() => {
    dmController?.setFocused(activeTab === "dms");
  }, [dmController, activeTab]);

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
      setMktLog((log) => [...log, fmtMarket(m)].slice(-MKT_LOG_MAX));
      // Opening a session pops the relay-only audio call page in the browser.
      if (m.type === "session_start") {
        if (session && token) {
          openUrl(`${session.httpBase}/call#session=${m.sessionId}&token=${token}&rate=${m.rate}`);
        } else {
          onCall?.(m.sessionId, m.rate);
        }
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
          maxRate: command.maxRate,
          ...(command.target ? { target: command.target } : {}),
        });
        setNotice(command.target ? `Summoning ${command.target}…` : "Looking for an expert…");
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
    void dmController.openThread(peer).then(() => {
      if (message) dmController.sendMessage(message);
      // The thread + safety number now render in the pane; drop the transient notice
      // so it doesn't linger as if still loading.
      setNotice((n) => (n === `Opening DM with ${peer}…` ? "" : n));
    });
    setNotice(`Opening DM with ${peer}…`);
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
          setNotice("Sign in to report.");
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
      case "rooms":
        setNotice(`Rooms: ${LOUNGE_ROOMS.join(", ")}`);
        break;
      case "who": {
        const names = fmtMembers(state.members).join(", ") || "(nobody here yet)";
        setNotice(`In #${state.room}: ${names}`);
        break;
      }
      case "help":
        setNotice(HELP_LINES.join("  "));
        break;
      case "quit":
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
  const { rows, cols } = useTerminalSize();

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
              ? (dmState?.threads.length ?? 0)
              : 0;
  const sel = itemCount > 0 ? Math.min(selection, itemCount - 1) : 0;

  const switchTab = (tab: TabId): void => {
    setActiveTab(tab);
    setSelection(0);
    if (tab === "experts") marketplace?.experts(); // refresh the directory on entry
    if (tab === "bounties") marketplace?.bounties(); // refresh the board on entry
    if (tab === "calls") marketplace?.mySessions(); // refresh your sessions on entry
    if (tab === "dms") void dmController?.refreshInbox(); // reload the thread list on entry
  };

  // Activate an item by (tab, index) so the keyboard (Enter on the highlight) and the
  // mouse (click a row) share ONE path. `index` is explicit because a click can't
  // rely on the async `selection` state having caught up.
  const activate = (tab: TabId, index: number): void => {
    if (tab === "experts") {
      const e = experts[index];
      if (!e) return;
      if (!marketplace || !user) {
        setNotice("Sign in with /login to summon an expert.");
        return;
      }
      if (!e.online) {
        setNotice(`${e.user} is offline — post an async bounty: /bounty <price> <question>.`);
        return;
      }
      // There's no targeted-summon primitive yet (summon is a topic/rate auction),
      // so prefill a summon at this expert's rate and hand off to the Lounge input
      // for the seeker to type the problem. See docs/UI-EXPLORATION.md.
      setDraft(`/summon ${e.rate} `);
      setActiveTab("lounge");
      setSelection(0);
      setNotice(`Type your problem, then Enter to summon an expert @ ≤ $${e.rate}/min.`);
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
      const thread = dmState?.threads[index];
      if (thread) void dmController?.openThread(thread.peer);
    }
  };

  // Mouse (step 3): route a left-click through the same region map the layout draws,
  // to the same `switchTab`/`activate` handlers the keyboard uses. Clicks only for
  // now — wheel scroll pairs with the deferred Lounge scrollback. This is redefined
  // each render (reading current values via closure); `useMouse` keeps the latest in
  // a ref and subscribes once, so it needn't be memoised.
  const handleMouse = (event: MouseEvent): void => {
    if (event.type !== "down" || event.button !== "left") return;
    const regions = regionsForView({
      activeTab,
      cols,
      expertsCount: experts.length,
      meCount: meActions.length,
      bountiesCount: bounties.length,
      sessionsCount: sessions.length,
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
      const action = reduceKey(
        { activeTab, selection: sel, itemCount, draft, locked: pendingLogin !== null },
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
        case "submit":
          setDraft("");
          // In the DMs pane the input is the conversation, not the lounge/command line.
          if (activeTab === "dms") dmController?.sendMessage(action.line);
          else submit(action.line);
          break;
        case "edit-draft":
          setDraft(action.draft);
          break;
        case "activate":
          activate(activeTab, sel);
          break;
      }
    },
    { isActive: staticInput !== true },
  );

  // Blink the input cursor only when the Lounge input is actually focused.
  const cursorOn = useBlink(
    staticInput !== true && (activeTab === "lounge" || activeTab === "dms"),
  );

  const status = useMemo(() => {
    const conn = state.connected ? "●" : "○";
    // Verified: show the effective (display) name — matches the roster after `/nick`.
    const label = user
      ? `${state.self ?? user} ✓`
      : state.self
        ? `${state.self} (guest · /login to claim)`
        : "connecting…";
    return `${conn} ${state.guests} guest(s) · ${state.members.length} here · ${label}`;
  }, [state.connected, state.guests, state.members.length, state.self, user]);

  // Sidebar ~22% of width (clamped); chat gets the rest.
  const sidebarWidth = Math.min(26, Math.max(14, Math.floor(cols * 0.22)));
  // Window the transcript to what fits: total rows minus header chrome (title +
  // tab strip) + footer chrome (status, notice, input) and the optional mkt log.
  const mktRows = mktLog.length > 0 ? mktLog.length + 1 : 0;
  const visible = Math.max(3, rows - 2 /* header */ - 3 /* footer */ - mktRows);
  const shown = state.lines.slice(-visible);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {/* title bar */}
      <Box>
        <Text bold color="green">
          {" termchat "}
        </Text>
        <Text color="cyan">{`#${state.room}`}</Text>
        <Text dimColor>{`   ${LOUNGE_ROOMS.length - 1} other rooms`}</Text>
      </Box>

      {/* tab strip — Tab / Shift+Tab switch; the active tab is bracketed */}
      <Box>
        {TABS.map((t) => {
          const isActive = t === activeTab;
          // Highlight the DMs tab (colour only — width-neutral so mouse hit-testing
          // stays aligned) when there are unread DMs and it's not the current tab.
          const color = isActive ? "green" : t === "dms" && dmUnread > 0 ? "yellow" : "gray";
          return (
            <Text key={t} color={color} bold={isActive || (t === "dms" && dmUnread > 0)}>
              {isActive ? `[${TAB_LABELS[t]}] ` : ` ${TAB_LABELS[t]}  `}
            </Text>
          );
        })}
        <Text dimColor>Tab ⇄ / click</Text>
      </Box>

      {/* body: the active tab */}
      {activeTab === "lounge" && (
        <Box flexGrow={1}>
          <Box flexDirection="column" flexGrow={1} marginRight={1}>
            {shown.length === 0 ? (
              <Text dimColor>No messages yet. Say hi!</Text>
            ) : (
              shown.map((line) => <ChatRow key={line.id} line={line} self={who} />)
            )}
          </Box>
          <Box
            flexDirection="column"
            width={sidebarWidth}
            borderStyle="single"
            borderColor="gray"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
          >
            <Text bold>{` in #${state.room}`}</Text>
            {state.members.length === 0 ? (
              <Text dimColor> — quiet —</Text>
            ) : (
              state.members.map((m) => {
                const isSelf = m.user === who;
                const name = m.verified ? `${m.user} ✓` : m.user;
                const label = m.topic ? `${name} · ${m.topic}` : name;
                return (
                  <Text
                    key={m.user}
                    {...(isSelf ? { color: SELF_COLOR, bold: true } : {})}
                  >{` ${label}`}</Text>
                );
              })
            )}
          </Box>
        </Box>
      )}
      {activeTab === "experts" && (
        <ExpertsBody experts={experts} sel={sel} signedIn={Boolean(marketplace && user)} />
      )}
      {activeTab === "bounties" && (
        <BountiesBody bounties={bounties} sel={sel} signedIn={Boolean(marketplace && user)} />
      )}
      {activeTab === "calls" && (
        <CallsBody
          active={marketplace?.activeSessionId ?? null}
          sessions={sessions}
          sel={sel}
          signedIn={Boolean(marketplace && user)}
        />
      )}
      {activeTab === "me" && <MeBody actions={meActions} sel={sel} user={user} self={state.self} />}
      {activeTab === "dms" && (
        <DmsBody
          dm={dmState}
          sel={sel}
          signedIn={Boolean(dmController && user)}
          sidebarWidth={sidebarWidth}
        />
      )}

      {/* marketplace event log (only when active) */}
      {mktLog.length > 0 && (
        <Box flexDirection="column">
          <Text bold color="yellow">
            marketplace
          </Text>
          {mktLog.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only capped log
            <Text key={i} color="yellow">
              · {line}
            </Text>
          ))}
        </Box>
      )}

      {/* footer: status · notice · input (Lounge, or an open DM thread) or nav hint */}
      <Text dimColor>
        {status}
        {dmUnread > 0 ? ` · ✉ ${dmUnread} unread DM${dmUnread === 1 ? "" : "s"}` : ""}
      </Text>
      <Text dimColor>{notice}</Text>
      {activeTab === "lounge" || (activeTab === "dms" && dmState?.activePeer) ? (
        <Box>
          <Text {...(pendingLogin ? { color: "yellow" } : {})}>
            {pendingLogin
              ? "code> "
              : activeTab === "dms"
                ? `@${dmState?.activeLabel ?? dmState?.activePeer} > `
                : who
                  ? "> "
                  : "connecting… "}
          </Text>
          <Text>{draft}</Text>
          <Text>{cursorOn ? "█" : " "}</Text>
        </Box>
      ) : (
        <Text dimColor>
          {activeTab === "dms"
            ? "↑↓ pick a thread · Enter open · type to reply · Tab switch tab"
            : "↑↓ move · Enter/click select · Tab switch tab"}
        </Text>
      )}
    </Box>
  );
}

/** Experts tab: a browsable directory over `marketplace.experts()`. */
export function ExpertsBody({
  experts,
  sel,
  signedIn,
}: {
  experts: ExpertCard[];
  sel: number;
  signedIn: boolean;
}): React.ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold> Experts</Text>
      {!signedIn ? (
        <Text dimColor> Sign in (Me tab · /login) to browse and summon experts.</Text>
      ) : experts.length === 0 ? (
        <Text dimColor> No experts listed right now.</Text>
      ) : (
        experts.map((e, i) => {
          const active = i === sel;
          const stars = e.rating != null ? `★${e.rating.toFixed(1)} (${e.ratingCount})` : "★ new";
          const topics = e.topics.join(", ") || "any topic";
          const cta = e.online ? "Summon" : "Bounty";
          const label = `${active ? "›" : " "} ${e.online ? "●" : "○"} ${e.user}${e.topExpert ? " ⭐" : ""}  ${topics}  $${e.rate}/min  ${stars}  [ ${cta} ]`;
          return (
            <Text key={e.user} {...(active ? { color: "green", bold: true } : {})}>
              {label}
            </Text>
          );
        })
      )}
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
}: {
  bounties: BountyCard[];
  sel: number;
  signedIn: boolean;
}): React.ReactElement {
  if (!signedIn) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text bold> Bounties</Text>
        <Text dimColor> Sign in (Me tab · /login) to browse and post bounties.</Text>
      </Box>
    );
  }
  const postActive = sel === bounties.length;
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold> Bounties</Text>
      {bounties.map((b, i) => {
        const active = i === sel;
        const topic = b.topic ?? "any";
        const q = b.question.length > 48 ? `${b.question.slice(0, 47)}…` : b.question;
        const label = `${active ? "›" : " "} #${b.bountyId} ${usd(b.priceCents)}  ${topic}  "${q}"  [ Claim ]`;
        return (
          <Text key={b.bountyId} {...(active ? { color: "green", bold: true } : {})}>
            {label}
          </Text>
        );
      })}
      <Text {...(postActive ? { color: "green", bold: true } : {})}>
        {`${postActive ? "›" : " "} [ Post a bounty ]`}
      </Text>
      {bounties.length === 0 && <Text dimColor> No open bounties yet — post one above.</Text>}
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
}: {
  active: number | null;
  sessions: SessionCard[];
  sel: number;
  signedIn: boolean;
}): React.ReactElement {
  if (!signedIn) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text bold> Calls</Text>
        <Text dimColor> Sign in (Me tab · /login) to see your calls.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold> Calls</Text>
      <Text {...(active == null ? { dimColor: true } : {})}>
        {active == null ? " No active call." : ` Active: session #${active} — /end to finish.`}
      </Text>
      <Text dimColor>
        {sessions.length === 0 ? " No past calls yet." : " Past calls — select one to review:"}
      </Text>
      {sessions.map((s, i) => {
        const active_ = i === sel;
        const tag = s.reviewed
          ? "✓ reviewed"
          : s.reviewable
            ? "★ rate"
            : s.role === "expert"
              ? "(you were the expert)"
              : s.status;
        const label = `${active_ ? "›" : " "} #${s.sessionId} ${s.peer}  ${s.minutes}min  ${usd(s.amountCents)}  ${tag}`;
        return (
          <Text key={s.sessionId} {...(active_ ? { color: "green", bold: true } : {})}>
            {label}
          </Text>
        );
      })}
    </Box>
  );
}

/** Me tab: identity + account actions as a selectable list. */
export function MeBody({
  actions,
  sel,
  user,
  self,
}: {
  actions: { label: string }[];
  sel: number;
  user: string | null;
  self: string | null;
}): React.ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold> Me</Text>
      <Text dimColor>
        {user
          ? ` Signed in as ${self ?? user}${self && self !== user ? ` (${user})` : ""} ✓`
          : ` Guest: ${self ?? "connecting…"}`}
      </Text>
      <Text> </Text>
      {actions.map((a, i) => {
        const active = i === sel;
        return (
          <Text key={a.label} {...(active ? { color: "green", bold: true } : {})}>
            {`${active ? "›" : " "} ${a.label}`}
          </Text>
        );
      })}
    </Box>
  );
}

/** The DMs tab: thread list (left) + the open conversation with its verification
 *  header (right). Two-pane, mirroring the Lounge layout (docs/DMS.md stage 3b). */
export function DmsBody({
  dm,
  sel,
  signedIn,
  sidebarWidth,
}: {
  dm: DmControllerState | null;
  sel: number;
  signedIn: boolean;
  sidebarWidth: number;
}): React.ReactElement {
  if (!signedIn) {
    return (
      <Box flexGrow={1}>
        <Text dimColor> Sign in with /login to send direct messages.</Text>
      </Box>
    );
  }
  const threads = dm?.threads ?? [];
  const active = dm?.active ?? null;
  // Render a message's sender by their DISPLAY name: "me" for my own lines, the peer's
  // current display name for theirs (both keyed off the stable handles).
  const senderLabel = (from: string): string => {
    if (active?.self && from === active.self) return "me";
    if (from === dm?.activePeer) return dm?.activeLabel ?? from;
    return from;
  };

  return (
    <Box flexGrow={1}>
      {/* conversation pane */}
      <Box flexDirection="column" flexGrow={1} marginRight={1}>
        {dm?.activePeer ? (
          <>
            <Text bold color="cyan">{`── @${dm.activeLabel ?? dm.activePeer} ──`}</Text>
            <DmHeader keyStatus={dm.keyStatus} safetyWords={dm.safetyWords} />
            {dm.error ? (
              <Text color="yellow">{` ${dm.error}`}</Text>
            ) : (active?.lines.length ?? 0) === 0 ? (
              <Text dimColor> No messages yet. Type below to say hi.</Text>
            ) : (
              active?.lines.map((l) => (
                <Text key={l.id} {...(l.pending ? { dimColor: true } : {})}>
                  {l.undecryptable
                    ? ` ${senderLabel(l.from)}: [can't decrypt]`
                    : ` ${senderLabel(l.from)}: ${l.text}${l.pending ? " …" : ""}`}
                </Text>
              ))
            )}
          </>
        ) : (
          <Text dimColor> Select a thread (↑↓, Enter) or use /dm &lt;user&gt;.</Text>
        )}
      </Box>
      {/* thread list */}
      <Box
        flexDirection="column"
        width={sidebarWidth}
        borderStyle="single"
        borderColor="gray"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
      >
        <Text bold> Threads</Text>
        {threads.length === 0 ? (
          <Text dimColor> — none — /dm user</Text>
        ) : (
          threads.map((t, i) => {
            const isActive = i === sel;
            const badge = t.unread > 0 ? ` ●${t.unread}` : "";
            return (
              <Text key={t.peer} {...(isActive ? { color: "green", bold: true } : {})}>
                {`${isActive ? "›" : " "}${t.displayName ?? t.peer}${badge}`}
              </Text>
            );
          })
        )}
      </Box>
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
      <Text color="red" bold>
        {" ⚠ safety number changed — re-verify before trusting new messages"}
      </Text>
    );
  }
  // Show the FULL safety number — never a truncated prefix. A partial comparison would
  // only check half the bits, re-opening the birthday-collision hole the 16-word (128-bit)
  // number closes (docs/DMS.md). Ink wraps the words within the pane.
  const words = safetyWords.join(" ");
  return <Text dimColor>{` 🔒 E2E · verify all ${safetyWords.length} words match: ${words}`}</Text>;
}

function ChatRow({ line, self }: { line: ChatLine; self: string | null }): React.ReactElement {
  if (line.kind === "system") {
    return <Text dimColor>* {line.text}</Text>;
  }
  const isSelf = line.from != null && line.from === self;
  return (
    <Text>
      <Text color={isSelf ? SELF_COLOR : "cyan"} bold={isSelf}>
        {line.from}
      </Text>
      <Text>: {line.text}</Text>
    </Text>
  );
}
