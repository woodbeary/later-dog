import { existsSync, readFileSync } from "node:fs";

import { writeFileAtomic } from "../atomic.ts";

export const DOG_PURGE_AFTER_MS = 30 * 24 * 60 * 60_000;

export interface DogRest {
  botId: string;
  name: string;
  at: number;
  by: string;
  hiddenBefore: boolean;
  routines: string[];
  webhooks: string[];
}

export type RestRefusal = "main" | "self" | "resting" | "missing";

export function restRefusal(input: { target?: { id: string } | null; caller: string; main: string | null; resting: boolean }): RestRefusal | null {
  if (!input.target) return "missing";
  if (input.target.id === input.main) return "main";
  if (input.target.id === input.caller) return "self";
  return input.resting ? "resting" : null;
}

export const REST_REFUSALS: Readonly<Record<RestRefusal, string>> = {
  main: "the main dog cannot be deleted",
  self: "a dog cannot delete itself",
  resting: "that dog is already in Recently deleted",
  missing: "no such dog",
};

export function purgeDue(rests: readonly DogRest[], now: number): DogRest[] {
  return rests.filter((rest) => now - rest.at >= DOG_PURGE_AFTER_MS);
}

export function findRest(rests: readonly DogRest[], nameOrId: string): DogRest | null {
  const wanted = nameOrId.trim().toLowerCase();
  if (!wanted) return null;
  return rests.find((rest) => rest.botId === nameOrId.trim()) ?? rests.filter((rest) => rest.name.toLowerCase() === wanted).sort((a, b) => b.at - a.at)[0] ?? null;
}

export class DogRestStore {
  readonly #file: string;
  #rests: DogRest[];

  constructor(file: string) {
    this.#file = file;
    this.#rests = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { rests?: DogRest[] }).rests ?? [] : [];
  }

  list(): DogRest[] {
    return [...this.#rests];
  }

  get(botId: string): DogRest | null {
    return this.#rests.find((rest) => rest.botId === botId) ?? null;
  }

  put(rest: DogRest): void {
    this.#rests = [...this.#rests.filter((existing) => existing.botId !== rest.botId), rest];
    this.#save();
  }

  take(botId: string): DogRest | null {
    const rest = this.get(botId);
    if (!rest) return null;
    this.#rests = this.#rests.filter((existing) => existing.botId !== botId);
    this.#save();
    return rest;
  }

  #save(): void {
    writeFileAtomic(this.#file, `${JSON.stringify({ rests: this.#rests }, null, 1)}\n`, { mode: 0o600 });
  }
}
