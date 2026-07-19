import { z } from "zod";

/**
 * Reputation TIER — the only reputation symbol on the wire. It appears in the
 * `ProfileCard` (so a client can render an expert's badge) and is the return type
 * of the edge-side scorer.
 *
 * The reputation SCORING itself (weights, thresholds, ranking) is computed
 * server-side and is intentionally NOT part of this package, so the tunable
 * weights never ship with the client. This package stays what it claims to be:
 * shared wire types + validation, with no business logic.
 */
export const ReputationTier = z.enum(["provisional", "established", "trusted"]);
export type ReputationTier = z.infer<typeof ReputationTier>;
