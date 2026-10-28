import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EARLIER_CODE as MENU_EARLIER, RESTART_CODE as MENU_RESTART } from "../electron/dev-session-menu.mjs";
import {
  APP_NAME,
  EARLIER_BUTTON,
  EARLIER_CODE,
  RESTART_CODE,
  SNAPSHOT_REFS,
  homeSessionUsable,
  installedSettings,
  command,
  defaultSettings,
  dialogScript,
  failureDetail,
  failureMessage,
  installApp,
  keep,
  launcherScript,
  listSnapshots,
  nextStep,
  openApp,
  parseSnapshots,
  plistChanges,
  prepareEarlier,
  quote,
  readState,
  recordSnapshot,
  refreshElectron,
  refreshLauncher,
  runSession,
  sessionEnv,
  snapshotLabel,
  snapshotWhen,
  takeLock,
} from "./dev-app.mjs";

const made = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-dev-app-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const until = async (check) => {
  for (let attempt = 0; attempt < 400 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" } }).trim();

function fixtureRepo() {
  const repo = scratch();
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  writeFileSync(join(repo, "app.txt"), "first\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "First screen");
  mkdirSync(join(repo, "node_modules"));
  return repo;
}

function fixtureCheckout() {
  const repo = scratch();
  const electron = join(repo, "node_modules", "electron");
  mkdirSync(join(electron, "dist", "Electron.app", "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(electron, "dist", "Electron.app", "Contents", "Resources"), { recursive: true });
  writeFileSync(join(electron, "dist", "Electron.app", "Contents", "Info.plist"), "<plist/>");
  writeFileSync(join(electron, "dist", "Electron.app", "Contents", "MacOS", "Electron"), "binary");
  writeFileSync(join(electron, "package.json"), JSON.stringify({ version: "43.7.9" }));
  mkdirSync(join(repo, "build", "dev"), { recursive: true });
  writeFileSync(join(repo, "build", "dev", "icon.icns"), "icon");
  return repo;
}

function recordingRun(calls) {
  return async (file, args, options) => {
    calls.push([file, ...args]);
    if (file === "cp") return command(file, args, options);
    return "";
  };
}

describe("the later.dog Dev app", () => {
  it("is a copy of Electron renamed later.dog Dev that opens through its own launcher", async () => {
    const repo = fixtureCheckout();
    const home = scratch();
    const calls = [];
    const settings = { repo, apps: join(home, "Applications"), state: join(home, "state"), logs: join(home, "logs"), dataHome: join(home, "data") };
    const target = await installApp({ ...settings, run: recordingRun(calls) });
    expect(target).toBe(join(home, "Applications", `${APP_NAME}.app`));
    const contents = join(target, "Contents");
    expect(readFileSync(join(contents, "MacOS", "Electron"), "utf8")).toBe("binary");
    expect(readFileSync(join(contents, "MacOS", APP_NAME), "utf8")).toBe(launcherScript());
    expect(statSync(join(contents, "MacOS", APP_NAME)).mode & 0o111).toBeTruthy();
    expect(readFileSync(join(contents, "Resources", "later-dog-dev.icns"), "utf8")).toBe("icon");
    expect(readFileSync(join(contents, "Resources", "laterdog-dev", "dev-app.mjs"), "utf8")).toBe(readFileSync(new URL("./dev-app.mjs", import.meta.url), "utf8"));
    expect(JSON.parse(readFileSync(join(contents, "Resources", "laterdog-dev", "install.json"), "utf8"))).toEqual({ ...settings, homeSession: null, electron: "43.7.9" });
    const plist = calls.filter(([file]) => file === "plutil").map(([, , key, , value]) => [key, value]);
    expect(plist).toEqual(plistChanges());
    expect(Object.fromEntries(plistChanges())).toMatchObject({ CFBundleName: APP_NAME, CFBundleExecutable: APP_NAME, CFBundleIdentifier: "dog.later.app.dev.source" });
    writeFileSync(join(contents, "stale-marker"), "old");
    await installApp({ ...settings, run: recordingRun([]) });
    expect(existsSync(join(contents, "stale-marker"))).toBe(false);
    expect(existsSync(join(settings.state, "staging"))).toBe(false);
  });

  it("rebuilds itself from the checkout when Electron moves to a new version, and otherwise just names its Electron", async () => {
    const checkout = fixtureCheckout();
    const bundle = "/Users/someone/Applications/later.dog Dev.app";
    const installs = [];
    const install = async (settings) => { installs.push(settings); };
    const current = { repo: checkout, bundle, electron: "43.7.9" };
    expect(await refreshElectron(current, checkout, install)).toBe(`${bundle}/Contents/MacOS/Electron`);
    expect(installs).toEqual([]);
    const behind = { repo: checkout, bundle, electron: "42.0.0" };
    expect(await refreshElectron(behind, checkout, install)).toBe(`${bundle}/Contents/MacOS/Electron`);
    expect(installs.map(({ source }) => source)).toEqual([`${bundle}/Contents/Resources/laterdog-dev/dev-app.mjs`]);
    expect(behind.electron).toBe("43.7.9");
    expect(await refreshElectron({ repo: checkout }, checkout, install)).toBeNull();
    expect(await refreshElectron(current, scratch(), install)).toBeNull();
  });

  it("installs next to later.dog in Applications, or in the person's own Applications when that is closed", () => {
    expect(defaultSettings({ repo: "/r", home: "/Users/someone", env: {}, canWrite: () => true })).toMatchObject({ apps: "/Applications", state: "/Users/someone/.laterdog-dev-tools/app", logs: "/Users/someone/Library/Logs/later.dog Dev", homeSession: "/Users/someone/.laterdog-dev-tools/my-home.session.json" });
    expect(defaultSettings({ repo: "/r", home: "/Users/someone", env: {}, canWrite: () => false }).apps).toBe("/Users/someone/Applications");
  });

  it("removes its own copy from the other Applications folder and nothing else", async () => {
    const repo = fixtureCheckout();
    const home = scratch();
    const shared = join(home, "shared");
    const own = join(home, "own");
    const unrelated = join(home, "unrelated");
    const earlier = join(own, `${APP_NAME}.app`, "Contents", "Resources", "laterdog-dev");
    mkdirSync(earlier, { recursive: true });
    writeFileSync(join(earlier, "install.json"), "{}");
    mkdirSync(join(unrelated, `${APP_NAME}.app`, "Contents"), { recursive: true });
    const calls = [];
    const target = await installApp({ repo, apps: shared, state: join(home, "state"), logs: join(home, "logs"), others: [shared, own, unrelated], run: recordingRun(calls) });
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(own, `${APP_NAME}.app`))).toBe(false);
    expect(existsSync(join(unrelated, `${APP_NAME}.app`))).toBe(true);
    expect(calls.filter(([file, flag]) => file.endsWith("lsregister") && flag === "-u").map(([, , path]) => path)).toEqual([join(own, `${APP_NAME}.app`)]);
  });

  it("says what to do when the checkout has no Electron yet", async () => {
    const home = scratch();
    await expect(installApp({ repo: scratch(), apps: join(home, "Applications"), state: join(home, "state"), logs: join(home, "logs") })).rejects.toThrow(/pnpm install/);
  });

  it("finds Node 24 or newer before handing over to the installed copy", () => {
    const script = launcherScript();
    expect(script.startsWith("#!/bin/bash\n")).toBe(true);
    expect(script).toContain('-ge 24000000');
    expect(script).toContain('exec "$node" "$contents/Resources/laterdog-dev/dev-app.mjs" open');
    const file = join(scratch(), "launcher");
    writeFileSync(file, script);
    execFileSync("bash", ["-n", file]);
  });

  it("asks the menu and the keeper for the same restart and earlier-version codes", () => {
    expect(RESTART_CODE).toBe(MENU_RESTART);
    expect(EARLIER_CODE).toBe(MENU_EARLIER);
  });
});

describe("versions that opened", () => {
  it("saves the code each opening ran, uncommitted and new files included, without touching the person's git state", async () => {
    const repo = fixtureRepo();
    const first = await recordSnapshot(repo, { now: 1_000 });
    expect(first).toMatchObject({ ref: `${SNAPSHOT_REFS}/1000`, message: "First screen", tree: git(repo, "rev-parse", "HEAD^{tree}") });
    writeFileSync(join(repo, "app.txt"), "second\n");
    writeFileSync(join(repo, "added.txt"), "new file\n");
    git(repo, "add", "app.txt");
    const before = git(repo, "status", "--porcelain");
    const second = await recordSnapshot(repo, { now: 2_000 });
    expect(git(repo, "status", "--porcelain")).toBe(before);
    expect(second.message).toBe("First screen, plus changes not yet committed");
    expect(git(repo, "show", `${second.commit}:added.txt`)).toBe("new file");
    expect(git(repo, "show", `${second.commit}:app.txt`)).toBe("second");
    expect(git(repo, "rev-parse", `${second.commit}^`)).toBe(git(repo, "rev-parse", "HEAD"));
    expect(await recordSnapshot(repo, { now: 3_000 })).toEqual(second);
    expect((await listSnapshots(repo)).map(({ at }) => at)).toEqual([2_000, 1_000]);
  });

  it("keeps only the newest versions", async () => {
    const repo = fixtureRepo();
    for (const [at, text] of [[1, "a"], [2, "b"], [3, "c"]]) {
      writeFileSync(join(repo, "app.txt"), text);
      await recordSnapshot(repo, { now: at, kept: 2 });
    }
    expect((await listSnapshots(repo)).map(({ at }) => at)).toEqual([3, 2]);
  });

  it("opens an earlier version in its own checkout that shares the installed packages", async () => {
    const repo = fixtureRepo();
    writeFileSync(join(repo, "added.txt"), "only in the first\n");
    const withFile = await recordSnapshot(repo, { now: 10 });
    rmSync(join(repo, "added.txt"));
    writeFileSync(join(repo, "app.txt"), "later\n");
    const without = await recordSnapshot(repo, { now: 20 });
    const settings = { repo, state: join(scratch(), "state") };
    const dir = await prepareEarlier(settings, withFile);
    expect(readFileSync(join(dir, "added.txt"), "utf8")).toBe("only in the first\n");
    expect(lstatSync(join(dir, "node_modules")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "node_modules"))).toBe(join(repo, "node_modules"));
    expect(await prepareEarlier(settings, without)).toBe(dir);
    expect(existsSync(join(dir, "added.txt"))).toBe(false);
    expect(readFileSync(join(dir, "app.txt"), "utf8")).toBe("later\n");
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("later\n");
  });

  it("reads saved versions newest first and ignores anything else", () => {
    const output = [`${SNAPSHOT_REFS}/5\tc5\tt5\tFix the sidebar`, `${SNAPSHOT_REFS}/9\tc9\tt9\tA\ttabbed subject`, "refs/heads/main\tc\tt\tmain", `${SNAPSHOT_REFS}/junk\tc\tt\tx`, ""].join("\n");
    expect(parseSnapshots(output)).toEqual([
      { ref: `${SNAPSHOT_REFS}/9`, at: 9, commit: "c9", tree: "t9", message: "A\ttabbed subject" },
      { ref: `${SNAPSHOT_REFS}/5`, at: 5, commit: "c5", tree: "t5", message: "Fix the sidebar" },
    ]);
  });

  it("names each version by when it opened", () => {
    const now = new Date(2026, 9, 27, 15, 0).getTime();
    expect(snapshotWhen(new Date(2026, 9, 27, 9, 2).getTime(), now)).toBe("today at 9:02 AM");
    expect(snapshotWhen(new Date(2026, 9, 26, 18, 30).getTime(), now)).toBe("yesterday at 6:30 PM");
    expect(snapshotWhen(new Date(2026, 9, 21, 7, 5).getTime(), now)).toBe("Oct 21 at 7:05 AM");
    expect(snapshotLabel({ at: new Date(2026, 9, 27, 9, 2).getTime(), message: "Fix the sidebar" }, now)).toBe("Today at 9:02 AM · Fix the sidebar");
  });
});

describe("what happens when a session ends", () => {
  const saved = [{ ref: `${SNAPSHOT_REFS}/2`, at: 2, commit: "c2", tree: "t2", message: "Two" }, { ref: `${SNAPSHOT_REFS}/1`, at: 1, commit: "c1", tree: "t1", message: "One" }];
  const asked = [];
  const options = (answer, chosen = saved[1]) => ({ version: null, logs: "/logs", list: async () => saved, ask: async (question) => { asked.push(question); return answer; }, choose: async () => chosen });

  it("quits on a normal quit or an interruption, and restarts the latest code from the menu", async () => {
    expect(await nextStep({ code: 0, ready: true, tail: [] }, options())).toEqual({ kind: "quit" });
    expect(await nextStep({ code: 1, ready: true, interrupted: true, tail: [] }, options())).toEqual({ kind: "quit" });
    expect(await nextStep({ code: RESTART_CODE, ready: true, tail: [] }, { ...options(), version: saved[0] })).toEqual({ kind: "start", version: null });
  });

  it("opens the version picked from the menu, or the same one again when the picker is closed", async () => {
    expect(await nextStep({ code: EARLIER_CODE, ready: true, tail: [] }, options())).toEqual({ kind: "start", version: saved[1] });
    expect(await nextStep({ code: EARLIER_CODE, ready: true, tail: [] }, { ...options(null, null), version: saved[0] })).toEqual({ kind: "start", version: saved[0] });
  });

  it("explains a failed start and offers to try again or open an earlier version", async () => {
    asked.length = 0;
    const failed = { code: 1, ready: false, tail: ["Port 8999 is already in use. Close the other Dev session; no existing process was stopped."] };
    expect(await nextStep(failed, options(EARLIER_BUTTON))).toEqual({ kind: "start", version: saved[1] });
    expect(asked[0].buttons).toEqual(["Quit", "Try Again", EARLIER_BUTTON]);
    expect(asked[0].message).toContain("didn't start");
    expect(asked[0].message).toContain("Port 8999 is already in use");
    expect(asked[0].message).toContain("/logs/session.log");
    expect(await nextStep(failed, options("Try Again"))).toEqual({ kind: "start", version: null });
    expect(await nextStep(failed, options("Quit"))).toEqual({ kind: "quit" });
    expect(await nextStep({ code: 9, ready: true, tail: [] }, { ...options("Restart"), list: async () => [] })).toEqual({ kind: "start", version: null });
    expect(asked.at(-1).buttons).toEqual(["Quit", "Restart"]);
  });

  it("shows the error and where it happened, not the stack", () => {
    const checkout = "/Users/someone/code/dog";
    const tail = [
      "later.dog supervisor listening on port 9110.",
      "node:internal/modules/run_main:107",
      "    triggerUncaughtException(",
      "    ^",
      `file://${checkout}/server/index.ts:1`,
      "const broken = ;",
      "               ^",
      "SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Expression expected",
      "    at stripTypeScriptModuleTypes (node:internal/modules/typescript:215:22)",
      "  code: 'ERR_INVALID_TYPESCRIPT_SYNTAX'",
      "}",
      "Node.js v24.22.1",
    ];
    expect(failureDetail(tail, checkout)).toEqual(["server/index.ts line 1", "SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Expression expected"]);
    expect(failureDetail(["just a line", "    at frame (x.js:1:1)"], checkout)).toEqual(["just a line"]);
    expect(failureMessage({ ready: false, code: 1, tail, checkout }, "/Users/someone/Library/Logs/later.dog Dev", "/Users/someone")).toBe(
      "later.dog Dev didn't start.\n\nserver/index.ts line 1\nSyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Expression expected\n\nFull log: ~/Library/Logs/later.dog Dev/session.log",
    );
  });

  it("says when there is no earlier version yet", async () => {
    asked.length = 0;
    expect(await nextStep({ code: EARLIER_CODE, ready: true, tail: [] }, { ...options("OK"), list: async () => [] })).toEqual({ kind: "start", version: null });
    expect(asked[0].message).toMatch(/no earlier versions yet/);
  });
});

describe("the keeper", () => {
  it("restarts, opens an earlier version, saves only the latest code, and stops when the app quits", async () => {
    const repo = "/fixture/repo";
    const state = join(scratch(), "state");
    const picked = { ref: `${SNAPSHOT_REFS}/7`, at: new Date(2026, 9, 27, 9, 2).getTime(), commit: "c7" };
    const ends = [RESTART_CODE, EARLIER_CODE, 0];
    const sessions = [];
    let saves = 0;
    const result = await keep({ repo, state, logs: join(state, "logs") }, {
      session: async ({ checkout, env, onReady }) => {
        sessions.push({ checkout, version: env.LATERDOG_DEV_SESSION_VERSION, electron: env.LATERDOG_DEV_ELECTRON, flag: env.LATERDOG_DEV_SESSION });
        expect(readState(state).phase).toBe("starting");
        await onReady();
        expect(readState(state).phase).toBe("ready");
        return { code: ends.shift(), ready: true, tail: [] };
      },
      list: async () => [picked],
      choose: async (saved) => saved[0],
      ask: async () => null,
      snapshot: async () => ({ ref: `${SNAPSHOT_REFS}/${++saves}` }),
      earlier: async (version) => `/fixture/earlier/${version.commit}`,
      electron: async () => "/Applications/later.dog Dev.app/Contents/MacOS/Electron",
      log: () => {},
    });
    expect(result).toBe("stopped");
    expect(sessions.map(({ checkout }) => checkout)).toEqual([repo, repo, "/fixture/earlier/c7"]);
    expect(sessions.map(({ version }) => version)).toEqual([undefined, undefined, snapshotWhen(picked.at)]);
    expect(sessions.every(({ flag, electron }) => flag === "1" && electron.endsWith("/MacOS/Electron"))).toBe(true);
    expect(saves).toBe(2);
    expect(readState(state).phase).toBe("stopped");
    expect(existsSync(join(state, "keeper.pid"))).toBe(false);
  });

  it("leaves a running keeper alone", () => {
    const state = scratch();
    const release = takeLock(state);
    expect(release).toBeTypeOf("function");
    expect(takeLock(state)).toBeNull();
    release();
    const again = takeLock(state);
    expect(again).toBeTypeOf("function");
    again();
  });

  it("clears a lock left by a keeper that is gone", () => {
    const state = scratch();
    writeFileSync(join(state, "keeper.pid"), "999999999");
    const release = takeLock(state);
    expect(release).toBeTypeOf("function");
    release();
  });

  it("gives each session the Dev flags, the chosen data folder and the renamed Electron", () => {
    const env = sessionEnv({ dataHome: "/isolated/home" }, { at: new Date(2026, 9, 27, 9, 2).getTime() }, "/Apps/later.dog Dev.app/Contents/MacOS/Electron", { PATH: "/usr/bin", LATERDOG_DEV_ELECTRON: "/stale" }, new Date(2026, 9, 27, 12, 0).getTime());
    expect(env).toEqual({ PATH: "/usr/bin", LATERDOG_DEV_SESSION: "1", LATERDOG_DEV_SESSION_VERSION: "today at 9:02 AM", LATERDOG_DEV_ELECTRON: "/Apps/later.dog Dev.app/Contents/MacOS/Electron", LATERDOG_HOME: "/isolated/home" });
    expect(sessionEnv({ dataHome: null }, null, null, { LATERDOG_DEV_SESSION_VERSION: "old" })).toEqual({ LATERDOG_DEV_SESSION: "1" });
  });

  it("is a window onto the later.dog Cloud whenever this Mac has a usable home session, and the local Dev workspace otherwise", () => {
    const tools = scratch();
    const session = join(tools, "my-home.session.json");
    const settings = { dataHome: null, homeSession: session };
    const inherited = { PATH: "/usr/bin", LATERDOG_DEV_HOME_SESSION: "/stale.json" };
    expect(sessionEnv(settings, null, null, inherited)).toEqual({ PATH: "/usr/bin", LATERDOG_DEV_SESSION: "1" });
    writeFileSync(session, JSON.stringify({ url: "https://h1-home.later.dog", token: "laterdog_sess_abc" }));
    expect(homeSessionUsable(session)).toBe(true);
    expect(sessionEnv(settings, null, null, inherited)).toEqual({ PATH: "/usr/bin", LATERDOG_DEV_SESSION: "1", LATERDOG_DEV_HOME_SESSION: session });
    for (const broken of [{ url: "http://example.test", token: "laterdog_sess_abc" }, { url: "https://h1-home.later.dog", token: "nope" }]) {
      writeFileSync(session, JSON.stringify(broken));
      expect(sessionEnv(settings, null, null, inherited)).toEqual({ PATH: "/usr/bin", LATERDOG_DEV_SESSION: "1" });
    }
    expect(sessionEnv({ dataHome: null, homeSession: null }, null, null, inherited)).toEqual({ PATH: "/usr/bin", LATERDOG_DEV_SESSION: "1" });
  });

  it("checks the home session at every start, so connecting later takes effect on the next restart", async () => {
    const state = join(scratch(), "state");
    const ends = [RESTART_CODE, 0];
    const seen = [];
    let connected = false;
    await keep({ repo: "/fixture/repo", state, logs: join(state, "logs"), homeSession: "/tools/my-home.session.json" }, {
      session: async ({ env, onReady }) => {
        seen.push(env.LATERDOG_DEV_HOME_SESSION ?? null);
        connected = true;
        await onReady();
        return { code: ends.shift(), ready: true, tail: [] };
      },
      list: async () => [],
      choose: async () => null,
      ask: async () => null,
      snapshot: async () => ({ ref: "saved" }),
      earlier: async () => "/unused",
      electron: async () => null,
      log: () => {},
      usable: () => connected,
    });
    expect(seen).toEqual([null, "/tools/my-home.session.json"]);
  });

  it("reads the home session from an install made before it was saved, but never for an isolated install", () => {
    const own = join(scratch(), "Contents", "Resources", "laterdog-dev");
    mkdirSync(own, { recursive: true });
    const file = join(own, "dev-app.mjs");
    writeFileSync(join(own, "install.json"), JSON.stringify({ repo: "/r", state: "/s", logs: "/l", dataHome: null }));
    expect(installedSettings(file, { home: "/Users/someone", env: {} }).homeSession).toBe("/Users/someone/.laterdog-dev-tools/my-home.session.json");
    writeFileSync(join(own, "install.json"), JSON.stringify({ repo: "/r", state: "/s", logs: "/l", dataHome: "/isolated" }));
    expect(installedSettings(file, { home: "/Users/someone", env: {} }).homeSession).toBeNull();
    writeFileSync(join(own, "install.json"), JSON.stringify({ repo: "/r", state: "/s", logs: "/l", dataHome: null, homeSession: null }));
    expect(installedSettings(file, { home: "/Users/someone", env: {} }).homeSession).toBeNull();
  });

  it("has the session write its own log, keeps its last lines without colour, and notices once when the app is ready", async () => {
    const logs = scratch();
    writeFileSync(join(logs, "session.log"), "earlier session\n");
    let readyCalls = 0;
    let options;
    const child = Object.assign(new EventEmitter(), { kill: () => {} });
    let out;
    const done = runSession({ checkout: "/repo", env: {}, logs, pollMs: 1, onReady: () => { readyCalls++; }, spawnProcess: (_file, _args, given) => { options = given; out = openSync(join(logs, "session.log"), "a"); return child; }, signals: new EventEmitter() });
    const err = out;
    expect(options.stdio.slice(1).every((fd) => Number.isInteger(fd))).toBe(true);
    writeSync(out, `${String.fromCharCode(27)}[32mVITE ready${String.fromCharCode(27)}[0m\n`);
    writeSync(out, "later.dog Dev: http://127.0.0.1:5299 (renderer hot reload).\n");
    await until(() => readyCalls === 1);
    writeSync(err, "later.dog Dev: http://127.0.0.1:5299 again\n");
    child.emit("close", 75, null);
    const result = await done;
    expect(result).toEqual({ code: 75, ready: true, interrupted: false, checkout: "/repo", tail: ["VITE ready", "later.dog Dev: http://127.0.0.1:5299 (renderer hot reload).", "later.dog Dev: http://127.0.0.1:5299 again"] });
    expect(readyCalls).toBe(1);
    expect(readFileSync(join(logs, "session.previous.log"), "utf8")).toBe("earlier session\n");
    expect(readFileSync(join(logs, "session.log"), "utf8")).toContain("later.dog Dev: http://127.0.0.1:5299 again");
    closeSync(out);
  });

  it("keeps the session and its readiness when a cleaner deletes the log folder mid-session", async () => {
    const logs = join(scratch(), "later.dog Dev");
    let readyCalls = 0;
    const child = Object.assign(new EventEmitter(), { kill: () => {} });
    let out;
    const done = runSession({ checkout: "/repo", env: {}, logs, pollMs: 1, onReady: () => { readyCalls++; }, spawnProcess: () => { out = openSync(join(logs, "session.log"), "a"); return child; }, signals: new EventEmitter() });
    writeSync(out, "server starting\n");
    rmSync(logs, { recursive: true, force: true });
    expect(existsSync(logs)).toBe(false);
    writeSync(out, "later.dog Dev: http://127.0.0.1:5299 (renderer hot reload).\n");
    writeSync(out, "[laterdog-turn] bot=dog text=hey\n");
    await until(() => readyCalls === 1);
    child.emit("close", 0, null);
    const result = await done;
    expect(result.ready).toBe(true);
    expect(result.tail).toEqual(["server starting", "later.dog Dev: http://127.0.0.1:5299 (renderer hot reload).", "[laterdog-turn] bot=dog text=hey"]);
    closeSync(out);
  });

  it("reports a session that could not start at all instead of failing the keeper", async () => {
    const result = await runSession({ checkout: "/repo", env: {}, logs: scratch(), spawnProcess: () => { throw new Error("spawn node ENOENT"); }, signals: new EventEmitter() });
    expect(result).toEqual({ code: 1, ready: false, interrupted: false, tail: ["spawn node ENOENT"], checkout: "/repo" });
  });

  it("stops the session and quits quietly when the keeper is told to stop", async () => {
    const signals = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { kill: () => child.emit("close", null, "SIGTERM") });
    const done = runSession({ checkout: "/repo", env: {}, logs: scratch(), spawnProcess: () => child, signals });
    signals.emit("SIGTERM");
    const result = await done;
    expect(result.interrupted).toBe(true);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(await nextStep(result, { version: null, logs: "/logs", list: async () => [], ask: async () => "Restart", choose: async () => null })).toEqual({ kind: "quit" });
  });

  it("updates only the launcher of an open app, atomically", () => {
    const target = join(scratch(), `${APP_NAME}.app`);
    const own = join(target, "Contents", "Resources", "laterdog-dev");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "dev-app.mjs"), "old launcher");
    writeFileSync(join(own, "install.json"), "{\"kept\":true}");
    const source = join(scratch(), "dev-app.mjs");
    writeFileSync(source, "new launcher");
    refreshLauncher(target, source);
    expect(readFileSync(join(own, "dev-app.mjs"), "utf8")).toBe("new launcher");
    expect(readFileSync(join(own, "install.json"), "utf8")).toBe("{\"kept\":true}");
    expect(readdirSync(own).sort()).toEqual(["dev-app.mjs", "install.json"]);
  });

  it("starts a keeper when none runs and returns once the app is ready", async () => {
    const state = scratch();
    let started = 0;
    let clock = 1_000;
    const phase = await openApp({ state }, {
      startKeeper: () => {
        started++;
        writeFileSync(join(state, "keeper.pid"), String(process.pid));
        writeFileSync(join(state, "state.json"), JSON.stringify({ phase: "ready", at: 2_000 }));
      },
      pause: async () => { clock += 250; },
      now: () => clock,
    });
    expect(phase).toBe("ready");
    expect(started).toBe(1);
  });
});

describe("dialogs", () => {
  it("keep quotes, backslashes and line breaks intact", () => {
    expect(quote('say "hi"\\now')).toBe('"say \\"hi\\"\\\\now"');
    expect(quote("one\ntwo")).toBe('"one" & linefeed & "two"');
    expect(dialogScript({ message: "Broke\nhere", buttons: ["Quit", "Try Again"], defaultButton: "Try Again", cancelButton: "Quit" })).toBe(
      `display dialog "Broke" & linefeed & "here" with title "${APP_NAME}" buttons {"Quit", "Try Again"} default button "Try Again" cancel button "Quit" with icon caution`,
    );
  });
});
