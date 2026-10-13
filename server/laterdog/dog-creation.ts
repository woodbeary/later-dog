import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode.ts";
import { clip } from "../peer-roster.ts";
import type { BotRecord, Store } from "../store.ts";


export function mayCreateDogs(bot: Pick<BotRecord, "hidden"> | null | undefined): boolean {
  return bot != null && bot.hidden !== true;
}

export const DOG_CREATION_REFUSAL = "This bot is archived, so it cannot create bots. Ask the person to restore it first.";

export const DOG_CREATION_PROMPT =
  " When the person asks for another bot (an agent, a teammate, a helper), create it yourself with create_bot rather than clicking through this app with computer control. When they ask for a group chat with teammates, create it yourself with create_room, and rename it or change who is in it with manage_room. Making a pack, changing another bot's settings and deleting a bot are team setup: unless you have tools for them, tell the person in one line where to do it in the app (Create a pack is in the sidebar's + menu) instead of clicking around it.";

export interface DogGreeting {
  name: string;
  role?: string;
  personName?: string;
  creatorName?: string;
}

export function dogGreeting({ name, role, personName, creatorName }: DogGreeting): string {
  const dog = clip(name, 80);
  const person = clip(personName ?? "", 80);
  const creator = clip(creatorName ?? "", 80);
  const job = clip(role ?? "", 120).replace(/[\s.!?…]+$/u, "");
  const hello = person ? `Hi ${person}, I'm ${dog}.` : `Hi, I'm ${dog}.`;
  const setUp = creator ? `${creator} set me up${job ? ` for ${job}` : ""}.` : job ? `I'm here for ${job}.` : "";
  return [hello, setUp, "What should I start on?"].filter(Boolean).join(" ");
}

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

const INHERITED_LEVELS = ["ask", "edits", "auto"] as const;

function inheritedLevel(mode: ApprovalMode | undefined): (typeof INHERITED_LEVELS)[number] {
  if (mode === "full") return "auto";
  return mode === "edits" || mode === "auto" ? mode : "ask";
}

export type DogAccessSource = Pick<BotRecord, "approvalMode" | "autoApprove" | "approvalGrant" | "composio" | "connectorTools"
  | "connectorScopes" | "outbound" | "mcpServers" | "toolScope" | "alwaysAllow" | "browser">;

export function dogMadeDogAccess(
  creator: DogAccessSource,
  creatorThreadMode: ApprovalMode,
  newDogMode: ApprovalMode | undefined,
  supported: (mode: ApprovalMode) => boolean,
): Partial<BotRecord> {
  const cap = Math.min(
    INHERITED_LEVELS.indexOf(inheritedLevel(approvalModeFor(creator))),
    INHERITED_LEVELS.indexOf(inheritedLevel(creatorThreadMode)),
    INHERITED_LEVELS.indexOf(inheritedLevel(newDogMode)),
  );
  const level = INHERITED_LEVELS[cap]!;
  const approvalMode = supported(level) ? level : "ask";
  const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));
  return {
    approvalMode,
    autoApprove: approvalMode === "auto",
    approvePeerComms: false,
    composio: creator.composio,
    connectorTools: copy(creator.connectorTools),
    connectorScopes: copy(creator.connectorScopes),
    outbound: copy(creator.outbound),
    mcpServers: copy(creator.mcpServers),
    toolScope: copy(creator.toolScope),
    alwaysAllow: copy(creator.alwaysAllow),
    browser: creator.browser,
  };
}
