import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import environments from "./environments.cjs";
import { CLOUD_HOME_NAME, savedCloudHomeOrigin, withCloudHome } from "./cloud-home.mjs";
import { createHomeRetry, HOME_RETRY_DELAYS_MS, isTryAgainLink, TRY_AGAIN_URL, unreachableLine, unreachablePage, unreachablePageUrl } from "./home-unreachable.mjs";

const HOME = "https://home.fixture.test";
const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function retry({ reconnect = async () => {} } = {}) {
  const log = { shown: [], timers: [], reconnects: [], logs: [] };
  const controller = createHomeRetry({
    reconnect: async target => { log.reconnects.push(target.origin); return reconnect(target); },
    show: url => log.shown.push(url),
    setTimer: (run, ms) => { const timer = { run, ms }; log.timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; },
    log: line => log.logs.push(line),
  });
  return { controller, log };
}

const pending = log => log.timers.filter(timer => !timer.cleared && !timer.ran);
const settled = () => new Promise(resolve => setImmediate(resolve));
const fire = async timer => { timer.ran = true; timer.run(); await settled(); };

test("the page says one plain line with Try again, and names the home in plain words", () => {
  assert.equal(unreachableLine({ name: CLOUD_HOME_NAME, home: true }), "Couldn't reach your home");
  assert.equal(unreachableLine({ name: "Studio", home: false }), "Couldn't reach Studio");
  const page = unreachablePage({ name: CLOUD_HOME_NAME, home: true });
  assert.match(page, /Couldn&#39;t reach your home · <a href="https:\/\/try-again\.invalid\/">Try again<\/a>/);
  assert.doesNotMatch(page, /this Mac|local|<script/i);
  assert.match(page, /prefers-color-scheme: light/);
  assert.ok(decodeURIComponent(unreachablePageUrl({ name: CLOUD_HOME_NAME, home: true }).replace(/^data:text\/html;charset=utf-8,/, "")) === page);
  assert.match(unreachablePage({ name: "<b>&\"x'</b>" }), /Couldn&#39;t reach &lt;b&gt;&amp;&quot;x&#39;&lt;\/b&gt;/);
});

test("only the exact Try again link is caught", () => {
  assert.equal(isTryAgainLink(TRY_AGAIN_URL), true);
  assert.equal(isTryAgainLink("https://try-again.invalid"), true);
  for (const url of ["https://try-again.invalid/x", "https://home.fixture.test/", "http://try-again.invalid/", "not a url", ""]) assert.equal(isTryAgainLink(url), false, url);
});

test("a failed load stays on the home, shows the line and tries again with growing waits up to five minutes", async () => {
  const { controller, log } = retry();
  const target = { origin: HOME, name: CLOUD_HOME_NAME, home: true };
  const waits = [];
  for (let i = 0; i < HOME_RETRY_DELAYS_MS.length + 2; i++) {
    waits.push(controller.failed(target));
    await fire(pending(log).at(-1));
  }
  assert.deepEqual(waits, [5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
  assert.equal(log.reconnects.length, waits.length);
  assert.ok(log.reconnects.every(origin => origin === HOME));
  assert.equal(log.shown.length, waits.length);
  assert.ok(log.shown.every(url => url.startsWith("data:text/html")), "the window never loads this Mac's page");
  assert.equal(controller.failing(), HOME);
});

test("a page that loads ends the retries, and the next failure starts again from the shortest wait", async () => {
  const { controller, log } = retry();
  const target = { origin: HOME, name: CLOUD_HOME_NAME, home: true };
  controller.failed(target);
  controller.failed(target);
  controller.loaded();
  assert.equal(controller.failing(), null);
  assert.equal(pending(log).length, 0);
  assert.equal(controller.failed(target), 5_000);
});

test("Try again reconnects at once and resets the wait", async () => {
  const { controller, log } = retry();
  const target = { origin: HOME, name: CLOUD_HOME_NAME, home: true };
  controller.failed(target);
  controller.failed(target);
  controller.failed(target);
  assert.equal(controller.tryNow(), true);
  await settled();
  assert.deepEqual(log.reconnects, [HOME]);
  assert.equal(pending(log).length, 0);
  assert.equal(controller.failed(target), 5_000);
  controller.stop();
  assert.equal(controller.tryNow(), false);
});

test("pressing Try again while a reconnect is still running does not start a second one", async () => {
  let finish;
  const { controller, log } = retry({ reconnect: () => new Promise(resolve => { finish = resolve; }) });
  controller.failed({ origin: HOME, name: CLOUD_HOME_NAME, home: true });
  assert.equal(controller.tryNow(), true);
  assert.equal(controller.tryNow(), true);
  await settled();
  assert.deepEqual(log.reconnects, [HOME]);
  finish();
  await settled();
  controller.tryNow();
  await settled();
  assert.deepEqual(log.reconnects, [HOME, HOME], "once it ends, Try again reconnects again");
});

test("a reconnect that throws before loading keeps the line up and schedules the next try without reloading it", async () => {
  const { controller, log } = retry({ reconnect: async () => { throw new Error("My Cloud is not ready to connect yet."); } });
  controller.failed({ origin: HOME, name: CLOUD_HOME_NAME, home: true });
  await fire(pending(log)[0]);
  assert.equal(log.shown.length, 1);
  assert.deepEqual(pending(log).map(timer => timer.ms), [15_000]);
  assert.match(log.logs[0], /Couldn't reach your home \(My Cloud is not ready to connect yet\.\); trying again/);
});

test("main.mjs never sends the window to this Mac's dogs when a remote or the Cloud home fails to load", () => {
  const handlers = main.split('win.webContents.on("did-fail-load"').slice(1).map(chunk => chunk.slice(0, chunk.indexOf("\n  });")));
  assert.equal(handlers.length, 2);
  const remote = handlers.find(body => body.includes("activeEnvironment(environmentsState);"));
  assert.ok(remote);
  assert.doesNotMatch(remote, /LOCAL_ID|switchEnvironment|showMessageBox/);
  assert.match(remote, /ensureHomeRetry\(\)\.failed\(/);
  assert.doesNotMatch(main, /homeFellBack|fellBack|showLocal|Showing the local server|showing this computer/);
  const windowSource = readFileSync(new URL("./cloud-window.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(windowSource, /showLocal|screen: null/);
});

test("main.mjs catches the Try again link before the navigation guard", () => {
  const guard = main.slice(main.indexOf("const guardNavigation = (event, url) => {"), main.indexOf('win.webContents.on("will-navigate", guardNavigation);'));
  assert.ok(guard.indexOf("isTryAgainLink(url)") >= 0 && guard.indexOf("isTryAgainLink(url)") < guard.indexOf("workspaceNavigationAllowed("));
  assert.match(guard, /event\.preventDefault\(\);\n\s+homeRetry\?\.tryNow\(\);/);
});

function homeContext({ activeId = "local", environmentsList = [], signedIn = true, connect = async () => {}, reachable = true } = {}) {
  const calls = [];
  const context = vm.createContext({
    AbortSignal,
    session: { defaultSession: { fetch: async (url, init) => {
      calls.push(["probe", url, init.method, init.credentials]);
      if (!reachable) throw new Error("net::ERR_CONNECTION_REFUSED");
      return new Response(null, { status: 503 });
    } } },
    environmentsState: { activeId, environments: environmentsList },
    withCloudHome, withActive: environments.withActive, activeEnvironment: environments.activeEnvironment, savedCloudHomeOrigin,
    randomUUID: () => "cloud-new",
    persistEnvironments: next => { calls.push(["persist", next.activeId]); context.environmentsState = next; },
    navigateMainWindow: url => calls.push(["navigate", url]),
    connectCloudHome: async () => { calls.push(["connect"]); return connect(); },
    cloudAccount: { state: () => ({ account: signedIn ? { id: "a" } : null }) },
    createHomeRetry: options => {
      const controller = createHomeRetry({ ...options, setTimer: (run, ms) => { calls.push(["timer", ms]); return { run, ms }; }, clearTimer: () => {} });
      return { ...controller, failed: target => { calls.push(["failed", target.origin, target.home]); return controller.failed(target); } };
    },
    homeRetry: null, slog: line => calls.push(["log", line]),
  });
  vm.runInContext(main.slice(main.indexOf("function stayOnCloudHome("), main.indexOf("function syncCloudWindow(")), context);
  return { context, calls };
}

test("when the home can't be connected after sign-in, the window still switches to the home and shows the line", () => {
  const { context, calls } = homeContext();
  context.stayOnCloudHome(HOME);
  assert.equal(context.environmentsState.activeId, "cloud-new");
  assert.equal(context.environmentsState.environments[0].origin, HOME);
  assert.deepEqual(calls.slice(0, 2), [["persist", "cloud-new"], ["failed", HOME, true]]);
  assert.ok(calls.some(([kind, url]) => kind === "navigate" && url.startsWith("data:text/html")));
  assert.equal(calls.some(([kind, url]) => kind === "navigate" && !url.startsWith("data:")), false);
});

test("retrying the home reconnects through Cloud sign-in, and a retry for a workspace no longer open stops", async () => {
  const home = { id: "cloud-1", name: CLOUD_HOME_NAME, origin: HOME };
  const { context, calls } = homeContext({ activeId: "cloud-1", environmentsList: [home] });
  await context.reconnectRemote({ origin: HOME });
  assert.deepEqual(calls, [["probe", `${HOME}/`, "HEAD", "omit"], ["connect"]], "any answer from the home, even a waking 503, lets it load");
  calls.length = 0;
  context.ensureHomeRetry().failed({ origin: "https://elsewhere.fixture.test", name: "Elsewhere" });
  await context.reconnectRemote({ origin: "https://elsewhere.fixture.test" });
  assert.equal(context.homeRetry.failing(), null);
  assert.equal(calls.some(([kind]) => kind === "connect"), false);
});

test("retrying another saved workspace just loads it again", async () => {
  const other = { id: "studio", name: "Studio", origin: "https://studio.fixture.test" };
  const { context, calls } = homeContext({ activeId: "studio", environmentsList: [other] });
  await context.reconnectRemote({ origin: other.origin });
  assert.deepEqual(calls, [["probe", `${other.origin}/`, "HEAD", "omit"], ["navigate", other.origin]]);
});

test("while the home still does not answer, a retry leaves the line on screen instead of reloading the window or asking Cloud for a new pairing", async () => {
  const home = { id: "cloud-1", name: CLOUD_HOME_NAME, origin: HOME };
  const { context, calls } = homeContext({ activeId: "cloud-1", environmentsList: [home], reachable: false });
  await assert.rejects(context.reconnectRemote({ origin: HOME }), /ERR_CONNECTION_REFUSED/);
  assert.deepEqual(calls.map(([kind]) => kind), ["probe"]);
});
