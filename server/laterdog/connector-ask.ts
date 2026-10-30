import type { ConnectorCall } from "../../shared/outbound.ts";

const CONNECTOR_ALLOW_PREFIX = "connector:";
const OPAQUE_CALL = "COMPOSIO_PROXY_EXECUTE";

export function connectorAllowKey(toolkit: string): string {
  return CONNECTOR_ALLOW_PREFIX + toolkit;
}

export function toolkitOf(slug: string, connected: readonly string[] = []): string | null {
  if (slug === OPAQUE_CALL) return null;
  const longest = connected
    .filter((candidate) => slug.toUpperCase().startsWith(candidate.toUpperCase() + "_"))
    .sort((a, b) => b.length - a.length)[0];
  if (longest) return longest.toLowerCase();
  const cut = slug.indexOf("_");
  return (cut > 0 ? slug.slice(0, cut) : slug).toLowerCase();
}

export function askedConnector(calls: readonly ConnectorCall[], connected: readonly string[] = []): string | null {
  const toolkits = new Set(calls.map((call) => toolkitOf(call.slug, connected)));
  if (toolkits.size !== 1) return null;
  const [toolkit] = toolkits;
  return toolkit ?? null;
}

export function connectorAlwaysAllowed(alwaysAllow: readonly string[] | undefined, toolkit: string | null): boolean {
  return toolkit !== null && (alwaysAllow ?? []).includes(connectorAllowKey(toolkit));
}

export type ConnectorSendDecision =
  | { kind: "send"; rule: "owner-auto" | "always-allow" | "this-turn" }
  | { kind: "skipped"; toolkit: string }
  | { kind: "ask"; toolkit: string | null };

export function connectorSendDecision(input: {
  calls: readonly ConnectorCall[];
  connected: readonly string[];
  alwaysAllow: readonly string[] | undefined;
  ownerSends: boolean;
  skipped: (toolkit: string) => boolean;
  allowedThisTurn: (toolkit: string) => boolean;
}): ConnectorSendDecision {
  const opaque = input.calls.some((call) => call.slug === OPAQUE_CALL);
  const toolkit = askedConnector(input.calls, input.connected);
  if (!opaque) {
    const skippedToolkit = input.calls
      .map((call) => toolkitOf(call.slug, input.connected))
      .find((candidate): candidate is string => candidate !== null && input.skipped(candidate));
    if (skippedToolkit) return { kind: "skipped", toolkit: skippedToolkit };
    if (input.ownerSends) return { kind: "send", rule: "owner-auto" };
    if (connectorAlwaysAllowed(input.alwaysAllow, toolkit)) return { kind: "send", rule: "always-allow" };
    if (toolkit !== null && input.allowedThisTurn(toolkit)) return { kind: "send", rule: "this-turn" };
  }
  return { kind: "ask", toolkit };
}

export class TurnToolkits {
  private readonly byThread = new Map<string, { generation: string; toolkits: Set<string> }>();

  add(threadId: string, generation: string, toolkits: Iterable<string>): void {
    const current = this.byThread.get(threadId);
    const entry = current?.generation === generation ? current : { generation, toolkits: new Set<string>() };
    for (const toolkit of toolkits) entry.toolkits.add(toolkit);
    this.byThread.set(threadId, entry);
  }

  has(threadId: string, generation: string, toolkit: string): boolean {
    const entry = this.byThread.get(threadId);
    if (!entry) return false;
    if (entry.generation !== generation) {
      this.byThread.delete(threadId);
      return false;
    }
    return entry.toolkits.has(toolkit);
  }
}
