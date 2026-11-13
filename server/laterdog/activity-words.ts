import type { Store } from "../store.ts";
import { teammateEndLabel, type HandoffEnd } from "./handoff-budget.ts";
import { bareToolName, toolStepWords, type NameOf } from "../../shared/step-words.ts";

export function dogActivityWords(toolName: string, input: unknown, nameOf: NameOf, command = false): string | null {
  const name = bareToolName(toolName);
  if (!name || /^(auto-approved|error)$/i.test(name)) return null;
  return toolStepWords(toolName, input, nameOf)?.now ?? (command ? "running a few commands" : "working on it");
}

export function botNames(store: Pick<Store, "bot" | "bots">): NameOf {
  return (idOrName) => {
    const lower = idOrName.toLowerCase();
    return store.bot(idOrName)?.name ?? store.bots.find((bot) => bot.name.trim().toLowerCase() === lower)?.name;
  };
}

export function teammateDoneLabel(name: string, status: string, end?: HandoffEnd): string {
  if (status === "needs-you") return `${name} needs you`;
  return status === "completed" ? `${name} done` : teammateEndLabel(name, status, end);
}

export function teammateResultLabel(name: string, status: string, withheld: string | null | undefined, room?: string, end?: HandoffEnd): string {
  if (withheld) return `${name}'s reply was held back`;
  if (status === "needs-you") return `${name} needs you`;
  if (status === "completed") return room ? `${name} replied · ${room}` : `${name} replied`;
  return teammateEndLabel(name, status, end);
}
