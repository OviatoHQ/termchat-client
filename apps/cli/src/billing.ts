import { readCredentials, resolveEdge } from "./config.ts";

/** Open the user's browser at a URL (best effort; skipped when headless). */
function openUrl(url: string): void {
  if (process.env.TERMCHAT_NO_BROWSER === "1") return;
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    Bun.spawn([command, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // url is printed regardless
  }
}

/** The browser destination for a billing action — an explainer page that describes
 *  what will happen, then hands off to Stripe on Continue (docs/WEBAPP-PRD.md §7).
 *  The page authenticates the browser itself (GitHub cookie), so the CLI just opens
 *  it — no Bearer token, no raw Stripe URL. Card entry / KYC happen on Stripe (§10). */
function interstitialUrl(kind: "card" | "onboard"): string {
  const { httpBase } = resolveEdge();
  return `${httpBase}/app/billing/${kind}`;
}

/**
 * Open the billing interstitial in the browser (was: fetch a raw Stripe link and
 * jump straight there). The page explains the step before continuing to Stripe.
 */
export async function openBillingLink(kind: "card" | "onboard"): Promise<void> {
  if (!readCredentials()) {
    console.error("Not logged in. Run `termchat login` first.");
    process.exitCode = 1;
    return;
  }
  const url = interstitialUrl(kind);
  const label = kind === "card" ? "Save your card" : "Set up expert payouts";
  console.log(`\n  ${label} in your browser:\n  ${url}\n`);
  openUrl(url);
}

/**
 * Same as {@link openBillingLink}, but returns a short status message instead of
 * writing to the console — for use inside the chat TUI (`/card`, `/onboard`).
 */
export async function billingLinkNotice(kind: "card" | "onboard"): Promise<string> {
  if (!readCredentials()) return "Sign in first with /login.";
  openUrl(interstitialUrl(kind));
  return kind === "card"
    ? "Opening your card page in the browser…"
    : "Opening expert payout setup in the browser…";
}

/** The web dashboard home (calls, earnings, reviews, profile). Like the billing
 *  pages it authenticates the browser itself (GitHub cookie), so the CLI just opens
 *  the URL — a signed-out browser lands on `/app/login` (docs/WEBAPP-PRD.md §4.4). */
function dashboardUrl(): string {
  const { httpBase } = resolveEdge();
  return `${httpBase}/app`;
}

/** `termchat dashboard` — open the web dashboard in the browser (console output). */
export async function openDashboard(): Promise<void> {
  if (!readCredentials()) {
    console.error("Not logged in. Run `termchat login` first.");
    process.exitCode = 1;
    return;
  }
  const url = dashboardUrl();
  console.log(`\n  Your dashboard:\n  ${url}\n`);
  openUrl(url);
}

/** Same as {@link openDashboard}, for the chat TUI (`/dashboard`); returns a notice. */
export async function dashboardNotice(): Promise<string> {
  if (!readCredentials()) return "Sign in first with /login.";
  openUrl(dashboardUrl());
  return "Opening your dashboard in the browser…";
}
