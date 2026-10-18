import { createRoot } from "react-dom/client";
import { applySkin, readSkin } from "../../src/lib/skins";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const home = params.get("mode") === "home";

const post = async (path: string, body: unknown) => (await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const call = (method: string, ...args: unknown[]) => post("/__bridge/call", { method, args });

type Snapshot = { account: any; move: any; entered: boolean };
const listeners = new Set<(snapshot: Snapshot) => void>();
let polling = false;
const poll = async () => {
  try {
    const snapshot: Snapshot = await (await fetch("/__bridge/snapshot")).json();
    if (!home && snapshot.entered) { location.search = "?mode=home"; return; }
    for (const listener of listeners) listener(snapshot);
  } catch {}
  setTimeout(poll, 400);
};

function subscribe<T>(pick: (snapshot: Snapshot) => T, callback: (value: T) => void) {
  let last = "";
  const listener = (snapshot: Snapshot) => {
    const value = pick(snapshot);
    const text = JSON.stringify(value);
    if (text !== last) { last = text; callback(value); }
  };
  listeners.add(listener);
  if (!polling) { polling = true; void poll(); }
  return () => { listeners.delete(listener); };
}

const cloudMove = {
  state: () => call("moveState"),
  start: () => call("moveStart"),
  cancel: () => call("moveState"),
  dismiss: () => call("moveDismiss"),
  restorePrevious: () => call("moveState"),
  onState: (callback: (state: unknown) => void) => subscribe((snapshot) => snapshot.move, callback),
};

const cloudAccount = {
  state: () => call("state"),
  sendCode: (email: string) => call("sendCode", email),
  verifyCode: (email: string, code: string) => call("verifyCode", email, code),
  offer: () => call("offer"),
  declineOffer: () => call("declineOffer"),
  connectHome: () => call("connectHome"),
  signOut: () => call("signOut"),
  onState: (callback: (state: unknown) => void) => subscribe((snapshot) => snapshot.account, callback),
};

const cloudPlan = { state: async () => ({ status: "paid", tier: "beta" }), manage: async () => {}, signOut: () => call("signOut") };

(window as unknown as { laterdog: unknown }).laterdog = home
  ? { platform: "darwin", cloudMove, cloudPlan }
  : { platform: "darwin", localPage: true, cloudAccount, cloudMove, cloudPlan };

if (home) {
  const nativeFetch = window.fetch.bind(window);
  const cloudHomeFields = (url: string) => url.startsWith("/api/config") || url.startsWith("/api/auth/session");
  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (!cloudHomeFields(url) || (init?.method ?? "GET") !== "GET" || !response.ok) return response;
    const body = await response.clone().json();
    return new Response(JSON.stringify({ ...body, cloudHome: true }), { status: response.status, headers: response.headers });
  };
}

setAnalyticsEnabled(false);
if (!params.has("onboarding")) setEmailGateDone("skipped");
applySkin(readSkin());
const { default: App } = await import("../../src/App");
createRoot(document.getElementById("root")!).render(<App />);
