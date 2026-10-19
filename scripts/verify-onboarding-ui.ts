import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runControlLaterDog } from "./control-laterdog.ts";

const handle = process.argv[2];
if (!handle) throw new Error("Usage: node --experimental-strip-types scripts/verify-onboarding-ui.ts /path/to/fixture/ui.json");
const ui = (verb: string, ...args: string[]) => runControlLaterDog(["ui", verb, "--ui", handle, ...args]) as Promise<Record<string, any>>;
const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
const click = async (name: string) => {
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
await evaluate("localStorage.clear(); setTimeout(() => { location.search = '?onboarding=1'; }, 0); true");
await textVisible("Your name");
await evaluate("document.documentElement.dataset.reducedMotion = 'true'; true");
await screenshot("welcome");
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
for (let attempt = 0; attempt < 3 && !(await snapshot()).includes("Start chatting"); attempt++) {
  await click("Continue");
  await delay(1_500);
}
await textVisible("Start chatting");
assert.equal((await config()).profile.name, "Onboarding fixture");
console.log("PASS profile failure preserves input; retry persists before advancing");
assert.equal(await evaluate("Boolean(document.querySelector('[data-cloud-setup], [data-ai-choices]'))"), false);
assert.equal((await snapshot()).includes("Your phone"), false);
await screenshot("meet-bot");
assert.equal(await evaluate("document.querySelector('.welcome-card [role=radiogroup]').querySelectorAll('[role=radio]').length"), 8);
assert.equal(await evaluate("Boolean(document.querySelector('#welcome-bot-soul'))"), false);
assert.equal(await evaluate("document.querySelectorAll('.welcome-card .welcome-dog').length"), 0);
await click("Corgi");
await screenshot("meet-bot-corgi");
await click("Start chatting");
await poll(async () => (await evaluate("fetch('/api/bots').then(r => r.json()).then(d => d.bots.some(b => b.mascotBody === 'corgi'))")), true, "breed saved");
await poll(async () => (await evaluate(`fetch('/api/bots?messages=10').then(r => r.json()).then(d => {
  const dog = d.bots.find(b => b.mascotBody === 'corgi');
  const texts = (dog.messages || []).filter(m => m.kind === 'text');
  return texts[0]?.text === "Hi Onboarding fixture, I'm " + dog.name + "." && texts.length > 1 && !texts.some(m => m.role === 'user');
})`)), true, "the first dog speaks first");
console.log("PASS the first dog greets by name and takes the first turn, with nothing typed for the person");
console.log("PASS no provider step, no setup checklist, no permissions or phone step, and welcome completion");

await evaluate("setTimeout(() => location.reload(), 0); true");
await poll(async () => Boolean((await config()).onboarding.completedAt), true, "welcome save completed");
assert.equal(await evaluate("document.querySelectorAll('.welcome-card').length"), 0);
console.log("PASS reload stays dismissed");
await screenshot("complete");
console.log(JSON.stringify({ ok: true, evidence, config: (await config()).onboarding }));
