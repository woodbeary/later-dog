type Content = Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>;
export type StepResult = { content: Content; isError?: boolean };
export type RunStep = (name: string, args: Record<string, unknown>) => Promise<StepResult>;

export function abortableWait(signal: AbortSignal): (ms: number) => Promise<void> {
  return (ms) => new Promise<void>((settle) => {
    if (signal.aborted) return settle();
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); settle(); }, ms);
    const stop = () => { clearTimeout(timer); settle(); };
    signal.addEventListener("abort", stop, { once: true });
  }).then(() => signal.throwIfAborted());
}

export const RUN_MAX_STEPS = 25;
export const RUN_WAIT_MAX_MS = 5_000;

const PAGE_STEPS: Record<string, string> = { page_click: "page_click", page_fill: "page_fill", page_select: "page_select", page_press: "page_press" };
export const RUN_STEP_ACTIONS = ["click", "type", "key", "scroll", "wait", ...Object.keys(PAGE_STEPS)] as const;

const coordinate = { type: "integer", minimum: 0, maximum: 32767 };

export const RUN_ACTIONS_TOOL = {
  name: "run_actions",
  description: "Do several actions in order in one call and get one reading at the end: the page's structure when the page tools are offered, otherwise one screenshot. Steps: click (x, y), type (text), key (key), scroll (x, y, direction, amount), wait (ms), and with the page tools page_click (ref), page_fill (ref, text), page_select (ref, option) and page_press (key). It stops at the first step that fails and says which. Secure fields, vault items and commands cannot go in a run; use their own tools.",
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        minItems: 1,
        maxItems: RUN_MAX_STEPS,
        items: {
          type: "object",
          properties: {
            action: { type: "string", enum: RUN_STEP_ACTIONS },
            x: coordinate,
            y: coordinate,
            text: { type: "string", maxLength: 4000 },
            key: { type: "string", pattern: "^[A-Za-z0-9_+]+$", minLength: 1, maxLength: 100 },
            direction: { type: "string", enum: ["up", "down", "left", "right"] },
            amount: { type: "integer", minimum: 1, maximum: 30 },
            ms: { type: "integer", minimum: 0, maximum: RUN_WAIT_MAX_MS },
            ref: { type: "string", pattern: "^e[0-9]{1,6}$" },
            option: { type: "string", maxLength: 300 },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      reading: { type: "string", enum: ["page", "screenshot"], description: "What to read at the end. Defaults to the page when the page tools are offered, otherwise a screenshot." },
    },
    required: ["steps"],
    additionalProperties: false,
  },
};

type Step = Record<string, unknown> & { action: string };

const pick = (step: Step, keys: string[]) => Object.fromEntries(keys.filter((key) => step[key] !== undefined).map((key) => [key, step[key]]));

export function stepCall(step: Step): { name: string; args: Record<string, unknown> } | null {
  switch (step.action) {
    case "click": return { name: "click", args: pick(step, ["x", "y"]) };
    case "type": return { name: "type_text", args: pick(step, ["text"]) };
    case "key": return { name: "key_press", args: pick(step, ["key"]) };
    case "scroll": return { name: "scroll", args: { direction: "down", ...pick(step, ["x", "y", "direction", "amount"]) } };
    case "page_click": return { name: "page_click", args: pick(step, ["ref"]) };
    case "page_fill": return { name: "page_fill", args: pick(step, ["ref", "text"]) };
    case "page_select": return { name: "page_select", args: pick(step, ["ref", "option"]) };
    case "page_press": return { name: "page_press", args: pick(step, ["key"]) };
    default: return null;
  }
}

const describe = (step: Step) => {
  if (step.action === "type" || step.action === "page_fill") return `${step.action} ${typeof step.text === "string" ? step.text.length : 0} characters`;
  if (step.action === "wait") return `wait ${Number(step.ms ?? 0)} ms`;
  const where = step.ref ?? (step.x !== undefined ? `${step.x},${step.y}` : step.key ?? step.option ?? "");
  return `${step.action}${where === "" ? "" : ` ${String(where)}`}`;
};

const textOf = (content: Content) => content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join(" ").trim();

export async function runActions(input: {
  steps: Step[];
  reading?: "page" | "screenshot";
  pageTools: boolean;
  problem(name: string, args: Record<string, unknown>): string | null;
  run: RunStep;
  wait?: (ms: number) => Promise<void>;
  checkpoint?: () => Promise<string | null>;
}): Promise<StepResult> {
  const reading = input.reading ?? (input.pageTools ? "page" : "screenshot");
  if (reading === "page" && !input.pageTools) return { isError: true, content: [{ type: "text", text: "The page tools are not offered here, so a run can only end with a screenshot." }] };
  const planned: Array<{ step: Step; call: { name: string; args: Record<string, unknown> } | null }> = [];
  for (const [index, step] of input.steps.entries()) {
    if (step.action === "wait") { planned.push({ step, call: null }); continue; }
    const call = stepCall(step);
    if (!call) return { isError: true, content: [{ type: "text", text: `Step ${index + 1} (${step.action}) is not an action a run can do. Nothing ran.` }] };
    if (call.name.startsWith("page_") && !input.pageTools) return { isError: true, content: [{ type: "text", text: `Step ${index + 1} (${step.action}) needs the page tools, which are not offered here. Nothing ran.` }] };
    const problem = input.problem(call.name, call.args);
    if (problem) return { isError: true, content: [{ type: "text", text: `Step ${index + 1} (${step.action}) is not complete: ${problem} Nothing ran.` }] };
    planned.push({ step, call });
  }
  const wait = input.wait ?? ((ms: number) => new Promise<void>((settle) => setTimeout(settle, ms)));
  const done: string[] = [];
  let failure: string | null = null;
  const taken = async (before: string): Promise<StepResult | null> => {
    const reason = input.checkpoint ? await input.checkpoint() : null;
    if (!reason) return null;
    return { isError: true, content: [{ type: "text", text: `A person has taken control of the cloud computer, so the run stopped ${before}. ${done.length ? `Done before it: ${done.join("; ")}.` : "Nothing ran."} ${reason}` }] };
  };
  for (const [index, { step, call }] of planned.entries()) {
    const stopped = await taken(`before step ${index + 1} of ${planned.length}`);
    if (stopped) return stopped;
    if (!call) { await wait(Number(step.ms ?? 0)); done.push(describe(step)); continue; }
    const result = await input.run(call.name, call.args);
    if (result.isError) {
      failure = `Step ${index + 1} of ${planned.length} (${describe(step)}) failed: ${textOf(result.content) || "no reason given"}. ${done.length ? `Done before it: ${done.join("; ")}.` : "Nothing before it ran."} Nothing after it ran.`;
      break;
    }
    done.push(describe(step));
  }
  if (failure) {
    const reason = input.checkpoint ? await input.checkpoint() : null;
    if (reason) return { isError: true, content: [{ type: "text", text: `${failure} A person has taken control of the cloud computer, so there is no reading at the end. ${reason}` }] };
  } else {
    const stopped = await taken("before the reading at the end");
    if (stopped) return stopped;
  }
  const read = await input.run(reading === "page" ? "page_read" : "screenshot", {});
  const summary = failure ?? `Done, ${planned.length} steps: ${done.join("; ")}.`;
  return {
    ...(failure || read.isError ? { isError: true } : {}),
    content: [{ type: "text", text: read.isError ? `${summary} The reading at the end failed: ${textOf(read.content)}` : summary }, ...(read.isError ? [] : read.content)],
  };
}
