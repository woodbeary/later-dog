import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONSENT_WORDS, consentWindow, parseWindowOwners, withConsentCheck } from "./mac-consent.mjs";
import { createDirectCapture, needsDirectCapture } from "./direct-capture.mjs";
import { directCaptureStatus, permissionChecklist, requestPermission } from "./mac-permissions.mjs";
import { screenCommandRefusal, SCREEN_COMMAND_OFF, SCREEN_VIA_TERMINAL } from "./shared-computer-access.mjs";

const failed = { isError: true, content: [{ type: "text", text: "timed out" }] };
const running = { content: [{ type: "text", text: JSON.stringify({ command_id: "c", running: true, output: "" }) }] };
const prompt = async () => [{ owner: "Finder", layer: 0 }, { owner: "UserNotificationCenter", layer: 8 }];
const none = async () => [{ owner: "Finder", layer: 0 }, { owner: "UserNotificationCenter", layer: 0 }];

test("reads window owners and spots an open macOS permission window, without asking for any permission itself", () => {
  assert.deepEqual(parseWindowOwners("Dock\t-2147483624\nUserNotificationCenter\t8\n\n"), [{ owner: "Dock", layer: -2147483624 }, { owner: "UserNotificationCenter", layer: 8 }]);
  assert.deepEqual(consentWindow([{ owner: "UserNotificationCenter", layer: 8 }]), { owner: "UserNotificationCenter" });
  assert.equal(consentWindow([{ owner: "UserNotificationCenter", layer: 0 }]), null);
  assert.deepEqual(consentWindow([{ owner: "universalAccessAuthWarn", layer: 0 }]), { owner: "universalAccessAuthWarn" });
  assert.equal(consentWindow([{ owner: "Safari", layer: 8 }]), null);
});

test("a stuck screen action or command reports the waiting permission window instead of hanging", async () => {
  for (const [result, action] of [[failed, "computer_call"], [running, "run_command"], [failed, "computer_tools"]]) {
    const checked = await withConsentCheck(result, { action }, { platform: "darwin", windows: prompt });
    assert.deepEqual(checked.macPrompt, { owner: "UserNotificationCenter" });
    assert.equal(checked.content.at(-1).text, CONSENT_WORDS);
  }
  assert.equal(await withConsentCheck(failed, { action: "computer_call" }, { platform: "darwin", windows: none }), failed);
  const ok = { content: [{ type: "text", text: JSON.stringify({ running: false, exitCode: 0 }) }] };
  assert.equal(await withConsentCheck(ok, { action: "run_command" }, { platform: "darwin", windows: prompt }), ok);
  assert.equal(await withConsentCheck(failed, { action: "read_file" }, { platform: "darwin", windows: prompt }), failed);
  assert.equal(await withConsentCheck(failed, { action: "computer_call" }, { platform: "linux", windows: prompt }), failed);
  assert.equal(await withConsentCheck(failed, { action: "computer_call" }, { platform: "darwin", windows: prompt, elapsedMs: 200 }), failed, "a quick failure isn't a waiting window");
});

function fakeCapture({ code, writes }) {
  const spawned = [];
  const spawnImpl = (file, args) => {
    spawned.push([file, ...args]);
    const child = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => { if (writes) writeFileSync(args.at(-1), "png"); child.emit("close", code); });
    return child;
  };
  return { spawned, spawnImpl };
}

test("setup asks for direct screen capture once, as later.dog, and remembers it only when a real capture worked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "direct-"));
  const file = join(dir, "direct-capture.json");
  const good = fakeCapture({ code: 0, writes: true });
  const capture = createDirectCapture({ file, tmpDir: dir, spawnImpl: good.spawnImpl });
  assert.equal(capture.verified(), false);
  assert.equal(await capture.verify(), true);
  assert.deepEqual(good.spawned[0].slice(0, 4), ["/usr/sbin/screencapture", "-x", "-t", "png"]);
  assert.equal(capture.verified(), true);
  assert.equal(await capture.verify(), true);
  assert.equal(good.spawned.length, 1);

  const other = join(dir, "other.json");
  const blank = createDirectCapture({ file: other, tmpDir: dir, spawnImpl: fakeCapture({ code: 0, writes: false }).spawnImpl });
  assert.equal(await blank.verify(), false);
  assert.equal(existsSync(other), false);
});

test("on macOS 26 the screen row isn't done until direct capture is allowed too, and asking for it runs the capture", async () => {
  assert.equal(needsDirectCapture({ platform: "darwin", release: "25.3.0" }), true);
  assert.equal(needsDirectCapture({ platform: "darwin", release: "24.6.0" }), false);
  assert.equal(directCaptureStatus("granted", undefined), "granted");
  let verified = false;
  const directCapture = { needed: true, verified: () => verified, verify: async () => { verified = true; return true; } };
  const systemPreferences = { getMediaAccessStatus: () => "granted", isTrustedAccessibilityClient: () => true };
  assert.equal(permissionChecklist({ platform: "darwin", systemPreferences, directCapture }).directCapture, "notDetermined");
  const answer = await requestPermission("screen", { platform: "darwin", systemPreferences, directCapture, desktopCapturer: { getSources: async () => [] } });
  assert.equal(answer.directCapture, "granted");
  assert.equal(answer.screen, "granted");
});

test("screencapture in a command runs as later.dog: refused clearly without the grant, and never through Terminal", () => {
  const off = { platform: "darwin", screenRecording: () => "denied" };
  const on = { platform: "darwin", screenRecording: () => "granted" };
  assert.equal(screenCommandRefusal("screencapture -x /tmp/a.png", off), SCREEN_COMMAND_OFF);
  assert.equal(screenCommandRefusal("screencapture -x /tmp/a.png", on), null);
  assert.equal(screenCommandRefusal("osascript -e 'tell application \"Terminal\" to do script \"screencapture -x /tmp/a.png\"'", on), SCREEN_VIA_TERMINAL);
  assert.equal(screenCommandRefusal("ls -la", off), null);
  assert.equal(screenCommandRefusal("/usr/sbin/screencapture /tmp/a.png", { platform: "linux", screenRecording: () => "denied" }), null);
});
