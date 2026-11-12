import { redactSecretsInText } from "../../shared/redact.ts";
import type { SecretRequestCardData } from "../../shared/wire.ts";
import type { SecureFormCardData } from "../../shared/secure-form.ts";

export const CROSS_DOG_RECALL_PROMPT =
  " When you work for the owner, session_search with bot (another dog's name or id, or \"all\") also searches the owner's other dogs' chats, group chats and memory files, and session_read reads any message or memory file a hit names.";

export const ALL_DOGS = "all";

export interface RecallDog {
  id: string;
  name: string;
  threadId: string;
  tasks?: ReadonlyArray<{ threadId: string; title: string }>;
}

export interface RecallRoom {
  id: string;
  name: string;
  threadId: string;
  memberIds: readonly string[];
  tasks?: ReadonlyArray<{ threadId: string; title: string }>;
}

export interface RecallChat {
  dogId?: string;
  dog: string;
  chat: string;
  room?: string;
}

export function mayRecallAcrossDogs(input: { main: boolean; ownerWork: boolean; guestDriven: boolean }): boolean {
  if (input.guestDriven) return false;
  return input.main || input.ownerWork;
}

export const CROSS_DOG_REFUSAL =
  "Only the owner's main dog, or a dog working for the owner in the owner's home, can search other dogs' chats and memory. Search your own with no bot.";

export function crossDogChats(dogs: readonly RecallDog[], rooms: readonly RecallRoom[], targetIds: ReadonlySet<string>): Map<string, RecallChat> {
  const chats = new Map<string, RecallChat>();
  for (const dog of dogs) {
    if (!targetIds.has(dog.id)) continue;
    chats.set(dog.threadId, { dogId: dog.id, dog: dog.name, chat: "main chat" });
    for (const task of dog.tasks ?? []) {
      if (task.threadId !== dog.threadId) chats.set(task.threadId, { dogId: dog.id, dog: dog.name, chat: `task "${task.title}"` });
    }
  }
  const names = new Map(dogs.map((dog) => [dog.id, dog.name]));
  for (const room of rooms) {
    const members = room.memberIds.filter((id) => targetIds.has(id));
    if (!members.length) continue;
    const dog = members.map((id) => names.get(id)).filter(Boolean).join(", ") || "group chat";
    chats.set(room.threadId, { dog, chat: `group chat "${room.name}"`, room: room.name });
    for (const task of room.tasks ?? []) {
      chats.set(task.threadId, { dog, chat: `group chat "${room.name}", task "${task.title}"`, room: room.name });
    }
  }
  return chats;
}

export interface RecallRow {
  kind?: string;
  text?: string;
  secureForm?: Pick<SecureFormCardData, "title">;
  secret?: Pick<SecretRequestCardData, "label">;
}

export function safeRecallText(row: RecallRow): string {
  if (row.secureForm) return `Secure form: ${row.secureForm.title}`;
  if (row.secret) return `Key request: ${row.secret.label}`;
  if (row.kind === "secret") return "Secure request";
  return redactSecretsInText(row.text ?? "");
}

export function interleave<T>(lists: readonly (readonly T[])[], limit: number): T[] {
  const out: T[] = [];
  for (let round = 0; out.length < limit; round++) {
    let any = false;
    for (const list of lists) {
      if (round >= list.length) continue;
      any = true;
      out.push(list[round]!);
      if (out.length >= limit) break;
    }
    if (!any) break;
  }
  return out;
}

const MEMORY_FILE = /^(?:MEMORY\.md|memory\/(?:log\/)?[\p{L}\p{N}_][\p{L}\p{N}_ .-]{0,199}\.md)$/u;

export function isRecallMemoryFile(file: string): boolean {
  return MEMORY_FILE.test(file) && !file.split("/").some((part) => part === ".." || part === ".");
}
