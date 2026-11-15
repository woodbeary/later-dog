export type DogCommandKind = "mine" | "trick" | "standard" | "action";

export interface DogCommand {
  name: string;
  line: string;
  kind: DogCommandKind;
  text?: string;
}

export interface SavedDogCommand {
  name: string;
  text: string;
  updatedAt: number;
}

export type ComposerSlashChoice =
  | { key: string; type: "command"; command: DogCommand }
  | { key: "new"; type: "new" };

export const COMPACT_ACTION: DogCommand = { name: "compact", line: "", kind: "action" };

export const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const COMMAND_TEXT_LIMIT = 8_000;

export interface ComposerSlashTrigger {
  query: string;
  start: number;
  end: number;
}

export function composerSlashTrigger(text: string, caretInput: number): ComposerSlashTrigger | null {
  const caret = Math.max(0, Math.min(text.length, Math.floor(caretInput)));
  const prefix = text.slice(0, caret);
  const match = /^\/([a-z0-9-]*)$/i.exec(prefix);
  if (!match) return null;
  return { query: match[1] ?? "", start: 0, end: caret };
}

export function replaceComposerSlashTrigger(
  text: string,
  trigger: ComposerSlashTrigger,
  replacement: string,
): { text: string; caret: number } {
  const next = `${text.slice(0, trigger.start)}${replacement}${text.slice(trigger.end)}`;
  return { text: next, caret: trigger.start + replacement.length };
}

export function cleanCommandName(raw: string): string {
  return raw.trim().replace(/^\/+/, "").toLowerCase();
}

export function suggestedCommandName(text: string): string {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let name = "";
  for (const word of words.slice(0, 3)) {
    const next = name ? `${name}-${word}` : word;
    if (next.length > 32) break;
    name = next;
  }
  return name;
}

function rank(command: DogCommand, query: string): number {
  if (!query) return 0;
  if (command.name.startsWith(query)) return 0;
  if (command.name.includes(query)) return 1;
  if (command.line.toLowerCase().split(/[^a-z0-9]+/).some((word) => word.startsWith(query))) return 2;
  return -1;
}

export function slashChoices(commands: readonly DogCommand[], query: string, canSave: boolean): ComposerSlashChoice[] {
  const wanted = query.toLowerCase();
  const matches = commands
    .map((command, index) => ({ command, index, rank: rank(command, wanted) }))
    .filter((entry) => entry.rank >= 0)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ command }): ComposerSlashChoice => ({ key: `${command.kind}:${command.name}`, type: "command", command }));
  return canSave && (matches.length > 0 || !wanted) ? [...matches, { key: "new", type: "new" }] : matches;
}

export function typedAction(text: string, commands: readonly DogCommand[]): DogCommand | null {
  const match = /^\/([a-z0-9-]+)$/i.exec(text.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  return commands.find((command) => command.kind === "action" && command.name === name) ?? null;
}
