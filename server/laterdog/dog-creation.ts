import { clip } from "../peer-roster.ts";
import type { BotRecord, Store } from "../store.ts";

// Who may create a dog, and what the new dog says first.
//
// Upstream later.dog lets only a section's Chief of Staff create bots. In later.dog, as in the reference product, any dog
// makes a dog when the person asks: it asks at most one question (what the new one is for, and a name), creates it, and
// says it is in the sidebar, where the new dog is already greeting the person in its own chat. Only that changes. Team
// setup, deletions, rooms, retries and changing another dog's profile or model stay a Chief's (CHIEF_ONLY_TOOL_NAMES and
// CHIEF_TARGET_TOOL_NAMES in server/drivers/agents-catalog.ts), and creation keeps every other guard of
// /api/internal/create-bot in server/index.ts: four per turn, the workspace limit, no duplicate name in the section, the
// creator's section and audience, and connected apps, automatic approvals and peer-approval skipping off. Model-facing
// words still say "bot".

/** Whether `bot` may create a dog: every dog the person can see may, an archived (hidden) one may not. */
export function mayCreateDogs(bot: Pick<BotRecord, "hidden"> | null | undefined): boolean {
  return bot != null && bot.hidden !== true;
}

/** What the create-bot route answers an archived dog. The model reads it as the tool result and passes it on. */
export const DOG_CREATION_REFUSAL = "This bot is archived, so it cannot create bots. Ask the person to restore it first.";

/** Every dog's system prompt carries this (PROFILE_PROMPT in server/system-prompt.ts) in place of upstream's "bot creation
 * is for Chiefs", which is what made a first dog refuse "can u make another agent". */
export const DOG_CREATION_PROMPT =
  " When the person asks for another bot (an agent, a teammate, a helper), create it yourself with create_bot rather than clicking through this app with computer control. Team setup, deleting bots and managing rooms are a Chief's job: other bots ask a reachable Chief through the peer tools, and if none is reachable, explain the team-access blocker instead of clicking around it.";

export interface DogGreeting {
  /** The new dog's name. */
  name: string;
  /** What it is for, as create_bot's role: a few words that finish "set me up for…". */
  role?: string;
  /** Who asked; without one the greeting says just "Hi". */
  personName?: string;
  /** The dog that created it. */
  creatorName?: string;
}

/**
 * The new dog's first message, in its own chat: "Hi Jacob, I'm Scout. Biscuit set me up for research and writing. What
 * should I start on?" Each part is somebody's typed text, so it is flattened onto one line and clipped (peer-roster.ts),
 * and a part that is missing is left out rather than filled in.
 */
export function dogGreeting({ name, role, personName, creatorName }: DogGreeting): string {
  const dog = clip(name, 80);
  const person = clip(personName ?? "", 80);
  const creator = clip(creatorName ?? "", 80);
  const job = clip(role ?? "", 120).replace(/[\s.!?…]+$/u, "");
  const hello = person ? `Hi ${person}, I'm ${dog}.` : `Hi, I'm ${dog}.`;
  const setUp = creator ? `${creator} set me up${job ? ` for ${job}` : ""}.` : job ? `I'm here for ${job}.` : "";
  return [hello, setUp, "What should I start on?"].filter(Boolean).join(" ");
}

/**
 * Posts the greeting as the first message of the new dog's own chat and marks that chat unread, so the person finds it in
 * the sidebar already saying hello. The person is whoever last wrote in the conversation the request came from (a shared
 * workspace names each sender), else the workspace profile name. Returns whether it was posted: the dog exists either way,
 * so a failed write is logged, not thrown, and the tool result claims only what happened.
 */
export function greetNewDog(
  store: Pick<Store, "messagesFor" | "appendMessage" | "patchTask">,
  dog: Pick<BotRecord, "id" | "threadId" | "name" | "title">,
  request: { creatorName: string; threadId: string; profileName?: string },
): boolean {
  try {
    const asked = store.messagesFor(request.threadId).findLast((line) => line.role === "user" && !line.peerAsk);
    const text = dogGreeting({ name: dog.name, role: dog.title, personName: asked?.sender?.name ?? request.profileName, creatorName: request.creatorName });
    store.appendMessage(dog.threadId, { role: "bot", kind: "text", text });
    store.patchTask(dog.id, dog.threadId, { unread: true });
    return true;
  } catch (error) {
    console.warn(`[dog-creation] could not post ${dog.id}'s greeting: ${(error as Error).message}`);
    return false;
  }
}
