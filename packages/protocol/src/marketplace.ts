import { z } from "zod";
import { TopicTag } from "./topics.ts";

/**
 * Paid expert marketplace wire protocol (PRD §3.3, §8), ported from
 * `prototype/server.js` and adapted to Durable Objects + D1 + a PaymentProvider.
 *
 * Money on the wire is always in **integer cents** (never floats) for safety.
 * Rates are dollars/min as the expert sets them, bounded by RATE_MIN/MAX.
 */

/** Expert per-minute rate bounds, in dollars (enforced at `/expert`). */
export const RATE_MIN = 0.5;
export const RATE_MAX = 20;

/** Booking length the seeker may request, in minutes (hold = maxMinutes × rate). */
export const MAX_MINUTES_DEFAULT = 15;
export const MAX_MINUTES_CAP = 60;

/** Platform gross fee: 20% with a $0.50 (50¢) floor (PRD §15). Nets ~17–18% after
 *  Stripe (2.9% + $0.30), which is deducted from the platform's cut, not the expert's. */
export const FEE_BPS = 2000;
export const FEE_MIN_CENTS = 50;

/** Async-bounty fixed price bounds, in cents ($1–$100). TTLs: unclaimed bounties
 *  expire after 24h; an answered-but-unaccepted bounty auto-accepts after 72h. */
export const BOUNTY_PRICE_MIN_CENTS = 100;
export const BOUNTY_PRICE_MAX_CENTS = 10_000;
export const BOUNTY_UNCLAIMED_TTL_MS = 24 * 60 * 60 * 1_000;
/** A claimed bounty unanswered this long after CLAIM is a ghosted expert → void. */
export const BOUNTY_CLAIM_ANSWER_TTL_MS = 24 * 60 * 60 * 1_000;
export const BOUNTY_ANSWER_ACCEPT_TTL_MS = 72 * 60 * 60 * 1_000;

export const ExpertRate = z.number().min(RATE_MIN).max(RATE_MAX);
export const ProblemText = z.string().trim().min(1).max(200);
export const Stars = z.number().int().min(1).max(5);
/** A bounty price in integer cents, bounded to $1–$100. */
export const BountyPriceCents = z
  .number()
  .int()
  .min(BOUNTY_PRICE_MIN_CENTS)
  .max(BOUNTY_PRICE_MAX_CENTS);
/** The seeker's OWN typed question. The ONLY free text that crosses the wire for a
 *  bounty — never the raw prompt/cwd/paths (§11.3); enforced by there being no
 *  other text field on the post boundary. */
export const BountyQuestion = z.string().trim().min(1).max(2000);
/** An expert's answer to a bounty — length-capped; goes through the same content
 *  gate as lounge messages (it's the first expert→seeker free-text channel). */
export const BountyAnswer = z.string().trim().min(1).max(4000);

// ---- client → server -------------------------------------------------------

export const ClientMarketplaceMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("expert_on"), rate: ExpertRate, topics: z.array(TopicTag).max(10) }),
  z.object({ type: z.literal("expert_off") }),
  z.object({
    type: z.literal("summon"),
    topic: TopicTag.optional(),
    problem: ProblemText,
    maxRate: ExpertRate,
    maxMinutes: z.number().int().min(1).max(MAX_MINUTES_CAP).optional(),
    /** Targeted summon: address ONE named expert by handle (from `/summon @handle …`)
     *  instead of the open topic/rate auction. The rate cap still applies. Handle is a
     *  public username (matched case-insensitively on the edge) — no new PII. */
    target: z.string().trim().min(1).max(64).optional(),
  }),
  z.object({ type: z.literal("accept"), reqId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("decline"), reqId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("end") }),
  z.object({
    type: z.literal("review"),
    sessionId: z.number().int().positive(),
    stars: Stars,
    text: z.string().max(300).optional(),
  }),
  z.object({ type: z.literal("experts") }),
  z.object({ type: z.literal("earnings") }),
  // Seeker-initiated dispute on an ended paid session (within the dispute window).
  z.object({
    type: z.literal("dispute"),
    sessionId: z.number().int().positive(),
    reason: z.string().max(500).optional(),
  }),
  // ---- async bounties (2e) ----
  // Post a fixed-price bounty (carries ONLY topic + the seeker's typed question).
  z.object({
    type: z.literal("bounty_post"),
    topic: TopicTag.nullable(),
    question: BountyQuestion,
    priceCents: BountyPriceCents,
  }),
  // An expert claims a bounty (claim-once; concurrent claims resolve to one winner).
  z.object({ type: z.literal("bounty_claim"), bountyId: z.number().int().positive() }),
  // The claiming expert submits OR resubmits an answer (while still 'answered').
  z.object({
    type: z.literal("bounty_answer"),
    bountyId: z.number().int().positive(),
    answer: BountyAnswer,
  }),
  // The seeker accepts (→ capture) or rejects (→ void) an answered bounty.
  z.object({ type: z.literal("bounty_accept"), bountyId: z.number().int().positive() }),
  z.object({ type: z.literal("bounty_reject"), bountyId: z.number().int().positive() }),
  // Request the open bounty board (browsable list of claimable bounties).
  z.object({ type: z.literal("bounties") }),
  // Request the caller's own sessions (for the Calls tab + review selection).
  z.object({ type: z.literal("my_sessions") }),
]);
export type ClientMarketplaceMessage = z.infer<typeof ClientMarketplaceMessage>;

// ---- server → client -------------------------------------------------------

export const ExpertCard = z.object({
  user: z.string(),
  rate: z.number(),
  topics: z.array(z.string()),
  rating: z.number().nullable(),
  ratingCount: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  reputationTier: z.string(),
  /** PUBLIC top-expert surfacing badge (no underlying graph metric exposed). */
  topExpert: z.boolean(),
  online: z.boolean(),
});
export type ExpertCard = z.infer<typeof ExpertCard>;

/** One open bounty on the browsable board. Carries ONLY the coarse topic + the
 *  seeker's typed question (redacted by construction) — never prompt/cwd/paths. */
export const BountyCard = z.object({
  bountyId: z.number().int().positive(),
  seeker: z.string(),
  // Coarse topic string as stored (or null) — same plain-string treatment as
  // ExpertCard.topics; it originates from a validated TopicTag at post time.
  topic: z.string().nullable(),
  question: z.string(),
  priceCents: z.number().int().nonnegative(),
  createdAt: z.number().int(),
});
export type BountyCard = z.infer<typeof BountyCard>;

export const SessionRole = z.enum(["seeker", "expert"]);
export type SessionRole = z.infer<typeof SessionRole>;

/** One of the caller's past/active sessions, from their POV. Drives the Calls tab
 *  and review selection. `reviewable` = you were the seeker, it ended, and you
 *  haven't reviewed it yet (the edge re-checks on submit). No prompt/paths here. */
export const SessionCard = z.object({
  sessionId: z.number().int().positive(),
  role: SessionRole,
  /** The other party from the caller's POV (the expert, if you were the seeker). */
  peer: z.string(),
  topic: z.string().nullable(),
  status: z.string(),
  minutes: z.number().int().nonnegative(),
  /** Charge (seeker) or payout (expert), in cents. */
  amountCents: z.number().int().nonnegative(),
  endedAt: z.number().int().nullable(),
  reviewed: z.boolean(),
  reviewable: z.boolean(),
});
export type SessionCard = z.infer<typeof SessionCard>;

export const ServerMarketplaceMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("expert_ok"), rate: z.number(), topics: z.array(z.string()) }),
  z.object({ type: z.literal("expert_off") }),
  z.object({
    type: z.literal("summon_pending"),
    reqId: z.string(),
    candidates: z.number().int(),
    /** The named expert, when this was a targeted summon (`/summon @handle …`). Lets
     *  the TUI say "waiting for chef to accept…" instead of "sent to 1 expert(s)". */
    target: z.string().optional(),
  }),
  z.object({ type: z.literal("no_experts"), topic: TopicTag.nullable(), maxRate: z.number() }),
  z.object({
    type: z.literal("summon_request"),
    reqId: z.string(),
    from: z.string(),
    topic: TopicTag.nullable(),
    problem: z.string(),
    rate: z.number(),
    maxMinutes: z.number().int(),
  }),
  z.object({ type: z.literal("summon_closed"), reqId: z.string() }),
  z.object({
    type: z.literal("session_start"),
    sessionId: z.number().int(),
    peer: z.string(),
    role: SessionRole,
    rate: z.number(),
    maxMinutes: z.number().int(),
    problem: z.string(),
  }),
  z.object({
    type: z.literal("session_end"),
    sessionId: z.number().int(),
    role: SessionRole,
    minutes: z.number().int(),
    chargeCents: z.number().int(),
    feeCents: z.number().int(),
    payoutCents: z.number().int(),
    reason: z.string(),
  }),
  z.object({ type: z.literal("expert_list"), experts: z.array(ExpertCard) }),
  z.object({ type: z.literal("bounty_list"), bounties: z.array(BountyCard) }),
  z.object({ type: z.literal("session_list"), sessions: z.array(SessionCard) }),
  z.object({
    type: z.literal("earnings"),
    lifetimeCents: z.number().int(),
    sessions: z.number().int(),
  }),
  z.object({ type: z.literal("system"), text: z.string() }),
  // ---- async bounties (2e) ----
  // Ack to the poster (the hold was authorized).
  z.object({
    type: z.literal("bounty_posted"),
    bountyId: z.number().int(),
    priceCents: z.number().int(),
  }),
  // Fan-out to an eligible expert (carries ONLY topic + the seeker's typed question).
  z.object({
    type: z.literal("bounty_offer"),
    bountyId: z.number().int(),
    from: z.string(),
    topic: TopicTag.nullable(),
    question: z.string(),
    priceCents: z.number().int(),
  }),
  // The claim winner; losers of a concurrent claim get a `system` "already taken".
  z.object({
    type: z.literal("bounty_claimed"),
    bountyId: z.number().int(),
    priceCents: z.number().int(),
  }),
  // Non-blocking notify to the seeker: their bounty was answered (carries the answer
  // so they can /accept or /reject). Pushed live + surfaced on reconnect.
  z.object({
    type: z.literal("bounty_answered"),
    bountyId: z.number().int(),
    from: z.string(),
    answer: z.string(),
    priceCents: z.number().int(),
  }),
  // Non-blocking notify: an unclaimed bounty expired (24h) — the hold was released.
  z.object({
    type: z.literal("bounty_expired"),
    bountyId: z.number().int(),
    priceCents: z.number().int(),
  }),
]);
export type ServerMarketplaceMessage = z.infer<typeof ServerMarketplaceMessage>;
