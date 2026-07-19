import { z } from "zod";

/**
 * Browser-onboarding login (terminal-friendly, phishing-resistant).
 *
 * `termchat login` starts a pairing and opens the onboarding page. The user
 * signs in with GitHub **in the browser**, which then shows a one-time claim
 * code. The user pastes that code back into their terminal, and the CLI
 * exchanges it for a termchat session token.
 *
 * The claim code travels browser → human → originating terminal, so a phished
 * victim's code never reaches an attacker's terminal: completing OAuth on
 * someone else's pairing only ever shows the code to the human at the browser.
 * No GitHub token ever touches the CLI.
 */

/**
 * WebSocket subprotocol that carries the bearer session token, sent as
 * `["termchat-auth", <token>]` so the credential rides the Sec-WebSocket-Protocol
 * header rather than the URL (which is prone to logging).
 */
export const AUTH_SUBPROTOCOL = "termchat-auth";

/** `POST /auth/pair/start` response. */
export const PairStartResponse = z.object({
  /** Public identifier embedded in the onboard URL (not a secret). */
  pairingId: z.string().min(1),
  /** Onboarding page to open in the browser. */
  onboardUrl: z.string().url(),
  expiresInSeconds: z.number().int().positive(),
});
export type PairStartResponse = z.infer<typeof PairStartResponse>;

/** `POST /auth/pair/exchange` request — the code the user pasted from the browser. */
export const PairExchangeRequest = z.object({
  pairingId: z.string().min(1).max(128),
  code: z.string().min(1).max(64),
});
export type PairExchangeRequest = z.infer<typeof PairExchangeRequest>;

/** `POST /auth/pair/exchange` response. */
export const PairExchangeResponse = z.discriminatedUnion("status", [
  /** Browser sign-in not finished yet (no claim code issued). */
  z.object({ status: z.literal("pending") }),
  /** Pairing expired or already used. */
  z.object({ status: z.literal("expired") }),
  /** Wrong code (or too many attempts). */
  z.object({ status: z.literal("invalid") }),
  z.object({
    status: z.literal("ok"),
    token: z.string().min(1),
    user: z.string().min(1),
    githubLogin: z.string().min(1),
  }),
]);
export type PairExchangeResponse = z.infer<typeof PairExchangeResponse>;

/** Decoded termchat session-token claims (HS256). */
export const SessionClaims = z.object({
  /** termchat handle. */
  sub: z.string().min(1),
  /** GitHub login. */
  gh: z.string().min(1),
  /** GitHub numeric id (as string). */
  ghId: z.string().min(1),
  /** GitHub-verified identity. */
  ver: z.boolean(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
});
export type SessionClaims = z.infer<typeof SessionClaims>;

/** `GET /auth/me` response (current identity). */
export const WhoAmI = z.object({
  user: z.string(),
  githubLogin: z.string(),
  verified: z.boolean(),
  exp: z.number().int(),
});
export type WhoAmI = z.infer<typeof WhoAmI>;

/** Locally-stored CLI credentials (`~/.termchat/credentials.json`). */
export const StoredCredentials = z.object({
  token: z.string().min(1),
  user: z.string().min(1),
  githubLogin: z.string().min(1),
});
export type StoredCredentials = z.infer<typeof StoredCredentials>;
