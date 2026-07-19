import { z } from "zod";
import { ReputationTier } from "./reputation.ts";

/**
 * Public profile view model (the "profile card"), derived from a D1 row. Ported
 * from the prototype's `profileCard` shape (PRD §7) plus the reputation summary
 * and the GitHub-verified badge.
 */
export const ProfileCard = z.object({
  user: z.string(),
  githubLogin: z.string().nullable(),
  verified: z.boolean(),
  bio: z.string(),
  isExpert: z.boolean(),
  rate: z.number().nonnegative(),
  topics: z.array(z.string()),
  sessions: z.number().int().nonnegative(),
  /** Average stars, or null when there are no reviews yet. */
  rating: z.number().nullable(),
  ratingCount: z.number().int().nonnegative(),
  reputation: z.object({
    score: z.number().min(0).max(100),
    tier: ReputationTier,
    provisional: z.boolean(),
  }),
  /** PUBLIC surfacing badge (sweep-computed eligibility OR a manual admin grant).
   *  Carries no underlying graph metric — just the boolean. */
  topExpert: z.boolean(),
});
export type ProfileCard = z.infer<typeof ProfileCard>;
