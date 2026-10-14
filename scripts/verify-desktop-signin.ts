import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runControlLaterDog } from "./control-laterdog.ts";
import { completionPatch } from "../src/lib/onboarding.ts";

const handle = process.argv[2];
const part = process.argv[3] ?? "1";
if (!handle) throw new Error("Usage: node --experimental-strip-types scripts/verify-desktop-signin.ts /path/to/fixture/ui.json   (the fixture comes from: ui launch --entry desktop-signin) [1|2]");
const origin = new URL(JSON.parse(readFileSync(handle, "utf8")).previewUrl).origin;
const ui = (verb: string, ...args: string[]) => runControlLaterDog(["ui", verb, "--ui", handle, ...args]) as Promise<Record<string, any>>;
const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
const snapshot = async () => (await ui("snapshot")).snapshot as string;
const step = (label: string) => { if (process.env.VERIFY_TRACE) console.log(`  . ${label}`); };
const click = async (name: string) => { step(`click ${name}`); await delay(900); return ui("click", "--name", name); };
const type = (name: string, text: string) => { step(`type ${name}`); return ui("type", "--name", name, "--text", text); };
const control = async (body: Record<string, unknown>) => (await (await fetch(`${origin}/__bridge/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as Record<string, any>;
const poll = async (read: () => Promise<unknown>, expected: unknown, label: string, ms = 20_000) => {
  const end = Date.now() + ms;
  let result;
  do { result = await read(); if (JSON.stringify(result) === JSON.stringify(expected)) return; await delay(150); } while (Date.now() < end);
  assert.deepEqual(result, expected, label);
};
const textVisible = (text: string, present = true) => poll(async () => (await snapshot()).includes(text), present, `${present ? "shows" : "hides"} ${text}`);
const evidence = resolve(".laterdog-scratch/verify-evidence/desktop-signin");
mkdirSync(evidence, { recursive: true });
const shot = async (name: string) => {
  await poll(() => evaluate("!document.querySelector('[data-launch-splash=\"shown\"]')"), true, "the launch splash is gone before the screenshot", 12_000).catch(() => {});
  await delay(300);
  return ui("screenshot", "--out", resolve(evidence, `${name}.png`));
};
const load = async (query: string) => {
  await evaluate(`window.__stale = true; setTimeout(() => { location.href = location.pathname + '${query}'; }, 0); true`);
  await poll(async () => { try { return await evaluate("window.__stale === undefined && document.readyState === 'complete'"); } catch { return false; } }, true, `loads ${query}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await poll(() => evaluate("!document.querySelector('[data-launch-splash=\"shown\"]')"), true, "the launch splash leaves", 12_000);
      break;
    } catch {
      console.log(`  (the fixture page stayed on its launch splash for 12 s after ${query || "a plain load"}; loading it again)`);
      await evaluate("window.__stale = true; setTimeout(() => location.reload(), 0); true");
      await poll(async () => { try { return await evaluate("window.__stale === undefined && document.readyState === 'complete'"); } catch { return false; } }, true, "reloads");
    }
  }
  await delay(600);
};
const apiConfig = (patch: unknown) => evaluate(`fetch('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(patch)}) }).then(r => r.status)`);
const skipTour = async () => { if ((await snapshot()).includes("Skip tour")) await ui("click", "--name", "Skip tour"); };
const gateOpen = () => evaluate("Boolean(document.querySelector('[data-cloud-sign-in-gate]'))");
const welcomeOpen = () => evaluate("Boolean(document.querySelector('.welcome-card') && !document.querySelector('[data-cloud-sign-in-gate]'))");
const inHome = async () => { try { return await evaluate("location.search.includes('mode=home')"); } catch { return false; } };
const arrived = async (label: string) => { await poll(inHome, true, label); await delay(2000); };

if (part === "1") {
await control({ reset: true });
await load("?onboarding=1");
await textVisible("Use your email. We'll send you a code.");
assert.equal(await gateOpen(), true);
assert.equal(await welcomeOpen(), false, "the welcome flow waits behind the sign-in screen");
const first = await snapshot();
for (const text of ["Agree and continue", "Use this Mac without an account"]) assert.ok(first.includes(text), text);
assert.equal(await evaluate("document.querySelector('[data-cloud-sign-in-agreement]').textContent"), "You accept the Terms and Privacy Policy, and that what you send your dogs goes to the AI that answers them, like Kimi on Cloudflare or Grok by xAI.");
await shot("01-first-launch-email");
console.log("PASS first launch opens on the account screen, with the phone's words, before any other step");

await type("Email", "jo@example.test");
await click("Agree and continue");
await textVisible("Check your email");
await shot("02-code");
assert.deepEqual((await control({})).sent, ["jo@example.test"]);
await type("Code", "12345678");
await arrived("the window opens the home after the code, with no further tap");
await skipTour();
await shot("03-home-after-sign-in");
const routes = (await control({})).requests as string[];
assert.deepEqual(routes.slice(0, 6), ["/api/auth/email-otp/send-verification-otp", "/api/auth/sign-in/email-otp", "/api/cloud/desktop/authorize", "/api/cloud/desktop/approve", "/api/cloud/desktop/token", "/api/auth/sign-out"]);
assert.equal((await control({})).signedOut, 1, "the short-lived account session was ended");
assert.equal(await gateOpen(), false);
console.log("PASS email, one Agree and continue, 8 digits: signed in and in the home; one tap, no browser, no server step");

await evaluate("localStorage.clear(); true");
const model = { destination: { id: "cloud", name: "My Cloud", origin: "https://home.fixture.test", kind: "cloud" } };
await apiConfig(completionPatch());
await load("?mode=home");
await skipTour();
await control({ move: { phase: "uploading", action: "move", progress: { bytesTransferred: 42, totalBytes: 100 }, ...model } });
await textVisible("Moving your dogs here from this Mac… 42%");
await shot("04-moving-line");
await control({ move: { phase: "restarting", action: "move", ...model } });
await textVisible("Almost there. Your home restarts to open them.");
await shot("05-finishing-line");
await control({ move: { phase: "done", action: "move", moved: { bots: 3, rooms: 1, chats: 8 }, ...model } });
await textVisible("Your dogs from this Mac are here now. This Mac keeps its copy.");
await shot("06-done-line");
await control({ move: { phase: "failed", action: "move", error: { code: "network", message: "x" }, ...model } });
await textVisible("Your dogs are still on this Mac. They couldn't move yet.");
await shot("07-failed-line-with-retry");
assert.ok((await snapshot()).includes("Try again"));
await control({ move: { phase: "failed", action: "move", error: { code: "not_empty", message: "x" }, ...model } });
await textVisible("Your home already has dogs, so the dogs on this Mac stayed here.");
await shot("08-kept-line");
await control({ move: { phase: "idle" } });
await textVisible("Your home already has dogs", false);
console.log("PASS the quiet move line: progress, finishing, done, failed with retry, kept");

await control({ reset: true });
await apiConfig(completionPatch());
await load("");
await textVisible("Use your email. We'll send you a code.");
assert.equal(await welcomeOpen(), false);
await shot("10-existing-user-one-screen");
await click("Use this Mac without an account");
await poll(gateOpen, false, "Not now closes the screen");
await shot("11-existing-user-declined-as-today");
await load("");
await delay(1500);
assert.equal(await gateOpen(), false, "a Mac that said not now is never asked again");
console.log("PASS an app already in use gets the same screen once; not now leaves it exactly as today and it never returns");

await control({ reset: true });
await apiConfig({ onboarding: { completedAt: "", version: 0 } });
await evaluate("localStorage.clear(); true");
await load("?onboarding=1");
await textVisible("Use your email. We'll send you a code.");
await click("Use this Mac without an account");
await textVisible("Your name");
await shot("12-declined-first-launch-continues-locally");
console.log("PASS declining on first launch continues into today's local welcome flow");

}
if (part === "2") {
await control({ reset: true });
await apiConfig(completionPatch());
await load("");
await textVisible("Use your email. We'll send you a code.");
await type("Email", "jo@example.test");
await click("Agree and continue");
await textVisible("Check your email");
await control({ otp: "99999999" });
await type("Code", "00000000");
await textVisible("That code didn't match. Check the email and try again.");
await shot("13-wrong-code");
await control({ reset: true, failSend: { status: 503, body: { error: "email_unavailable" } } });
await load("");
await textVisible("Use your email. We'll send you a code.");
await type("Email", "jo@example.test");
await click("Agree and continue");
await textVisible("later.dog can't send sign-in emails right now. Try again in a little while.");
await shot("14-email-unavailable");
console.log("PASS a wrong code and an email outage each say what happened and keep the person on the screen");

await control({ reset: true, homeState: "provisioning", setup: { step: "storage" } });
await apiConfig(completionPatch());
await load("");
await textVisible("Use your email. We'll send you a code.");
await type("Email", "jo@example.test");
await click("Agree and continue");
await textVisible("Check your email");
await type("Code", "12345678");
await textVisible("Getting your home ready. This takes a minute or two.");
await shot("15-home-being-set-up");
assert.equal(await inHome(), false);
await control({ homeState: "ready", refresh: true });
await arrived("the window opens the home when it is ready, with no tap");
console.log("PASS a home still being set up shows one calm line and opens by itself when ready");

await control({ reset: true });
await apiConfig(completionPatch());
await load("");
await type("Email", "jo@example.test");
await click("Agree and continue");
await textVisible("Check your email");
await type("Code", "12345678");
await arrived("signed in");
await control({ entered: false, fellBack: true });
await load("");
await textVisible("Can't reach your home right now. Showing the dogs on this Mac.");
assert.equal(await gateOpen(), false, "a person who signed in is not asked again when the home is unreachable");
await shot("16-home-unreachable-quiet-line");
await click("Try again");
await arrived("Try again opens the home");
console.log("PASS an unreachable home shows this Mac's dogs with one quiet line and a retry");
console.log("DONE evidence in", evidence);
}
