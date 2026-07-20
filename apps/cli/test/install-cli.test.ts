import { expect, test } from "bun:test";
import { renderBanner } from "../src/banner.ts";
import { parseInstallArgs } from "../src/install-cli.ts";

test("banner renders the square mark, the wordmark, and the tagline", () => {
  const banner = renderBanner();
  expect(banner).toContain("██"); // the two-square brand mark
  expect(banner).toContain("termchat");
  expect(banner).toContain("You don't have to wait alone.");
});

test("parseInstallArgs reads --edge, --yes, and the status-line flags", () => {
  expect(parseInstallArgs([])).toEqual({});
  expect(parseInstallArgs(["--yes"])).toEqual({ yes: true });
  expect(parseInstallArgs(["-y"])).toEqual({ yes: true });
  expect(parseInstallArgs(["--statusline"])).toEqual({ statusline: true });
  expect(parseInstallArgs(["--no-statusline"])).toEqual({ statusline: false });
  expect(parseInstallArgs(["--edge", "https://staging.example"])).toEqual({
    edge: "https://staging.example",
  });
  expect(parseInstallArgs(["-y", "--edge", "https://x"])).toEqual({ yes: true, edge: "https://x" });
});
