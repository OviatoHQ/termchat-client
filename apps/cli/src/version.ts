// The client's released version. `scripts/publish-client.ts --release` stamps it
// into package.json at publish time and tags the public repo `v<VERSION>`, so what
// a user reports here maps exactly to a tag on OviatoHQ/termchat-client.
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

/** The placeholder a manifest carries before it has ever been stamped by a release. */
const UNRELEASED = "0.0.0";

/**
 * What the UI shows. An unstamped tree renders `dev` rather than `0.0.0` — the raw
 * placeholder reads as a broken build to anyone glancing at the header, while `dev` says
 * exactly what it is. {@link VERSION} keeps the literal value for anything that needs to
 * compare or report it (`termchat version` prints that, not this).
 */
export const VERSION_LABEL: string = VERSION === UNRELEASED ? "dev" : VERSION;
