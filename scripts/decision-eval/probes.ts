import type { AppConfig } from "../../server/config.ts";
import { createDecider } from "../../server/decider/index.ts";
import { DECISION_MODELS, decisionItems, ruleCorrect, type DecisionItem } from "./cases.ts";
import type { Receipt } from "./score.ts";

export const PROBE_DEADLINE_MS = 100;
export const MADE_UP_TARGET = "made-up invalid answers";

const madeUp = (name: string, group: string, item: string, result: unknown): Receipt => ({
  id: `made-up:${name}`, group, model: "clef", item, target: MADE_UP_TARGET, at: "", latencyMs: 0, status: 200, ok: true, result,
});

export const MADE_UP_INVALID_ANSWERS: readonly Receipt[] = [
  madeUp("not-an-object", "heavyCommand", "h001", "nothing"),
  madeUp("no-answer", "waitingOnOwner", "w001", { answers: {} }),
  madeUp("probability-above-one", "heavyCommand", "h002", { answers: { answer: { type: "noul", noul: 1.4 } } }),
  madeUp("choice-not-offered", "roomRouting", "r02", { answers: { answer: { type: "choice", choice: "nobody-offered", probabilities: { "nobody-offered": 1 } } } }),
  madeUp("probabilities-short-of-one", "dogRanking", "k001", { answers: { answer: { type: "choice", choice: "pane", probabilities: { pane: 0.3, desk: 0.1 } } } }),
];

export interface ProbeReplay {
  id: string;
  target: string;
  provider: string;
  decider: string;
  ruleAnswered: boolean;
  ruleRight: boolean | null;
}

const REPLAY_CONFIG: AppConfig = { decider: { enabled: true, key: "replay-only-never-sent", jobs: { roomRouting: true } } };

function providerOutcome(receipt: Receipt): string {
  if (receipt.error === "timeout") return "no answer by the deadline";
  if (receipt.status === undefined) return "unreachable";
  return `HTTP ${receipt.status}`;
}

function standIn(receipt: Receipt): typeof fetch {
  return async (_url, init) => {
    if (receipt.error === "timeout") {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (receipt.status === undefined) throw new TypeError("unreachable");
    const body = receipt.ok ? receipt.result : { errors: receipt.error };
    return new Response(JSON.stringify(body), { status: receipt.status, headers: { "content-type": "application/json" } });
  };
}

export async function replayProbes(receipts: readonly Receipt[], items: readonly DecisionItem[] = decisionItems()): Promise<ProbeReplay[]> {
  const byId = new Map(items.map((item) => [`${item.group}:${item.id}`, item]));
  const standby = items.find((item) => item.group === "roomRouting")!;
  const replays: ProbeReplay[] = [];
  for (const receipt of receipts) {
    if (!(DECISION_MODELS as readonly string[]).includes(receipt.model)) continue;
    const own = byId.get(`${receipt.group}:${receipt.item}`);
    const item = own ?? standby;
    const decider = createDecider({ config: () => REPLAY_CONFIG, fetch: standIn(receipt) });
    const result = await decider.ask("roomRouting", item.state, { answer: item.question }, { timeoutMs: PROBE_DEADLINE_MS });
    replays.push({
      id: receipt.id,
      target: receipt.target,
      provider: providerOutcome(receipt),
      decider: result.ok ? "answered" : result.reason,
      ruleAnswered: !result.ok,
      ruleRight: result.ok || !own ? null : ruleCorrect(own),
    });
  }
  return replays;
}

export function renderProbes(replays: readonly ProbeReplay[]): string {
  const groups = new Map<string, ProbeReplay[]>();
  for (const replay of replays) {
    const key = `${replay.target}\0${replay.provider}\0${replay.decider}`;
    groups.set(key, [...(groups.get(key) ?? []), replay]);
  }
  const rows = [...groups].map(([key, group]) => {
    const [target, provider, decider] = key.split("\0") as [string, string, string];
    const fellBack = group.filter((replay) => replay.ruleAnswered);
    const labelled = fellBack.filter((replay) => replay.ruleRight !== null);
    return [
      target, provider, String(group.length), decider, `${fellBack.length} of ${group.length}`,
      labelled.length ? `${labelled.filter((replay) => replay.ruleRight).length} of ${labelled.length}` : "n/a",
    ];
  });
  const head = ["Replayed from", "What the provider did", "Calls", "What the decider reported", "Rule answered instead", "Rule right, where labelled"];
  return `${[`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n")}\n`;
}
