import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { APP_LINK_CHANNEL, createAppLinks } from "./app-links.mjs";
import { openExternalLogged } from "./external-open.mjs";

function contents() {
  const sent = [];
  let destroyed = false;
  return {
    sent,
    send: (channel, value) => sent.push([channel, value]),
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true; },
  };
}

function slot() {
  const lines = [];
  let reveals = 0;
  const links = createAppLinks({ reveal: () => { reveals += 1; }, log: line => lines.push(line), otherHosts: ["cloud", "install"] });
  return { links, lines, reveals: () => reveals };
}

test("a cold-start link waits for the app to say it is ready, and the latest link wins", () => {
  const { links, lines, reveals } = slot();
  assert.equal(links.accept("laterdog-dev://chat/first?thread=t1"), true);
  assert.equal(links.accept("laterdog-dev://settings?section=usage"), true);
  assert.equal(links.pending(), "laterdog://settings?section=usage");
  assert.equal(reveals(), 2);
  const page = contents();
  assert.equal(links.ready(page), true);
  assert.deepEqual(page.sent, [[APP_LINK_CHANNEL, "laterdog://settings?section=usage"]]);
  assert.equal(links.pending(), null);
  assert.deepEqual(lines, ["app link held: laterdog-dev://chat", "app link held: laterdog-dev://settings", "app link opened: laterdog-dev://settings"]);
});

test("a warm link goes straight to the ready page", () => {
  const { links } = slot();
  const page = contents();
  links.ready(page);
  links.accept("laterdog://dog/boat");
  assert.deepEqual(page.sent, [[APP_LINK_CHANNEL, "laterdog://dog/boat"]]);
});

test("a navigating or destroyed page holds links until the next page is ready", () => {
  const { links } = slot();
  const first = contents();
  links.ready(first);
  links.notReady(first);
  links.accept("laterdog://dog/boat");
  assert.deepEqual(first.sent, []);
  const second = contents();
  links.ready(second);
  second.destroy();
  links.accept("laterdog://dog/kite");
  assert.equal(links.pending(), "laterdog://dog/kite");
  const third = contents();
  links.ready(third);
  assert.deepEqual(second.sent, [[APP_LINK_CHANNEL, "laterdog://dog/boat"]]);
  assert.deepEqual(third.sent, [[APP_LINK_CHANNEL, "laterdog://dog/kite"]]);
});

test("a navigation that is blocked or never commits leaves the page ready, and links held meanwhile arrive when it stays", () => {
  const { links } = slot();
  const page = contents();
  links.ready(page);
  links.navigating(page);
  links.accept("laterdog://dog/boat");
  assert.deepEqual(page.sent, []);
  assert.equal(links.stayed(page), true);
  assert.deepEqual(page.sent, [[APP_LINK_CHANNEL, "laterdog://dog/boat"]]);
  links.accept("laterdog://dog/kite");
  assert.deepEqual(page.sent.at(-1), [APP_LINK_CHANNEL, "laterdog://dog/kite"]);
  assert.equal(links.stayed(page), false);
});

test("a navigation that commits or fails into an error page holds links for the next ready page", () => {
  const { links } = slot();
  const page = contents();
  links.ready(page);
  links.navigating(page);
  links.notReady(page);
  assert.equal(links.stayed(page), false);
  links.accept("laterdog://dog/boat");
  assert.deepEqual(page.sent, []);
  assert.equal(links.pending(), "laterdog://dog/boat");
  links.ready(page);
  assert.deepEqual(page.sent, [[APP_LINK_CHANNEL, "laterdog://dog/boat"]]);
  links.navigating(page);
  links.ready(page);
  links.accept("laterdog://dog/kite");
  assert.deepEqual(page.sent.at(-1), [APP_LINK_CHANNEL, "laterdog://dog/kite"]);
});

test("navigation events from an older page do not touch the current one", () => {
  const { links } = slot();
  const old = contents();
  const current = contents();
  links.ready(current);
  links.navigating(old);
  links.stayed(old);
  links.accept("laterdog://dog/boat");
  assert.deepEqual(current.sent, [[APP_LINK_CHANNEL, "laterdog://dog/boat"]]);
});

test("notReady from an older page does not unready the current one", () => {
  const { links } = slot();
  const old = contents();
  const current = contents();
  links.ready(old);
  links.ready(current);
  links.notReady(old);
  links.accept("laterdog://dog/boat");
  assert.deepEqual(current.sent, [[APP_LINK_CHANNEL, "laterdog://dog/boat"]]);
});

test("malformed links are ignored and logged by scheme and host only", () => {
  const { links, lines, reveals } = slot();
  assert.equal(links.accept("laterdog://chat/bo%20at?thread=SECRET"), false);
  assert.equal(links.accept("laterdog://nope/x?code=SECRET"), false);
  assert.equal(links.accept("https://example.com/?code=SECRET"), false);
  assert.equal(links.pending(), null);
  assert.equal(reveals(), 0);
  assert.deepEqual(lines, ["app link ignored: laterdog://chat id", "app link ignored: laterdog://nope route"]);
  assert.equal(lines.join("\n").includes("SECRET"), false);
});

test("launch and second-instance arguments give the last app link, skipping the other later.dog links", () => {
  const { links, lines } = slot();
  assert.equal(links.fromArgs(["/Applications/later.dog.app", "--flag", "laterdog://install?url=https://github.com/a.md", "laterdog://dog/boat"]), true);
  assert.equal(links.pending(), "laterdog://dog/boat");
  assert.equal(links.fromArgs(["/app", "laterdog://cloud"]), false);
  assert.equal(links.fromArgs(["/app", "laterdog://dog/"]), false);
  assert.equal(links.fromArgs(["/app", "laterdog-dev://nope/x?code=SECRET", "https://example.com/dog"]), false);
  assert.equal(links.fromArgs(["/app", "laterdog://install?url=x", "https://dog/boat"]), false);
  assert.equal(links.fromArgs("laterdog://dog/boat"), false);
  assert.deepEqual(lines, ["app link held: laterdog://dog", "app link ignored: laterdog://dog id", "app link ignored: laterdog-dev://nope route"]);
});

test("a send that throws keeps the link for the next ready page", () => {
  const { links } = slot();
  const broken = { send: () => { throw new Error("gone"); }, isDestroyed: () => false };
  links.ready(broken);
  links.accept("laterdog://dog/boat");
  assert.equal(links.pending(), "laterdog://dog/boat");
});

test("failed external opens are logged by scheme and host, and the error still reaches the caller", async () => {
  const lines = [];
  const log = line => lines.push(line);
  await assert.rejects(openExternalLogged({ open: async () => { throw new Error("no handler for mailto:SECRET"); }, target: () => "mailto:SECRET@example.com", raw: "mailto:SECRET@example.com", log }));
  await assert.rejects(openExternalLogged({ open: async () => true, target: () => { throw new Error("Only web links"); }, raw: "file:///Users/SECRET?x=1", log }));
  assert.equal(await openExternalLogged({ open: async url => url, target: () => new URL("https://x.test/cb?code=SECRET"), raw: "https://x.test/cb?code=SECRET", log }), "https://x.test/cb?code=SECRET");
  assert.deepEqual(lines, ["external open failed: mailto: not opened", "external open failed: file: refused"]);
});

test("main hands app links to the slot from open-url, launch and a second instance, and only the main window can say it is ready", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const between = (start, end) => {
    const from = main.indexOf(start);
    return main.slice(from, main.indexOf(end, from));
  };
  assert.match(between('app.on("open-url"', "});"), /!focusFromTrialLink\(url\) && !appLinks\.accept\(url\)\) return;/);
  const secondInstance = between('app.on("second-instance"', "\n});");
  assert.ok(secondInstance.indexOf("appLinks.fromArgs(commandLine);") > secondInstance.indexOf("if (cloudEntry.fromArgs(commandLine)) return;"));
  const launch = main.indexOf("appLinks.fromArgs(process.argv);");
  assert.ok(launch > main.indexOf("app.requestSingleInstanceLock()"), "a second instance hands its link over instead of holding it");
  assert.ok(launch > main.indexOf("function slog(") && launch > main.indexOf("let logStream") && launch > main.indexOf("const LOG_DIR"), "the launch link is logged");
  const ready = between("ipcMain.on(APP_LINKS_READY_CHANNEL", "\n});");
  assert.match(ready, /sender !== mainWindow/);
  assert.match(ready, /event\.senderFrame !== event\.sender\.mainFrame/);
  assert.match(ready, /appLinks\.ready\(event\.sender\)/);
  assert.match(main, /otherHosts: \["organization", "cloud", "install", "trial", "plan"\]/);
  assert.match(main, /if \(isMainFrame && !isInPlace\) appLinks\.navigating\(win\.webContents\);/);
  assert.match(between('win.webContents.on("did-navigate"', "\n  });"), /"did-navigate", \(_event, url\) => \{\n\s+appLinks\.notReady\(win\.webContents\);/);
  assert.match(between('win.webContents.on("did-fail-load"', "\n  });"), /if \(!isMainFrame \|\| errorCode === -3\) return;\n\s+appLinks\.notReady\(win\.webContents\);/);
  assert.match(main, /"did-stop-loading", \(\) => appLinks\.stayed\(win\.webContents\)/);
  assert.match(main, /"render-process-gone", \(\) => appLinks\.notReady\(win\.webContents\)/);
  assert.doesNotMatch(main, /did-start-navigation[^\n]*\n[^\n]*appLinks\.notReady/);
});
