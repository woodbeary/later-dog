import { api, type Bot } from "@/state/store";
import { parseToolScope, type ToolScope } from "../../shared/tool-scope";

export function scopeAllowingServer(scope: unknown, server: string): ToolScope | null {
  const parsed = parseToolScope(scope);
  if (!parsed.ok || !parsed.scope) return null;
  const prefix = `mcp:${server}:`;
  const deny = parsed.scope.deny?.filter((selector) => !selector.startsWith(prefix)) ?? [];
  const allow = parsed.scope.allow && [...new Set([...parsed.scope.allow, `${prefix}*`])];
  if (!allow && !deny.length) return null;
  return { ...(allow ? { allow } : {}), ...(deny.length ? { deny } : {}) };
}

export async function allowComputer(bot: Pick<Bot, "id" | "toolScope">): Promise<void> {
  await api(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ toolScope: scopeAllowingServer(bot.toolScope, "computer") }),
  });
}
