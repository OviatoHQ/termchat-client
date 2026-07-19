/** Open a URL in the user's browser (best effort; skipped when headless/tests). */
export function openUrl(url: string): void {
  if (process.env.TERMCHAT_NO_BROWSER === "1") return;
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    Bun.spawn([command, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // The URL is surfaced in the UI regardless.
  }
}
