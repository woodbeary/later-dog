import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import { MAC_RELAY_INSTANCE_ID } from "./mac-relay.ts";

export const MAC_RELAY_MIRRORS_FILE = "mac-relay-mirrors.json";

export const mirrorProfileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  title: z.string().max(200).optional(),
  description: z.string().max(4000).optional(),
  color: z.string().max(32).optional(),
}).strict();

export type MirrorProfile = z.infer<typeof mirrorProfileSchema>;

export interface MirrorBot {
  id: string;
  modelSelection: { instanceId: string };
}

export interface MacRelayMirrorDeps {
  file: string;
  bot(id: string): MirrorBot | undefined;
  create(profile: MirrorProfile): MirrorBot;
  update(id: string, profile: MirrorProfile): void;
}

export interface MacRelayMirrors {
  isRelayBot(botId: string): boolean;
  ensure(localBotId: string, profile: MirrorProfile): { botId: string; created: boolean };
}

function readMap(file: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

export function createMacRelayMirrors(deps: MacRelayMirrorDeps): MacRelayMirrors {
  const isRelayBot = (botId: string) => deps.bot(botId)?.modelSelection.instanceId === MAC_RELAY_INSTANCE_ID;
  return {
    isRelayBot,
    ensure(localBotId, profile) {
      const map = readMap(deps.file);
      const known = map[localBotId];
      if (known && isRelayBot(known)) {
        deps.update(known, profile);
        return { botId: known, created: false };
      }
      const bot = deps.create(profile);
      writeFileAtomic(deps.file, `${JSON.stringify({ ...map, [localBotId]: bot.id }, null, 2)}\n`);
      return { botId: bot.id, created: true };
    },
  };
}
