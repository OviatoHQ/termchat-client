import { RoomName } from "@termchat/protocol";
import { render } from "ink";
import { checkToken } from "./auth.ts";
import { getOrCreateClientId, readCredentials, resolveEdge } from "./config.ts";
import { type DmController, createDmController } from "./dm-controller.ts";
import { LoungeClient } from "./lounge-client.ts";
import { MarketplaceClient } from "./marketplace-client.ts";
import { App } from "./tui/App.tsx";

/**
 * Launch the interactive lounge TUI. Connects to the edge with the stored
 * identity (1b) when present; otherwise joins anonymously (read-only).
 */
export async function runChat(roomArg: string | undefined): Promise<void> {
  const { httpBase, wsBase } = resolveEdge();
  const stored = readCredentials();
  const clientId = getOrCreateClientId();

  // Revalidate the stored token against the CURRENT edge before trusting it. A
  // token minted on a different environment (staging vs prod → different
  // AUTH_SECRETs) won't verify here — so joining with it just yields a silent
  // guest handle while the client thinks it's "signed in". On a hard rejection we
  // drop to a clean guest + a clear prompt; a network blip keeps the token
  // (offline-tolerant), so you're never logged out by a transient failure.
  let credentials = stored;
  let notice: string | undefined;
  if (stored) {
    const status = await checkToken(httpBase, stored.token);
    if (status.state === "rejected") {
      credentials = null;
      notice = `Your saved session isn't valid on ${httpBase.replace(/^https?:\/\//, "")} — run /login to sign in here.`;
    }
  }

  const parsedRoom = RoomName.safeParse(roomArg ?? "general");
  const room = parsedRoom.success ? parsedRoom.data : "general";

  const client = new LoungeClient({
    wsBase,
    clientId,
    room,
    ...(credentials ? { token: credentials.token } : {}),
  });
  client.connect();

  // The paid marketplace requires identity; only open it when logged in.
  let marketplace: MarketplaceClient | undefined;
  let dmController: DmController | undefined;
  if (credentials) {
    marketplace = new MarketplaceClient({ wsBase, clientId, token: credentials.token });
    marketplace.connect();
    // DMs are login-only (guests have no stable inbox); wire the controller in.
    dmController = createDmController({ wsBase, httpBase, token: credentials.token });
  }

  const user = credentials?.githubLogin ?? null;
  // `session` lets the TUI /login reconnect the lounge + hot-attach the marketplace
  // in place; it also builds the relay-only call URL (token + session in the URL
  // fragment so they never hit server logs).
  const { waitUntilExit } = render(
    <App
      client={client}
      user={user}
      token={credentials?.token ?? null}
      session={{ wsBase, httpBase, clientId }}
      {...(marketplace ? { marketplace } : {})}
      {...(dmController ? { dmController } : {})}
      {...(notice ? { notice } : {})}
    />,
  );
  await waitUntilExit();
  client.close();
}
