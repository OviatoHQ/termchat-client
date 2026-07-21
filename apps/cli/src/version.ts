// The client's released version. `scripts/publish-client.ts --release` stamps it
// into package.json at publish time and tags the public repo `v<VERSION>`, so what
// a user reports here maps exactly to a tag on OviatoHQ/termchat-client.
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
