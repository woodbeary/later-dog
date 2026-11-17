import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";

export const COMMAND_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_SAVED_COMMANDS = 100;
export const MAX_COMMAND_TEXT = 8_000;
export const COMPACT_COMMAND = "compact";
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([COMPACT_COMMAND, "learn"]);
export const COMMANDS_FILE = "commands.json";

export interface SavedCommand {
  name: string;
  text: string;
  updatedAt: number;
}

export type SlashCommandKind = "mine" | "trick" | "standard" | "action";

export interface SlashCommand {
  name: string;
  line: string;
  kind: SlashCommandKind;
  text?: string;
}

export interface DogTrick {
  name: string;
  description: string;
}

export interface StandardCommand {
  name: string;
  line: string;
  text: string;
}

export const STANDARD_COMMANDS: readonly StandardCommand[] = [
  {
    name: "review",
    line: "Look over the work in this chat for real faults",
    text: "Review the changes from this work as a careful second pair of eyes. Look for real faults: wrong behaviour, cases that break, missing tests, anything that would cost me time later. List them most serious first, each with where it is and how you checked it, and say plainly if you found nothing. Change nothing yet.",
  },
  {
    name: "simplify",
    line: "Make what changed simpler without changing what it does",
    text: "Go over what changed in this work and make it simpler without changing what it does: reuse what already exists, remove what is not needed, keep names clear. Run the tests afterwards and say what you changed.",
  },
  {
    name: "debug",
    line: "Find the cause before changing anything",
    text: "Find the cause of this problem before changing anything: reproduce it, read the code and logs it runs through, and say what is wrong and how you know. Then fix the cause, not the symptom, and show the fix working.",
  },
  {
    name: "coordinate",
    line: "Plan it yourself and hand the parts to helpers",
    text: "Coordinate this yourself: keep the planning and the judgment, and hand each well-defined part to a helper or another dog with everything it needs to finish alone (the goal, the exact names and values, the steps, what done means). Give hard judgment to the strongest model and clear-cut execution to a cheaper capable one. Check what comes back before you rely on it, and tell me how it went.",
  },
  {
    name: "finish",
    line: "Carry it to the end and check it",
    text: "Carry this to the end without stopping to ask: work through errors and failing tools, make the engineering choices yourself, and check the result by running it. Then tell me what you verified and what you assumed.",
  },
  {
    name: "status",
    line: "Where things stand: done, in progress, not started",
    text: "Tell me where things stand: what is done, what is in progress, what is not started, and what is built but not live yet. Answer from your plan, in short lines.",
  },
];

const COMPACT_LINE = "Summarize this chat so far to free up room";
const TRICK_LINE = "One of this dog's tricks";

export function commandLine(text: string): string {
  const first = text.trim().split("\n", 1)[0].trim();
  return first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first;
}

export function dogCommands(saved: readonly SavedCommand[], tricks: readonly DogTrick[]): SlashCommand[] {
  const taken = new Set<string>();
  const out: SlashCommand[] = [];
  const add = (command: SlashCommand) => {
    if (taken.has(command.name)) return;
    taken.add(command.name);
    out.push(command);
  };
  for (const command of saved) add({ name: command.name, line: commandLine(command.text), kind: "mine", text: command.text });
  for (const trick of tricks) {
    const name = trick.name.toLowerCase();
    if (!COMMAND_NAME.test(name) || RESERVED_COMMAND_NAMES.has(name)) continue;
    add({ name, line: commandLine(trick.description) || TRICK_LINE, kind: "trick", text: `Use your trick "${trick.name}" for this.` });
  }
  for (const command of STANDARD_COMMANDS) add({ name: command.name, line: command.line, kind: "standard", text: command.text });
  add({ name: COMPACT_COMMAND, line: COMPACT_LINE, kind: "action" });
  return out;
}

const LEADING_COMMAND = /^\/([a-z0-9][a-z0-9-]*)(?=\s|$)/i;

export function expandCommand(text: string, commands: readonly SlashCommand[]): { text: string; name: string } | null {
  const match = LEADING_COMMAND.exec(text);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const command = commands.find((candidate) => candidate.name === name);
  if (!command || command.kind === "action") return null;
  const words = text.slice(match[0].length).trim();
  const body = (command.text ?? "").trim();
  if (!body) return null;
  return { name, text: words ? `${body}\n\n${words}` : body };
}

export interface CommandSender {
  scopes: readonly string[];
  fromLocalTools: boolean;
}

export function sendsCommands(sender: CommandSender): boolean {
  return !sender.fromLocalTools && sender.scopes.includes("admin");
}

export function commandSend(typed: string, sender: CommandSender, commands: () => readonly SlashCommand[]): { text: string; expanded: boolean } {
  if (!sendsCommands(sender) || !typed.startsWith("/")) return { text: typed, expanded: false };
  const expanded = expandCommand(typed, commands());
  return expanded ? { text: expanded.text, expanded: true } : { text: typed, expanded: false };
}

export function tricksInIndex<T extends DogTrick>(tricks: readonly T[], engineReadsFiles: boolean, index: () => string): T[] {
  if (!engineReadsFiles || !tricks.length) return [];
  const told = index();
  return tricks.filter((trick) => told.includes(`\n- ${trick.name}: `));
}

const storedSchema = z.object({
  commands: z.array(z.object({
    name: z.string().regex(COMMAND_NAME),
    text: z.string().min(1).max(MAX_COMMAND_TEXT),
    updatedAt: z.number().int().nonnegative(),
  })).max(MAX_SAVED_COMMANDS),
});

export class CommandRefused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function commandName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().replace(/^\//, "").toLowerCase() : "";
  if (!COMMAND_NAME.test(name)) throw new CommandRefused(400, "A command name is up to 32 letters, digits or dashes, like plan-it.");
  if (RESERVED_COMMAND_NAMES.has(name)) throw new CommandRefused(409, `/${name} is already a later.dog command. Pick another name.`);
  return name;
}

export function commandText(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) throw new CommandRefused(400, "Write what the command should send.");
  if (text.length > MAX_COMMAND_TEXT) throw new CommandRefused(400, `A command can be up to ${MAX_COMMAND_TEXT.toLocaleString("en-US")} characters.`);
  return text;
}

export class SavedCommands {
  private readonly file: string;
  private readonly now: () => number;

  constructor(dataDir: string, now: () => number = Date.now) {
    this.file = join(dataDir, COMMANDS_FILE);
    this.now = now;
  }

  list(): SavedCommand[] {
    return this.read() ?? [];
  }

  create(rawName: unknown, rawText: unknown): SavedCommand {
    const name = commandName(rawName);
    const text = commandText(rawText);
    const commands = this.writable();
    if (commands.some((command) => command.name === name)) throw new CommandRefused(409, `You already have /${name}.`);
    if (commands.length >= MAX_SAVED_COMMANDS) throw new CommandRefused(409, `You can keep up to ${MAX_SAVED_COMMANDS} commands. Delete one you no longer use first.`);
    const command = { name, text, updatedAt: this.now() };
    this.write([...commands, command]);
    return command;
  }

  update(currentName: string, patch: { name?: unknown; text?: unknown }): SavedCommand {
    const commands = this.writable();
    const at = commands.findIndex((command) => command.name === currentName.toLowerCase());
    if (at < 0) throw new CommandRefused(404, "That command is gone.");
    const name = patch.name === undefined ? commands[at].name : commandName(patch.name);
    const text = patch.text === undefined ? commands[at].text : commandText(patch.text);
    if (name !== commands[at].name && commands.some((command) => command.name === name)) throw new CommandRefused(409, `You already have /${name}.`);
    const command = { name, text, updatedAt: this.now() };
    this.write(commands.map((existing, index) => (index === at ? command : existing)));
    return command;
  }

  remove(name: string): void {
    const commands = this.writable();
    const next = commands.filter((command) => command.name !== name.toLowerCase());
    if (next.length === commands.length) throw new CommandRefused(404, "That command is gone.");
    this.write(next);
  }

  private read(): SavedCommand[] | null {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      return null;
    }
    try {
      const parsed = storedSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.commands : null;
    } catch {
      return null;
    }
  }

  private writable(): SavedCommand[] {
    const commands = this.read();
    if (!commands) throw new CommandRefused(500, "Your saved commands could not be read, so nothing was changed.");
    return commands;
  }

  private write(commands: SavedCommand[]): void {
    writeFileAtomic(this.file, `${JSON.stringify({ commands }, null, 2)}\n`, { mode: 0o600 });
  }
}
