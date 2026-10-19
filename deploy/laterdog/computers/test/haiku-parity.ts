import { AI_WORKERS_MODEL, chatRequest, tokensOf, workersInput, type ChatRequest } from "../src/ai";
import { AI_ANTHROPIC_MODEL, ANTHROPIC_VERSION, chatCompletion, messagesRequest } from "../src/anthropic";
import { TOOLS } from "../src/mcp-tools";

export const COMPUTER_ID = "cmp_abcdefghij23";
export const SCREEN = { width: 400, height: 300 };
export const RED_BUTTON = { left: 40, top: 200, right: 160, bottom: 260 };
export const GREEN_BUTTON = { left: 240, top: 200, right: 360, bottom: 260 };
const SCREENSHOT_LABEL = "Screenshot result from tool call";
const SYSTEM = [
  "You are Rex, a dog in later.dog: an AI assistant that does real work for the person you work for.",
  "You have later.dog cloud computers you drive with your tools. Use a tool whenever the task needs one, one step at a time, and look at each result before the next step.",
  "When the work is done, answer in plain words without calling another tool.",
].join(" ");

export type ToolCall = { name: string; args: Record<string, unknown> };
export type Reply = { text: string; toolCalls: ToolCall[] };
export type ParityTurn = { name: string; kind: "chat" | "tool" | "computer"; messages: unknown[]; passes(reply: Reply): boolean };
export type ProviderName = "kimi" | "haiku";
export type Answer = { completion: Record<string, unknown> | null; ms: number };
export type Provider = { name: ProviderName; model: string; ask(request: ChatRequest): Promise<Answer> };
export type ProviderScore = { passed: number; runs: number; unanswered: number; tokens: number; ms: number; replies: string[] };
export type TurnResult = { name: string; kind: ParityTurn["kind"]; scores: Record<ProviderName, ProviderScore> };
export type ParityReport = { models: Record<ProviderName, string>; runs: number; turns: TurnResult[]; totals: Record<ProviderName, Omit<ProviderScore, "replies">>; parity: boolean; worse: string[]; invalid: string[] };

export const KIMI_FLOOR = 0.5;
export const KIMI_LIST_CALL = "functions.computer_list:0";
export const KIMI_EXEC_CALL = "functions.computer_exec:0";

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const COMBINATORS = ["anyOf", "oneOf", "allOf", "not"];

export function computerTools() {
  return TOOLS.map((tool) => {
    const parameters: Record<string, unknown> = { ...tool.inputSchema };
    for (const key of COMBINATORS) delete parameters[key];
    return { type: "function", function: { name: tool.name, description: tool.description, parameters } };
  });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const inside = (x: number, y: number, box: typeof RED_BUTTON) => x >= box.left && x < box.right && y >= box.top && y < box.bottom;

export async function buttonsScreenshot(): Promise<string> {
  const { width, height } = SCREEN;
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const color = inside(x, y, RED_BUTTON) ? [220, 40, 40] : inside(x, y, GREEN_BUTTON) ? [40, 170, 60] : y < 24 ? [60, 60, 70] : [236, 236, 236];
      raw.set(color, row + 1 + x * 3);
    }
  }
  const compressed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  let binary = "";
  for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const toolResult = (id: string, result: string) => ({ role: "tool", tool_call_id: id, content: JSON.stringify({ ok: true, result }) });
const calledOnly = (reply: Reply, name: string) => reply.toolCalls.length > 0 && reply.toolCalls.every((item) => item.name === name);
const first = (reply: Reply, name: string) => reply.toolCalls.find((item) => item.name === name);

export async function parityTurns(): Promise<ParityTurn[]> {
  const screenshot = await buttonsScreenshot();
  const system = { role: "system", content: SYSTEM };
  return [
    {
      name: "plain answer, no tool",
      kind: "chat",
      messages: [system, { role: "user", content: "What is 17 times 23? Reply with just the number." }],
      passes: (reply) => reply.toolCalls.length === 0 && reply.text.includes("391"),
    },
    {
      name: "picks the list tool",
      kind: "tool",
      messages: [system, { role: "user", content: "Which cloud computers do I have?" }],
      passes: (reply) => calledOnly(reply, "computer_list"),
    },
    {
      name: "fills a command's arguments",
      kind: "tool",
      messages: [system, { role: "user", content: `On my computer ${COMPUTER_ID}, run uname -a and tell me which kernel it has.` }],
      passes: (reply) => {
        const exec = first(reply, "computer_exec");
        return Boolean(exec && exec.args.computer_id === COMPUTER_ID && typeof exec.args.command === "string" && exec.args.command.includes("uname"));
      },
    },
    {
      name: "wakes a sleeping computer after Kimi listed them",
      kind: "tool",
      messages: [
        system,
        { role: "user", content: "Take a screenshot of my computer." },
        { role: "assistant", content: null, tool_calls: [call(KIMI_LIST_CALL, "computer_list", {})] },
        toolResult(KIMI_LIST_CALL, JSON.stringify([{ id: COMPUTER_ID, name: "dev", size: "small", state: "sleeping" }])),
      ],
      passes: (reply) => first(reply, "computer_wake")?.args.computer_id === COMPUTER_ID,
    },
    {
      name: "clicks what the screenshot shows",
      kind: "computer",
      messages: [
        system,
        { role: "user", content: `On my computer ${COMPUTER_ID}, click the green button. Do not click the red one.` },
        { role: "assistant", content: null, tool_calls: [call("call_shot", "computer_screenshot", { computer_id: COMPUTER_ID })] },
        toolResult("call_shot", `Screenshot taken, ${SCREEN.width}x${SCREEN.height} pixels. Coordinates are screen pixels from the top left.`),
        { role: "user", content: [{ type: "text", text: `${SCREENSHOT_LABEL} call_shot:` }, { type: "image_url", image_url: { url: screenshot } }] },
      ],
      passes: (reply) => {
        const action = first(reply, "computer_action");
        if (!action || action.args.computer_id !== COMPUTER_ID || action.args.action !== "click") return false;
        const { x, y } = action.args;
        return typeof x === "number" && typeof y === "number" && inside(x, y, GREEN_BUTTON);
      },
    },
    {
      name: "finishes in words after a tool result",
      kind: "tool",
      messages: [
        system,
        { role: "user", content: `How full is the disk on my computer ${COMPUTER_ID}?` },
        { role: "assistant", content: null, tool_calls: [call(KIMI_EXEC_CALL, "computer_exec", { computer_id: COMPUTER_ID, command: "df -h /" })] },
        toolResult(KIMI_EXEC_CALL, JSON.stringify({ exit_code: 0, stdout: "Filesystem Size Used Avail Use% Mounted on\n/dev/vda1 20G 5.1G 15G 26% /\n", stderr: "", timed_out: false })),
      ],
      passes: (reply) => reply.toolCalls.length === 0 && /26\s?%|5\.1\s?G/.test(reply.text),
    },
  ];
}

export function replyOf(completion: Record<string, unknown> | null): Reply | null {
  if (!completion || !Array.isArray(completion.choices) || !isRecord(completion.choices[0]) || !isRecord(completion.choices[0].message)) return null;
  const message = completion.choices[0].message;
  const toolCalls: ToolCall[] = [];
  for (const item of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!isRecord(item) || !isRecord(item.function) || typeof item.function.name !== "string") continue;
    let args: unknown = {};
    try {
      args = typeof item.function.arguments === "string" && item.function.arguments.trim() ? JSON.parse(item.function.arguments) : {};
    } catch {
      args = {};
    }
    toolCalls.push({ name: item.function.name, args: isRecord(args) ? args : {} });
  }
  return { text: typeof message.content === "string" ? message.content : "", toolCalls };
}

const describeReply = (reply: Reply | null) => (reply === null ? "no answer" : reply.toolCalls.length ? reply.toolCalls.map((item) => `${item.name}(${JSON.stringify(item.args).slice(0, 120)})`).join(", ") : `text: ${reply.text.slice(0, 120)}`);

export function chatOf(messages: unknown[]): ChatRequest {
  const parsed = chatRequest({ messages, tools: computerTools(), stream: false, max_tokens: 1_000 }, "later-dog");
  if (!parsed.ok) throw new Error(`A parity turn is not a valid chat request: ${parsed.refusal.message}`);
  return parsed.request;
}

export async function runParity(providers: Provider[], turns: ParityTurn[], runs: number): Promise<ParityReport> {
  const empty = (): ProviderScore => ({ passed: 0, runs: 0, unanswered: 0, tokens: 0, ms: 0, replies: [] });
  const results: TurnResult[] = [];
  for (const turn of turns) {
    const scores = { kimi: empty(), haiku: empty() };
    const request = chatOf(turn.messages);
    for (let run = 0; run < runs; run++) {
      for (const provider of providers) {
        const score = scores[provider.name];
        const answer = await provider.ask(request).catch((): Answer => ({ completion: null, ms: 0 }));
        const reply = replyOf(answer.completion);
        score.runs += 1;
        score.ms += answer.ms;
        score.tokens += tokensOf(answer.completion?.usage);
        if (!reply) score.unanswered += 1;
        if (reply && turn.passes(reply)) score.passed += 1;
        else score.replies.push(describeReply(reply));
      }
    }
    results.push({ name: turn.name, kind: turn.kind, scores });
  }
  const total = (name: ProviderName) => results.reduce((sum, turn) => {
    const score = turn.scores[name];
    return { passed: sum.passed + score.passed, runs: sum.runs + score.runs, unanswered: sum.unanswered + score.unanswered, tokens: sum.tokens + score.tokens, ms: sum.ms + score.ms };
  }, { passed: 0, runs: 0, unanswered: 0, tokens: 0, ms: 0 });
  const totals = { kimi: total("kimi"), haiku: total("haiku") };
  const worse = results.filter((turn) => turn.scores.haiku.passed < turn.scores.kimi.passed).map((turn) => turn.name);
  const models = { kimi: providers.find((item) => item.name === "kimi")?.model ?? "", haiku: providers.find((item) => item.name === "haiku")?.model ?? "" };
  const invalid = invalidReasons(totals);
  return { models, runs, turns: results, totals, parity: invalid.length === 0 && worse.length === 0, worse, invalid };
}

function invalidReasons(totals: Record<ProviderName, Omit<ProviderScore, "replies">>): string[] {
  const reasons: string[] = [];
  for (const name of ["kimi", "haiku"] as const) {
    const score = totals[name];
    if (score.runs === 0) reasons.push(`${name} was never asked`);
    else if (score.unanswered > 0) reasons.push(`${name} gave no answer on ${score.unanswered} of ${score.runs} runs`);
    else if (score.passed === 0) reasons.push(`${name} passed none of its ${score.runs} runs`);
  }
  const kimi = totals.kimi;
  if (kimi.runs > 0 && kimi.unanswered === 0 && kimi.passed > 0 && kimi.passed < kimi.runs * KIMI_FLOOR) reasons.push(`kimi passed only ${kimi.passed} of ${kimi.runs} runs, below the ${KIMI_FLOOR * 100}% floor, so the turns or the request shape are suspect`);
  return reasons;
}

export type LiveSettings = { accountId: string; token: string; gatewayId: string; kimiModel?: string; haikuModel?: string };

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

async function timed(work: () => Promise<Record<string, unknown> | null>): Promise<Answer> {
  const started = Date.now();
  const completion = await work();
  return { completion, ms: Date.now() - started };
}

export function liveProviders(settings: LiveSettings, fetcher: Fetcher = (url, init) => fetch(url, init)): Provider[] {
  const kimiModel = settings.kimiModel || AI_WORKERS_MODEL;
  const haikuModel = settings.haikuModel || AI_ANTHROPIC_MODEL;
  const kimi: Provider = {
    name: "kimi",
    model: kimiModel,
    ask: (request) => timed(async () => {
      const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${settings.accountId}/ai/run/${kimiModel}`, {
        method: "POST",
        headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json" },
        body: JSON.stringify(workersInput(request)),
      });
      if (!response.ok) return null;
      const json: unknown = await response.json();
      const result = isRecord(json) && isRecord(json.result) ? json.result : json;
      return isRecord(result) ? result : null;
    }),
  };
  const haiku: Provider = {
    name: "haiku",
    model: haikuModel,
    ask: (request) => timed(async () => {
      const body = messagesRequest(request, haikuModel);
      if (!body) return null;
      const response = await fetcher(`https://gateway.ai.cloudflare.com/v1/${settings.accountId}/${settings.gatewayId}/anthropic/v1/messages`, {
        method: "POST",
        headers: { "cf-aig-authorization": `Bearer ${settings.token}`, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json", "cf-aig-collect-log": "false", "cf-aig-no-wholesale": "true" },
        body: JSON.stringify(body),
      });
      if (!response.ok) return null;
      return chatCompletion(await response.json());
    }),
  };
  return [kimi, haiku];
}

export function parityTable(report: ParityReport): string {
  const lines = [`Kimi ${report.models.kimi} vs Claude ${report.models.haiku}, ${report.runs} run(s) per turn`];
  for (const turn of report.turns) {
    const { kimi, haiku } = turn.scores;
    lines.push(`${turn.scores.haiku.passed < turn.scores.kimi.passed ? "WORSE" : "ok   "} ${turn.kind.padEnd(8)} ${turn.name.padEnd(42)} kimi ${kimi.passed}/${kimi.runs}  haiku ${haiku.passed}/${haiku.runs}`);
  }
  const { kimi, haiku } = report.totals;
  lines.push(`total: kimi ${kimi.passed}/${kimi.runs} (${kimi.tokens} tokens, ${kimi.ms} ms)  haiku ${haiku.passed}/${haiku.runs} (${haiku.tokens} tokens, ${haiku.ms} ms)`);
  if (report.invalid.length) lines.push(`eval invalid, not a parity result: ${report.invalid.join("; ")}`);
  else lines.push(report.parity ? "parity: Claude matches or beats Kimi on every turn" : `parity: NO, Claude is worse on: ${report.worse.join("; ")}`);
  return lines.join("\n");
}
