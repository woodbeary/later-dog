import type { IncomingMessage, ServerResponse } from "node:http";
import { createCloudAccountClient } from "../../electron/cloud-account.mjs";
import { createCloudOffer } from "../../electron/cloud-default-home.mjs";
import { CloudSignInError, createCloudSignIn } from "../../electron/cloud-sign-in.mjs";
import { startFakeAccounts } from "../../electron/fixtures/fake-accounts.mjs";
import type { PreviewRoute } from "./preview-fixture.ts";

const HOME = "https://home.fixture.test";

interface Harness {
  accounts: Awaited<ReturnType<typeof startFakeAccounts>>;
  client: ReturnType<typeof createCloudAccountClient>;
  signIn: ReturnType<typeof createCloudSignIn>;
  offer: ReturnType<typeof createCloudOffer>;
  offered: { value: string | null };
  entered: boolean;
  move: Record<string, unknown>;
  automatic: boolean;
  signedOutSeen: number;
}

let harness: Promise<Harness> | null = null;

async function create(): Promise<Harness> {
  const accounts = await startFakeAccounts({ homeOrigin: HOME });
  const saved: { value: unknown } = { value: null };
  const offered: { value: string | null } = { value: null };
  const made = {
    accounts, offered, entered: false, move: { phase: "idle" }, automatic: true, signedOutSeen: 0,
    offer: createCloudOffer({ read: () => offered.value, write: (contents) => { offered.value = contents; } }),
  } as unknown as Harness;
  made.client = createCloudAccountClient({
    origin: accounts.origin, fixture: true, deviceName: "Fixture Mac", platform: "darwin", appVersion: "0.0.fixture",
    store: { read: async () => saved.value, write: async (value) => { saved.value = structuredClone(value); } },
    openBrowser: async () => { throw new Error("the fixture never opens a browser"); },
    onState: (state) => {
      if (state.status === "connected") made.offer.signedIn();
    },
  });
  made.signIn = createCloudSignIn({ origin: accounts.origin, deviceName: "Fixture Mac", platform: "darwin", appVersion: "0.0.fixture" });
  await made.client.start();
  return made;
}

const ensure = () => (harness ??= create());

async function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const send = (res: ServerResponse, value: unknown, status = 200) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
};

async function outcome(work: () => Promise<Record<string, unknown>>) {
  try { return { ok: true, ...(await work()) }; } catch (error) {
    return { ok: false, code: error instanceof CloudSignInError ? error.code : "unavailable" };
  }
}

async function call(h: Harness, method: string, args: any[]) {
  if (method === "state") return h.client.state();
  if (method === "sendCode") return outcome(async () => ({ email: await h.signIn.sendCode(args[0]) }));
  if (method === "verifyCode") {
    return outcome(async () => {
      const grant = await h.signIn.verifyCode(args[0], args[1]);
      const state = await h.client.adopt(grant);
      if (!state.account) throw new CloudSignInError("unavailable");
      return { account: state };
    });
  }
  if (method === "offer") return { due: h.offer.due() };
  if (method === "declineOffer") { h.offer.decline(); return { due: false }; }
  if (method === "connectHome") { h.entered = true; return h.client.state(); }
  if (method === "signOut") { h.entered = false; return h.client.signOut(); }
  if (method === "moveState") return { phase: "idle", ...h.move, local: null, cloud: null, fit: null, suggest: false, blocked: null,
    ...(h.automatic ? { automatic: true } : {}), destination: { id: "cloud", name: "My Cloud", origin: HOME, kind: "cloud" } };
  if (method === "moveStart") { h.move = { phase: "uploading", action: "move", progress: { bytesTransferred: 10, totalBytes: 100 }, destination: { id: "cloud", name: "My Cloud", origin: HOME, kind: "cloud" } }; return h.move; }
  if (method === "moveDismiss") { h.move = { phase: "idle" }; return call(h, "moveState", []); }
  throw new Error(`unknown bridge call ${method}`);
}

async function control(h: Harness, body: Record<string, any>) {
  if (body.reset) {
    await h.client.signOut();
    h.offered.value = null; h.entered = false; h.move = { phase: "idle" }; h.automatic = true;
    h.accounts.homeState = "ready"; h.accounts.setup = undefined; h.accounts.otp = h.accounts.goodCode; h.accounts.failSend = null;
    h.accounts.sent.length = 0; h.accounts.requests.length = 0; h.accounts.signedOut.length = 0;
  }
  if (body.homeState) { h.accounts.homeState = body.homeState; h.accounts.setup = body.setup; }
  if (body.move) h.move = body.move;
  if (body.automatic !== undefined) h.automatic = body.automatic === true;
  if (body.entered !== undefined) h.entered = body.entered === true;
  if (body.refresh) await h.client.refresh();
  if (body.otp) h.accounts.otp = body.otp;
  if (body.failSend !== undefined) h.accounts.failSend = body.failSend;
  return { ok: true, sent: h.accounts.sent, signedOut: h.accounts.signedOut.length, requests: h.accounts.requests.map((row) => row.route) };
}

export function desktopSigninRoutes(): PreviewRoute[] {
  const handle = (run: (h: Harness, body: Record<string, any>) => Promise<unknown>): PreviewRoute["handler"] => async (req, res) => {
    try { send(res, await run(await ensure(), await readBody(req))); } catch (error) { send(res, { error: String(error) }, 500); }
  };
  return [
    { path: "/__bridge/call", method: "POST", handler: handle((h, body) => call(h, String(body.method), Array.isArray(body.args) ? body.args : [])) },
    { path: "/__bridge/control", method: "POST", handler: handle(control) },
    { path: "/__bridge/snapshot", method: "GET", handler: handle(async (h) => ({
      account: await call(h, "state", []), move: await call(h, "moveState", []), entered: h.entered,
    })) },
  ];
}
