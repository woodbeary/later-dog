// Assert the first-run workflow against a handle from `control-laterdog ui launch`.
// The handle gate refuses live-app URLs and stopped fixtures. All profile,
// bot and onboarding writes below stay inside that launch's disposable home.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runControlLaterDog } from "./control-laterdog.ts";
import { TOUR_STEPS } from "../src/lib/guided-tour.ts";

const handle = process.argv[2];
if (!handle) throw new Error("Usage: node --experimental-strip-types scripts/verify-onboarding-ui.ts /path/to/fixture/ui.json");
const ui = (verb: string, ...args: string[]) => runControlLaterDog(["ui", verb, "--ui", handle, ...args]) as Promise<Record<string, any>>;
const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
const click = async (name: string) => {
  // Let the 320ms spotlight transition land before sending a real pointer
  // click; the browser CLI does not wait for moving controls to stabilize.
  await delay(400);
  return ui("click", "--name", name);
};
const type = (name: string, text: string) => ui("type", "--name", name, "--text", text);
const snapshot = async () => (await ui("snapshot")).snapshot as string;
const config = () => evaluate("fetch('/api/config').then(r => r.json())");
const poll = async (read: () => Promise<unknown>, expected: unknown, label: string) => {
  const end = Date.now() + 15_000;
  let result;
  do {
    result = await read();
    if (JSON.stringify(result) === JSON.stringify(expected)) return;
    await delay(100);
  } while (Date.now() < end);
  assert.deepEqual(result, expected, label);
};
const textVisible = (text: string) => poll(async () => (await snapshot()).includes(text), true, text);
const evidence = resolve(".laterdog-scratch/verify-evidence/onboarding");
mkdirSync(evidence, { recursive: true });
const screenshot = (name: string) => ui("screenshot", "--out", resolve(evidence, `${name}.png`));
const openSettings = async () => {
  await click("Onboarding fixture");
  await click("Settings");
  await textVisible("Replay welcome tour");
};
const holdConfigWrite = () => evaluate(`(() => {
  const original = window.fetch.bind(window);
  window.heldWrites = 0;
  window.fetch = (input, init) => {
    if (String(input) === '/api/config' && init?.method === 'PUT') {
      window.heldWrites++;
      window.fetch = original;
      return new Promise(resolve => { window.releaseWrite = () => resolve(original(input, init)); });
    }
    return original(input, init);
  };
  return true;
})()`);

// The fixture's server starts with a fresh onboarding record, and the preview harness marks first run done on load unless
// the URL carries `?onboarding` (scripts/testing/threads-preview.tsx). Clearing only this fixture browser's localStorage
// and loading with that entry gives a fresh install's first run, as a new Mac sees it.
await evaluate("localStorage.clear(); setTimeout(() => { location.search = '?onboarding=1'; }, 0); true");
await textVisible("Your name");
await evaluate("document.documentElement.dataset.reducedMotion = 'true'; true");
await screenshot("welcome");
// later.dog asks only for a name.
await type("Your name", "Onboarding fixture");
await evaluate(`(() => {
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (String(input) === '/api/config' && init?.method === 'PUT') {
      window.fetch = original;
      return Promise.resolve(new Response(JSON.stringify({error:'Fixture profile rejected'}), {status:503}));
    }
    return original(input, init);
  };
  return true;
})()`);
await click("Continue");
await textVisible("Couldn't save your details");
assert.equal(await evaluate("document.querySelector('.welcome-card input').value"), "Onboarding fixture");
await click("Continue");
await textVisible("Your model providers");
assert.equal((await config()).profile.name, "Onboarding fixture");
console.log("PASS profile failure preserves input; retry persists before advancing");

// later.dog's first run has no feature reel: the name leads straight to the model providers.
await textVisible("Check again");
await screenshot("engines");
const inventoryBefore = await evaluate("[...document.querySelectorAll('.welcome-card [aria-expanded]')].map(e => e.textContent)");
await evaluate(`(() => {
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (String(input) === '/api/instances') {
      window.fetch = original;
      return Promise.resolve(new Response(JSON.stringify({error:'Fixture inventory unavailable'}), {status:503}));
    }
    return original(input, init);
  };
  return true;
})()`);
await click("Check again");
await textVisible("Couldn't check your AI connections");
assert.deepEqual(await evaluate("[...document.querySelectorAll('.welcome-card [aria-expanded]')].map(e => e.textContent)"), inventoryBefore);
await click("Check again");
await poll(async () => (await snapshot()).includes("Couldn't check your AI connections"), false, "inventory retry");
await click("Continue");
// The engines lead straight to the first dog: no permissions step (a dog asks when a task needs them) and no phone step.
await textVisible("Start chatting");
assert.equal((await snapshot()).includes("Your phone"), false);
await screenshot("meet-bot");
// The first dog: one of eight breeds drawn in the chosen color, a color and a name; no standing instruction, and the
// guide dog steps aside so only the person's own dog shows.
assert.equal(await evaluate("document.querySelector('.welcome-card [role=radiogroup]').querySelectorAll('[role=radio]').length"), 8);
assert.equal(await evaluate("Boolean(document.querySelector('#welcome-bot-soul'))"), false);
assert.equal(await evaluate("document.querySelectorAll('.welcome-card .welcome-dog').length"), 0);
await click("Corgi");
await screenshot("meet-bot-corgi");
await click("Start chatting");
await poll(async () => (await evaluate("fetch('/api/bots').then(r => r.json()).then(d => d.bots.some(b => b.mascotBody === 'corgi'))")), true, "breed saved");
// The dog speaks first: its chat opens on a hello with the person's name and the dog's own, then the dog's first turn
// (here the fake engine's reply) — and nothing that looks typed by the person.
await poll(async () => (await evaluate(`fetch('/api/bots?messages=10').then(r => r.json()).then(d => {
  const dog = d.bots.find(b => b.mascotBody === 'corgi');
  const texts = (dog.messages || []).filter(m => m.kind === 'text');
  return texts[0]?.text === "Hi Onboarding fixture, I'm " + dog.name + "." && texts.length > 1 && !texts.some(m => m.role === 'user');
})`)), true, "the first dog speaks first");
console.log("PASS the first dog greets by name and takes the first turn, with nothing typed for the person");
await textVisible("This is where you talk to your dogs");
console.log("PASS providers, engine failure/retry, no permissions or phone step, and welcome completion");

// Complete every live-interface step and verify its server record. A missing
// optional browser tab may skip itself, but every required anchor must work.
for (const step of TOUR_STEPS) {
  if ((await config()).onboarding.hintsSeen.includes(step.id)) continue;
  await poll(() => evaluate("Boolean(document.querySelector('[data-tour-card] button'))"), true, step.id);
  await screenshot(step.id);
  await click(step.id === "tour.done" ? "Finish" : "Next");
  await poll(async () => (await config()).onboarding.hintsSeen.includes(step.id), true, `saved ${step.id}`);
}
await poll(() => evaluate("document.querySelectorAll('[data-tour-card]').length"), 0, "tour closed");
await evaluate("setTimeout(() => location.reload(), 0); true");
await textVisible("Message Pepper");
assert.equal(await evaluate("document.querySelectorAll('.welcome-card, [data-tour-card]').length"), 0);
console.log("PASS full guided tour, saved progress, reload stays dismissed");

await openSettings();
await click("Replay app tour");
await textVisible("This is where you talk to your dogs");
await holdConfigWrite();
await click("Next");
await poll(() => evaluate("window.heldWrites"), 1, "Next pending");
await click("Skip tour");
await poll(() => evaluate("document.querySelectorAll('[data-tour-card]').length"), 0, "Skip closes immediately");
await evaluate("window.releaseWrite(); true");
await poll(async () => (await config()).onboarding.hintsSeen.filter((id: string) => id.startsWith("tour.")).length, TOUR_STEPS.length, "Skip survives in-flight Next");
console.log("PASS Settings replay and Skip queued behind slow Next");

await openSettings();
await click("Replay welcome tour");
await textVisible("Your name");
await holdConfigWrite();
await click("Skip tour");
await poll(() => evaluate("document.querySelectorAll('.welcome-card').length"), 0, "slow completion cannot trap welcome");
await evaluate("window.releaseWrite(); true");
console.log("PASS welcome replay can close while persistence is pending");
await poll(async () => Boolean((await config()).onboarding.completedAt), true, "welcome save completed");

// An upgraded install can have only the legacy browser gate. Replay still
// works without a new welcome completion, and failures keep Settings open.
await evaluate("fetch('/api/config', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({onboarding:{completedAt:'', version:0}})}).then(r=>r.ok)");
await evaluate("setTimeout(() => location.reload(), 0); true");
await textVisible("Message Pepper");
await openSettings();
await evaluate(`(() => {
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (String(input) === '/api/config' && init?.method === 'PUT') {
      window.fetch = original;
      return Promise.resolve(new Response('{}', {status:503}));
    }
    return original(input, init);
  };
  return true;
})()`);
await click("Replay app tour");
await textVisible("Couldn't save your progress");
await click("Replay app tour");
await textVisible("This is where you talk to your dogs");
await click("Skip tour");
await poll(async () => (await config()).onboarding.hintsSeen.filter((id: string) => id.startsWith("tour.")).length, TOUR_STEPS.length, "legacy replay saved");
console.log("PASS legacy-install replay and failed replay retry");
await screenshot("complete");
console.log(JSON.stringify({ ok: true, evidence, config: (await config()).onboarding }));
