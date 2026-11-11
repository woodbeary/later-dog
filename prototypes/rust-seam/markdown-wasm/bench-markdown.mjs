import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { brotliCompressSync, gzipSync } from "node:zlib";
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

function without(node, dropped) {
  if (Array.isArray(node)) return node.map((child) => without(child, dropped));
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key, value]) => !dropped(key, value))
      .map(([key, value]) => [key, without(value, dropped)]),
  );
}

const position = (key) => key === "position";
const empty = (key, value) => value === null || value === undefined;
const positionOrEmpty = (key, value) => position(key) || empty(key, value);

function shown(value) {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function firstDifference(left, right, path) {
  if (isDeepStrictEqual(left, right)) return null;
  const nested = (value) => value !== null && typeof value === "object";
  if (!nested(left) || !nested(right) || Array.isArray(left) !== Array.isArray(right)) return { at: path, js: shown(left), rust: shown(right) };
  if (Array.isArray(left)) {
    if (left.length !== right.length) return { at: `${path}.length`, js: String(left.length), rust: String(right.length) };
    for (const [index, item] of left.entries()) {
      const found = firstDifference(item, right[index], `${path} > ${item?.type ?? item?.tagName ?? "item"}`);
      if (found) return found;
    }
    return null;
  }
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!(key in left) || !(key in right)) return { at: `${path}.${key}`, js: shown(left[key]), rust: shown(right[key]) };
    const found = firstDifference(left[key], right[key], key === "children" ? path : `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function hastOrFailure(tree) {
  try {
    return processor.runSync(tree);
  } catch (error) {
    return { failed: String(error?.message ?? error) };
  }
}

function compared(samples, rust) {
  const counts = { texts: samples.length, sameNodeTypes: 0, sameTree: 0, sameTreeIgnoringEmptyFields: 0, sameTreeAndPositions: 0, sameElementTree: 0 };
  const differences = new Map();
  const noted = (stage, found) => {
    if (!found) return;
    const key = `${stage} ${found.at}`;
    const known = differences.get(key);
    if (known) known.texts += 1;
    else differences.set(key, { stage, ...found, texts: 1 });
  };
  for (const text of samples) {
    const js = processor.parse(text);
    const wasm = rust.tree(text);
    if (nodeTypes(js) === nodeTypes(wasm)) counts.sameNodeTypes += 1;
    const treeDifference = firstDifference(without(js, position), without(wasm, position), "root");
    if (!treeDifference) counts.sameTree += 1;
    noted("tree", treeDifference);
    if (isDeepStrictEqual(without(js, positionOrEmpty), without(wasm, positionOrEmpty))) counts.sameTreeIgnoringEmptyFields += 1;
    const positionDifference = firstDifference(without(js, empty), without(wasm, empty), "root");
    if (!positionDifference) counts.sameTreeAndPositions += 1;
    else if (!treeDifference) noted("positions", positionDifference);
    const elementDifference = firstDifference(without(hastOrFailure(processor.parse(text)), position), without(hastOrFailure(rust.tree(text)), position), "root");
    if (!elementDifference) counts.sameElementTree += 1;
    noted("elements", elementDifference);
  }
  return { ...counts, differences: [...differences.values()].sort((left, right) => right.texts - left.texts).slice(0, 12) };
}

const EXTRAS = [
  "Euler: $e^{i\\pi} + 1 = 0$ and\n\n$$\n\\int_0^1 x^2 dx\n$$",
  "- [x] done\n- [ ] still to do",
  "A claim.[^1]\n\n[^1]: The source.",
  "~~old~~ see https://later.dog and <https://later.dog/docs>",
  "1. one\n   - inner\n   - inner two\n2. two",
  "<details><summary>More</summary>\n\nHidden\n\n</details>",
  '![alt](a.png "title") and [link](https://later.dog "t")',
  "> quoted\n\n## Heading\n\n---\n\nline one  \nline two",
  '```ts title="a.ts"\nconst a = 1;\n```',
  "| a | b |\n|:--|--:|\n| 1 | 2 |",
  "Zażółć gęślą jaźń 🐕 **bold** _em_ and `code`",
  "Loose list:\n\n- one\n\n- two\n\nSetext\n======",
];

function perMessage(samples, passes, work) {
  const medians = samples.map((text) => {
    for (let warm = 0; warm < 3; warm += 1) work(text);
    const took = [];
    for (let pass = 0; pass < passes; pass += 1) {
      const started = performance.now();
      work(text);
      took.push(performance.now() - started);
    }
    return took.sort((left, right) => left - right)[Math.floor(took.length / 2)];
  });
  const round = (value) => Math.round(value * 1000) / 1000;
  const sorted = medians.sort((left, right) => left - right);
  return { median: round(sorted[Math.floor(sorted.length / 2)]), min: round(sorted[0]), max: round(sorted.at(-1)) };
}

function perMessageRows(samples, passes, rust) {
  return {
    messages: samples.length,
    passesEach: passes,
    jsRenderParseMs: perMessage(samples, passes, (text) => processor.parse(text)),
    jsParseThenHastMs: perMessage(samples, passes, (text) => processor.runSync(processor.parse(text))),
    rustParseToTreeMs: perMessage(samples, passes, (text) => rust.tree(text)),
    rustTreeThenHastMs: perMessage(samples, passes, (text) => processor.runSync(rust.tree(text))),
  };
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
const fixtureComparison = compared(texts, rust);
const extrasComparison = compared(EXTRAS, rust);
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
    rustTreeThenHastMs: timed(passes, () => slice.forEach((text) => processor.runSync(rust.tree(text)))),
  };
}
const leafId = messages.at(-1).id;
const planning = {
  messages: messages.length,
  jsVisiblePathAndLookupsMs: timed(passes * 5, () => lookups(visiblePath(messages, leafId))),
  crossingAloneMs: timed(passes * 5, () => JSON.parse(decoder.decode(encoder.encode(JSON.stringify(messages))))),
};
const cold = coldStarts(wasmPath, Number(option("cold-runs", "15")));
const wasmFile = readFileSync(wasmPath);
const size = { wasmBytes: rust.bytes, gzipBytes: gzipSync(wasmFile, { level: 9 }).length, brotliBytes: brotliCompressSync(wasmFile).length };
const each = { all240: perMessageRows(texts, passes, rust), answers120: perMessageRows(texts.filter((_, index) => index % 2 === 1), passes, rust) };
const report = { platform: `${process.platform} ${process.arch}`, node: process.version, ...size, sameNodeTypes: `${fixtureComparison.sameNodeTypes} of ${texts.length}`, fixtureComparison, extrasComparison, passes, rows, perMessage: each, planning, cold };
const out = option("out");
if (out) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
