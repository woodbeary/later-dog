import type { PackageDefinition } from "../../shared/package-format.ts";

export const DOG_SHARE_MISSING = "That dog no longer exists.";

export function dogShareKey(botId: string): string {
  return `dog:${botId}`;
}

export function sharedDog<T extends { id: string; hidden?: boolean; section?: string; chiefOfStaff?: boolean }>(
  bots: readonly T[],
  botId: string,
): T | null {
  const bot = bots.find((candidate) => candidate.id === botId && !candidate.hidden);
  return bot ? { ...bot, section: undefined, chiefOfStaff: false } : null;
}

export function packageIsOneDog(pkg: Pick<PackageDefinition, "agents" | "rooms" | "team"> | null | undefined): boolean {
  return Boolean(pkg) && pkg!.agents.length === 1 && !pkg!.rooms?.length && !pkg!.team?.brief;
}
