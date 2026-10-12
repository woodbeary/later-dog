import { t } from "@/lib/i18n";
import type { OptionCardData } from "@/state/store";

export interface OutboundCall {
  app: string | null;
  label: string;
}

const SUMMARY_GROUPS = 3;

export function parseOutboundCalls(subtitle: string): OutboundCall[] {
  const calls: OutboundCall[] = [];
  for (const block of subtitle.split("\n\n")) {
    const heading = (block.split("\n")[0] ?? "").trim();
    if (!heading) return [];
    const at = heading.indexOf(" · ");
    if (at < 0) {
      calls.push({ app: null, label: heading });
      continue;
    }
    const app = heading.slice(0, at).trim();
    const label = heading.slice(at + " · ".length).trim();
    if (!app || !label) return [];
    calls.push({ app, label });
  }
  return calls;
}

export function outboundCalls(card: Pick<OptionCardData, "outboundRequest" | "subtitle">): OutboundCall[] {
  if (!card.outboundRequest) return [];
  const calls = card.outboundRequest.calls;
  if (calls && calls.length > 0) return calls;
  return parseOutboundCalls(card.subtitle);
}

export function outboundApp(calls: OutboundCall[]): string | null {
  if (calls.length === 0 || calls.some((call) => !call.app)) return null;
  const apps = new Set(calls.map((call) => call.app));
  return apps.size === 1 ? calls[0]!.app : null;
}

export function collapseOutboundCalls(calls: OutboundCall[], namingApps: boolean): string {
  const order: OutboundCall[] = [];
  const counts = new Map<string, number>();
  for (const call of calls) {
    const key = JSON.stringify([call.app, call.label]);
    if (!counts.has(key)) order.push(call);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = order.slice(0, SUMMARY_GROUPS).map((call) => {
    const name = namingApps && call.app ? `${call.app} · ${call.label}` : call.label;
    const count = counts.get(JSON.stringify([call.app, call.label])) ?? 1;
    return count > 1 ? `${name} ×${count}` : name;
  });
  const line = parts.join(", ");
  const hidden = order.length - parts.length;
  return hidden > 0 ? `${line}, ${t("approval.outbound.more", { count: hidden })}` : line;
}

export interface OutboundSummary {
  headline: string;
  summary: string;
}

export function outboundSummary(card: Pick<OptionCardData, "outboundRequest" | "subtitle">): OutboundSummary | undefined {
  if (!card.outboundRequest) return undefined;
  const calls = outboundCalls(card);
  const app = outboundApp(calls);
  return {
    headline: app ? t("approval.outbound.sendTo", { app }) : t("approval.outbound.sendOnBehalf"),
    summary: collapseOutboundCalls(calls, app === null),
  };
}

const COMPOSIO_TOOL = /^[A-Z][A-Z0-9]+_([A-Z0-9_]+)$/;

export function composioActionPhrase(tool: string): string | undefined {
  const match = COMPOSIO_TOOL.exec(tool);
  if (!match) return undefined;
  return match[1]!.replace(/_+/g, " ").trim().toLowerCase() || undefined;
}

const OWN_SERVERS = new Set(["agents", "computer", "laterdog", "browser", "dog", "shell", "team-notes", "memory"]);

export function toolService(tool: string): string | undefined {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool.trim());
  if (!mcp || OWN_SERVERS.has(mcp[1]!)) return undefined;
  const raw = mcp[1] === "composio" ? mcp[2]!.split("_", 1)[0]! : mcp[1]!.replace(/^claude_ai_/, "");
  const words = raw.replace(/[-_]+/g, " ").trim();
  if (!words) return undefined;
  return words.split(" ").map((word) => (word === word.toUpperCase() ? word[0]! + word.slice(1).toLowerCase() : word[0]!.toUpperCase() + word.slice(1))).join(" ");
}

export function usesComputer(tool: string): boolean {
  const name = tool.trim();
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return /^(computer|browser)$/.test(mcp[1]!) || /^(computer|browser|screenshot|click)/.test(mcp[2]!);
  return /^(computer|browser)_/.test(name);
}
