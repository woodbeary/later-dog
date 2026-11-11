import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

const HERE = dirname(fileURLToPath(import.meta.url));
const root = createRequire(join(HERE, "../../../package.json"));
const beside = createRequire(root.resolve("react-markdown"));
const { unified } = await import(pathToFileURL(beside.resolve("unified")).href);
const { default: remarkParse } = await import(pathToFileURL(beside.resolve("remark-parse")).href);
const { default: remarkRehype } = await import(pathToFileURL(beside.resolve("remark-rehype")).href);

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function transcript(turns) {
  const table = ["| Step | Result | Time |", "|---|---|---|", "| Install | passed | 41 s |", "| Typecheck | passed | 18 s |", "| Tests | 1,884 passed | 3 min 12 s |", "| Export | one bundle, 5.9 MB | 58 s |"].join("\n");
  const code = ["```ts", "export function carryOn(waiting: readonly string[], after: string | undefined): readonly string[] {", "  if (after === undefined) return waiting;", "  const start = waiting.findIndex((path) => path > after);", "  return start <= 0 ? waiting : [...waiting.slice(start), ...waiting.slice(0, start)];", "}", "```"].join("\n");
  const prose = "The release checklist is done apart from the two items that need you. The signed build finished and passed its smoke tests on both window sizes, the update guide names the new group and the rollback target, and the pull request is merged. Nothing else changed in this pass, so the next step is yours.";
  const list = ["Here is where things stand:", "", "- **Build:** finished and signed, with the long dog names fitting their rows.", "- **Docs:** the update guide is merged and names the rollback target.", "- **Waiting on you:** approve the screenshots and confirm the pricing line before Friday.", "", "`pnpm verify` passed in 4 min 12 s."].join("\n");
  const shapes = [prose, list, `${prose}\n\n${code}`, `Results from this run:\n\n${table}\n\n${prose}`, "Done. Nothing else needed.", `${list}\n\n${code}\n\n${table}`];
  const asks = ["Where does the release stand?", "Run the checks again and show me the table.", "Show me the function you changed.", "Anything still waiting on me?"];
  const messages = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const ask = { id: `u${turn}`, parentId: turn === 0 ? null : `a${turn - 1}`, role: "user", kind: "text", at: turn * 2, text: `${asks[turn % asks.length]} (Marathon, ${turn + 1})` };
    const answer = { id: `a${turn}`, parentId: ask.id, role: "assistant", kind: "text", at: turn * 2 + 1, text: `Answer ${turn + 1}. ${shapes[turn % shapes.length]}` };
    messages.push(ask, answer);
  }
  return messages;
}

const gfmParseData = {};
remarkGfm.call({ data: () => gfmParseData });
const normalizationParseOptions = { extensions: gfmParseData.micromarkExtensions, mdastExtensions: gfmParseData.fromMarkdownExtensions ?? [] };
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkRehype).use(rehypeKatex);

function crossing(instance) {
  const { memory, reserve, release, parse } = instance.exports;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const crossed = (text) => {
    const capacity = text.length * 3;
    const input = reserve(capacity);
    const { written } = encoder.encodeInto(text, new Uint8Array(memory.buffer, input, capacity));
    const answer = parse(input, written);
    release(input, capacity);
    const [length, held] = new Uint32Array(memory.buffer.slice(answer, answer + 8));
    const json = decoder.decode(new Uint8Array(memory.buffer, answer + 8, length));
    release(answer, held);
    return json;
  };
  return { text: crossed, tree: (text) => JSON.parse(crossed(text)) };
}

async function rustParser(wasmPath) {
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
  return { ...crossing(instance), bytes: readFileSync(wasmPath).length };
}

async function coldStart(wasmPath, texts) {
  const since = (started) => Math.round((performance.now() - started) * 1000) / 1000;
  let started = performance.now();
  const bytes = readFileSync(wasmPath);
  const readMs = since(started);
  started = performance.now();
  const module = await WebAssembly.compile(bytes);
  const compileMs = since(started);
  started = performance.now();
  const instance = await WebAssembly.instantiate(module, {});
  const instantiateMs = since(started);
  const rust = crossing(instance);
  started = performance.now();
  rust.tree(texts[0]);
  const rustFirstMessageMs = since(started);
  started = performance.now();
  texts.forEach((text) => rust.tree(text));
  const rustFirstWindowMs = since(started);
  started = performance.now();
  processor.parse(texts[0]);
  const jsFirstMessageMs = since(started);
  started = performance.now();
  texts.forEach((text) => processor.parse(text));
  const jsFirstWindowMs = since(started);
  return { readMs, compileMs, instantiateMs, rustFirstMessageMs, rustFirstWindowMs, jsFirstMessageMs, jsFirstWindowMs };
}

function summarized(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1) };
}

function coldStarts(wasmPath, runs) {
  const self = fileURLToPath(import.meta.url);
  const results = Array.from({ length: runs }, () => JSON.parse(execFileSync(process.execPath, [self, "cold", "--wasm", wasmPath], { encoding: "utf8" })));
  return { freshProcesses: runs, window: "the newest 30 messages", ...Object.fromEntries(Object.keys(results[0]).map((key) => [key, summarized(results.map((result) => result[key]))])) };
}

function nodeTypes(tree) {
  const counts = new Map();
  const visit = (node) => {
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
    node.children?.forEach(visit);
  };
  visit(tree);
  return JSON.stringify([...counts].sort(([left], [right]) => (left < right ? -1 : 1)));
}

function visiblePath(messages, leafId) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const path = [];
  let current = byId.get(leafId);
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

function lookups(all) {
  const byId = new Map();
  const forks = new Map();
  for (const message of all) {
    byId.set(message.id, message);
    if (message.role !== "user" || message.kind !== "text") continue;
    const siblings = forks.get(message.parentId ?? null);
    if (siblings) siblings.push(message);
    else forks.set(message.parentId ?? null, [message]);
  }
  for (const siblings of forks.values()) siblings.sort((left, right) => left.at - right.at);
  return byId.size + forks.size;
}

function timed(passes, work) {
  for (let warm = 0; warm < 15; warm += 1) work();
  const took = [];
  for (let pass = 0; pass < passes; pass += 1) {
    const started = performance.now();
    work();
    took.push(performance.now() - started);
  }
  took.sort((left, right) => left - right);
  const round = (value) => Math.round(value * 1000) / 1000;
  return { median: round(took[Math.floor(took.length / 2)]), min: round(took[0]), max: round(took.at(-1)) };
}

const turns = Number(option("turns", "120"));
const passes = Number(option("passes", "40"));
const messages = transcript(turns);
const texts = messages.map((message) => message.text);
const wasmPath = resolve(option("wasm", join(HERE, "target/wasm32-unknown-unknown/release/markdown_wasm.wasm")));
if (process.argv[2] === "cold") {
  process.stdout.write(`${JSON.stringify(await coldStart(wasmPath, texts.slice(-30)))}\n`);
  process.exit(0);
}
const rust = await rustParser(wasmPath);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sameShape = texts.filter((text) => nodeTypes(processor.parse(text)) === nodeTypes(rust.tree(text))).length;
const windows = { opening30: texts.slice(-30), window120: texts.slice(-120), all240: texts };
const rows = {};
for (const [name, slice] of Object.entries(windows)) {
  rows[name] = {
    messages: slice.length,
    characters: slice.reduce((sum, text) => sum + text.length, 0),
    jsNormalizationParseMs: timed(passes, () => slice.forEach((text) => fromMarkdown(text, normalizationParseOptions))),
    jsRenderParseMs: timed(passes, () => slice.forEach((text) => processor.parse(text))),
    jsParseThenHastMs: timed(passes, () => slice.forEach((text) => processor.runSync(processor.parse(text)))),
    rustParseToJsonTextMs: timed(passes, () => slice.forEach((text) => rust.text(text))),
    rustParseToTreeMs: timed(passes, () => slice.forEach((text) => rust.tree(text))),
  };
}
const leafId = messages.at(-1).id;
const planning = {
  messages: messages.length,
  jsVisiblePathAndLookupsMs: timed(passes * 5, () => lookups(visiblePath(messages, leafId))),
  crossingAloneMs: timed(passes * 5, () => JSON.parse(decoder.decode(encoder.encode(JSON.stringify(messages))))),
};
const cold = coldStarts(wasmPath, Number(option("cold-runs", "15")));
const report = { platform: `${process.platform} ${process.arch}`, node: process.version, wasmBytes: rust.bytes, sameNodeTypes: `${sameShape} of ${texts.length}`, passes, rows, planning, cold };
const out = option("out");
if (out) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
