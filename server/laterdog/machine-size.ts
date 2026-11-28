import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import { heavyCommandKind } from "./heavy-commands.ts";
import { MACHINE_SIZES, type MachineSize } from "./machine-size-words.ts";

export { MACHINE_SIZES, type MachineSize };

export type MachineSizeReason = "upgraded" | "task" | "dog" | "code project" | "default";

export interface MachineChoice {
  size: MachineSize;
  reason: MachineSizeReason;
  signals?: string[];
  upgradedBecause?: string;
}

export type UpgradeCause = { kind: "heavy command"; detail: string } | { kind: "out of memory" } | { kind: "disk full" };

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "go.sum", "poetry.lock", "uv.lock", "Pipfile.lock", "Gemfile.lock", "composer.lock", "Podfile.lock"];
const MANIFESTS = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "setup.py", "requirements.txt", "Gemfile", "composer.json", "pom.xml", "build.gradle", "build.gradle.kts", "Package.swift", "CMakeLists.txt", "Makefile", "deno.json"];
const PROJECT_DIRS = /\.(?:xcodeproj|xcworkspace)$/;

function readable(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function codeProjectSignals(folder: string | undefined, linkedProject = false): string[] {
  const signals: string[] = [];
  if (linkedProject) signals.push("linked project");
  if (!folder) return signals;
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return signals;
  }
  const present = new Set(names);
  const lockfile = LOCKFILES.find((name) => present.has(name));
  if (lockfile) signals.push(`lockfile ${lockfile}`);
  const manifest = MANIFESTS.find((name) => present.has(name)) ?? names.find((name) => PROJECT_DIRS.test(name));
  if (manifest) signals.push(`package manifest ${manifest}`);
  const git = readable(join(folder, ".git", "config"));
  if (git && /^\[remote "origin"\]/m.test(git)) signals.push("git origin");
  return signals;
}

export function chooseMachineSize(input: { task?: MachineSize; dog?: MachineSize; upgraded?: string; signals: readonly string[] }): MachineChoice {
  if (input.upgraded) return { size: "large", reason: "upgraded", upgradedBecause: input.upgraded };
  if (input.task) return { size: input.task, reason: "task" };
  if (input.dog) return { size: input.dog, reason: "dog" };
  if (input.signals.length) return { size: "large", reason: "code project", signals: [...input.signals] };
  return { size: "small", reason: "default" };
}

const OUT_OF_MEMORY = /\b(?:out of memory|OOMKilled|oom-kill|JavaScript heap out of memory|Cannot allocate memory|ENOMEM|MemoryError)\b/i;
const DISK_FULL = /\b(?:No space left on device|ENOSPC|disk quota exceeded|EDQUOT)\b/i;

export function stopCause(stop: { exitCode?: number | null; signal?: string | null; output?: string }): UpgradeCause | null {
  const output = stop.output ?? "";
  if (DISK_FULL.test(output)) return { kind: "disk full" };
  if (OUT_OF_MEMORY.test(output) || stop.exitCode === 137 || stop.signal === "SIGKILL") return { kind: "out of memory" };
  return null;
}

export function commandCause(command: string, size: MachineSize): UpgradeCause | null {
  if (size !== "small") return null;
  const kind = heavyCommandKind(command);
  return kind ? { kind: "heavy command", detail: kind } : null;
}

export function causeWords(cause: UpgradeCause): string {
  return cause.kind === "heavy command" ? cause.detail : cause.kind;
}

interface ThreadEntry {
  size?: MachineSize;
  upgraded?: string;
  at: number;
}

interface BookFile {
  version: 1;
  dogs: Record<string, MachineSize>;
  threads: Record<string, ThreadEntry>;
}

const threadKey = (dogId: string, threadId: string) => `${dogId}\u0000${threadId}`;

function isSize(value: unknown): value is MachineSize {
  return typeof value === "string" && (MACHINE_SIZES as readonly string[]).includes(value);
}

export class MachineSizeBook {
  readonly #file: string | undefined;
  readonly #now: () => number;
  #book: BookFile;

  constructor(file?: string, now: () => number = Date.now) {
    this.#file = file;
    this.#now = now;
    this.#book = MachineSizeBook.#load(file);
  }

  static #load(file: string | undefined): BookFile {
    const empty: BookFile = { version: 1, dogs: {}, threads: {} };
    if (!file || !existsSync(file)) return empty;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<BookFile>;
      const dogs = Object.fromEntries(Object.entries(parsed.dogs ?? {}).filter(([, size]) => isSize(size)));
      const threads = Object.fromEntries(Object.entries(parsed.threads ?? {}).filter(([, entry]) => entry && typeof entry === "object" && (entry.size === undefined || isSize(entry.size))));
      return { version: 1, dogs, threads };
    } catch {
      return empty;
    }
  }

  #save(): void {
    if (this.#file) writeFileAtomic(this.#file, `${JSON.stringify(this.#book, null, 2)}\n`, { mode: 0o600 });
  }

  dogSize(dogId: string): MachineSize | undefined {
    return this.#book.dogs[dogId];
  }

  setDogSize(dogId: string, size: MachineSize | null): void {
    if (size === null) delete this.#book.dogs[dogId];
    else this.#book.dogs[dogId] = size;
    this.#save();
  }

  setTaskSize(dogId: string, threadId: string, size: MachineSize | null): void {
    const key = threadKey(dogId, threadId);
    const entry = this.#book.threads[key] ?? { at: this.#now() };
    if (size === null) delete entry.size;
    else entry.size = size;
    entry.at = this.#now();
    this.#book.threads[key] = entry;
    this.#save();
  }

  upgrade(dogId: string, threadId: string, cause: UpgradeCause): boolean {
    const key = threadKey(dogId, threadId);
    const entry = this.#book.threads[key] ?? { at: this.#now() };
    if (entry.upgraded) return false;
    entry.upgraded = causeWords(cause);
    entry.at = this.#now();
    this.#book.threads[key] = entry;
    this.#save();
    return true;
  }

  noteCommand(dogId: string, threadId: string, command: string, size: MachineSize): boolean {
    const cause = commandCause(command, size);
    return cause ? this.upgrade(dogId, threadId, cause) : false;
  }

  noteStop(dogId: string, threadId: string, stop: { exitCode?: number | null; signal?: string | null; output?: string }): boolean {
    const cause = stopCause(stop);
    return cause ? this.upgrade(dogId, threadId, cause) : false;
  }

  forget(dogId: string, threadId: string): void {
    if (!(threadKey(dogId, threadId) in this.#book.threads)) return;
    delete this.#book.threads[threadKey(dogId, threadId)];
    this.#save();
  }

  choose(dogId: string, threadId: string, folder: string | undefined, linkedProject = false): MachineChoice {
    const entry = this.#book.threads[threadKey(dogId, threadId)];
    return chooseMachineSize({
      ...(entry?.size ? { task: entry.size } : {}),
      ...(this.#book.dogs[dogId] ? { dog: this.#book.dogs[dogId] } : {}),
      ...(entry?.upgraded ? { upgraded: entry.upgraded } : {}),
      signals: entry?.upgraded || entry?.size || this.#book.dogs[dogId] ? [] : codeProjectSignals(folder, linkedProject),
    });
  }
}
