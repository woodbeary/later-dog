// Connectors at the top of the Apps pop-up: official MCP servers that sign in
// with OAuth (lib/mcp-connectors.ts), one row each with the brand's own mark
// (lib/brand-icons.ts, bundled; nothing is fetched). Each row reads its state
// from the configured MCP servers, so a server someone already added by hand
// shows as connected, and Connect reuses it instead of adding another.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2 } from "lucide-react";

import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import {
  MCP_CONNECTORS,
  connectMcpConnector,
  connectorServer,
  connectorState,
  disconnectMcpConnector,
  type ConnectResult,
  type McpConnector,
  type McpServerRow,
} from "@/lib/mcp-connectors";
import { updateMcpServers, useMcpServers } from "@/lib/mcp-servers";
import { completeMcpSignIn, mcpSignInLink, type McpSignInStatus } from "@/lib/mcp-sign-in";
import { api, useStore } from "@/state/store";

import { AddServerToBots } from "./AddServerToBots";
import { BrandIcon } from "./BrandIcon";

interface Active {
  id: string;
  /** the MCP server being signed in to, once known */
  server?: string;
  phase: "working" | "signing-in";
}

function failureMessage(result: Extract<ConnectResult, { outcome: "failed" }>, connector: McpConnector): string {
  if (result.reason === "not-added") return t("mcpConnectors.addFailed", { name: connector.name });
  if (result.reason === "tools") return t("mcpConnectors.testFailed", { name: connector.name });
  return result.message || t("mcpConnectors.signInFailed", { name: connector.name });
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function McpConnectorCards({ connectors, refreshKey = 0, onConnected, onServersChange }: {
  /** The connectors to show, already narrowed by the pop-up's search and chips. */
  connectors: readonly McpConnector[];
  refreshKey?: number;
  /** Ids of every catalog connector that is connected, when that changes. */
  onConnected?: (ids: string[]) => void;
  /** A card added, switched or signed out of a server. */
  onServersChange?: () => void;
}) {
  const { state: store } = useStore();
  const policy = store.config?.managedPolicy;
  // Enrolled with custom servers off and nothing approved: nothing can be added.
  const locked = Boolean(policy && !policy.mcp.allowCustom && !policy.mcp.allowlist.length);
  const [servers, setServers] = useState<McpServerRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flow, setFlow] = useState<McpSignInStatus | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const signInComplete = useRef<((result: McpSignInStatus) => void) | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The list "Your MCP servers" and dog Access settings share. Any change
  // published there (a removal, a sign-out) is re-read here.
  const shared = useMcpServers();
  const seenShared = useRef(shared.servers);

  const load = useCallback(() => {
    const started = ++generation.current;
    return api("/api/mcp/servers")
      .then((result) => {
        if (!mounted.current || started !== generation.current) return;
        setServers(result.servers ?? []);
        setLoadFailed(null);
      })
      .catch((cause) => {
        if (!mounted.current || started !== generation.current) return;
        setLoadFailed(messageOf(cause));
      });
  }, []);

  /** An answer from a mutation is newer than any read still in flight. */
  const applyServers = (list: McpServerRow[]) => {
    generation.current += 1;
    if (mounted.current) setServers(list);
    updateMcpServers(list);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      clearTimeout(reloadTimer.current);
      abort.current?.abort();
    };
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  useEffect(() => {
    if (seenShared.current === shared.servers) return;
    seenShared.current = shared.servers;
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => { if (mounted.current) void load(); }, 150);
  }, [shared.servers, load]);

  const connectedKey = servers === null
    ? null
    : MCP_CONNECTORS.filter((connector) => connectorState(connectorServer(connector, servers)) === "connected")
      .map((connector) => connector.id).join(",");
  useEffect(() => {
    if (connectedKey !== null) onConnected?.(connectedKey ? connectedKey.split(",") : []);
  }, [connectedKey, onConnected]);

  const clearError = (id: string) => setErrors((current) => {
    if (!(id in current)) return current;
    const next = { ...current };
    delete next[id];
    return next;
  });

  const connect = async (connector: McpConnector) => {
    if (servers === null || active !== null) return;
    const controller = new AbortController();
    abort.current = controller;
    setActive({ id: connector.id, phase: "working" });
    clearError(connector.id);
    setFlow(null);
    setCallbackUrl("");
    setCallbackError(null);
    setCompleting(false);
    let result: ConnectResult | undefined;
    try {
      result = await connectMcpConnector(connector, servers, {
        api,
        open: openExternalLink,
        signal: controller.signal,
        onServers: applyServers,
        onSignIn: (server, status, complete) => {
          if (abort.current !== controller) return;
          signInComplete.current = complete;
          setFlow(status);
          setActive({ id: connector.id, server, phase: "signing-in" });
        },
        // signed in: back to a spinner while its tools are checked
        onSignedIn: (server) => {
          if (abort.current !== controller) return;
          signInComplete.current = null;
          setFlow(null);
          setActive({ id: connector.id, server, phase: "working" });
        },
      });
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setErrors((current) => ({ ...current, [connector.id]: messageOf(cause) }));
    } finally {
      if (abort.current === controller) {
        abort.current = null;
        signInComplete.current = null;
        if (mounted.current) {
          setActive(null);
          setFlow(null);
          setCallbackUrl("");
          setCallbackError(null);
          setCompleting(false);
        }
      }
      onServersChange?.();
      if (mounted.current) void load();
    }
    if (result?.outcome === "failed" && mounted.current) {
      const message = failureMessage(result, connector);
      setErrors((current) => ({ ...current, [connector.id]: message }));
    }
  };

  const disconnect = async (connector: McpConnector, server: McpServerRow) => {
    if (active !== null) return;
    setActive({ id: connector.id, server: server.name, phase: "working" });
    clearError(connector.id);
    try {
      await disconnectMcpConnector(server, { api, onServers: applyServers });
    } catch (cause) {
      if (mounted.current) setErrors((current) => ({ ...current, [connector.id]: messageOf(cause) }));
    } finally {
      if (mounted.current) setActive(null);
      onServersChange?.();
      if (mounted.current) void load();
    }
  };

  /** Paste-back from another computer: the redirect URL goes in a JSON body. */
  const completeSignIn = async () => {
    const server = active?.server;
    const flowId = flow?.flowId;
    if (!server || !flowId || completing) return;
    const controller = abort.current;
    setCompleting(true);
    setCallbackError(null);
    try {
      const result = await completeMcpSignIn(server, flowId, callbackUrl, api);
      if (abort.current === controller) signInComplete.current?.(result);
    } catch (cause) {
      if (abort.current === controller) setCallbackError(messageOf(cause));
    } finally {
      if (abort.current === controller) setCompleting(false);
    }
  };

  // Connected ones lead, as connected apps do in the rest of the pop-up.
  const isConnected = (connector: McpConnector) => servers !== null && connectorState(connectorServer(connector, servers)) === "connected";
  const ordered = connectors
    .map((connector, index) => ({ connector, index }))
    .sort((a, b) => Number(isConnected(b.connector)) - Number(isConnected(a.connector)) || a.index - b.index)
    .map(({ connector }) => connector);

  // Still mounted with nothing to show: the effects above keep the pop-up's
  // count of connected apps current while a search hides every row.
  if (ordered.length === 0) return null;

  return (
    // Rows on the pop-up's own surface, no card around each; two columns once
    // the Apps section (the nearest @container) has room for both.
    <div data-connector-list className="mb-4 grid grid-cols-1 gap-x-8 @3xl:grid-cols-2">
      {ordered.map((connector) => {
        const server = servers ? connectorServer(connector, servers) : undefined;
        const state = connectorState(server);
        const busy = active?.id === connector.id;
        const signingIn = busy && active.phase === "signing-in";
        const error = errors[connector.id];
        const description = t(connector.description);
        const disabled = busy
          || (active !== null && !busy)
          || (servers === null && loadFailed === null)
          || state === "blocked"
          || (locked && state !== "connected");
        const label = servers === null
          ? t(loadFailed === null ? "connectors.action.checking" : "connectors.action.retry")
          : state === "connected"
            ? t("connectors.disconnect")
            : state === "needs-sign-in"
              ? t("mcp.auth.signIn")
              : t(error ? "connectors.action.retry" : "connectors.action.connect");
        const aria = servers === null
          ? undefined
          : state === "connected"
            ? t("mcpConnectors.disconnectAria", { name: connector.name })
            : state === "needs-sign-in"
              ? t("mcpConnectors.signInAria", { name: connector.name })
              : t("mcpConnectors.connectAria", { name: connector.name });
        return (
          <div key={connector.id} data-connector-tile={connector.id} className="flex min-w-0 items-start gap-3 py-2.5">
            {/* the name sits beside it, so the mark is not read out twice */}
            <BrandIcon brand={connector.id} name={connector.name} decorative />
            <div className="min-w-0 flex-1">
              <div className="flex min-h-10 items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[14px] font-medium text-ink">{connector.name}</span>
                    {state === "connected" ? (
                      <span className="flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-success">
                        <Check size={12} className="shrink-0" aria-hidden="true" /> {t("apps.connected")}
                      </span>
                    ) : state === "needs-sign-in" ? (
                      <span className="shrink-0 text-[11.5px] font-medium text-warning">{t("mcp.auth.needsSignIn")}</span>
                    ) : state === "blocked" && server?.managedBy ? (
                      <span className="min-w-0 truncate text-[11.5px] text-ink-secondary">{t("policy.managedBy", { organization: server.managedBy })}</span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-[12px] leading-snug text-ink-secondary" title={description}>{description}</p>
                </div>
                <a
                  href={connector.docs}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t("mcpConnectors.docsAria", { name: connector.name })}
                  title={t("mcpConnectors.docsAria", { name: connector.name })}
                  className="shrink-0 rounded-lg p-1.5 text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
                >
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
                {signingIn ? (
                  <button
                    type="button"
                    onClick={() => abort.current?.abort()}
                    aria-label={t("mcpConnectors.cancelAria", { name: connector.name })}
                    className="flex min-w-[80px] shrink-0 items-center justify-center gap-1.5 rounded-full bg-control px-3 py-1.5 text-[12px] text-ink transition-colors hover:bg-raised-hover"
                  >
                    {t("mcp.auth.cancel")}
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={aria}
                    disabled={disabled}
                    title={locked && policy ? t("policy.managedBy", { organization: policy.organizationName }) : undefined}
                    onClick={() => {
                      if (servers === null) void load();
                      else if (state === "connected" && server) void disconnect(connector, server);
                      else void connect(connector);
                    }}
                    className="flex min-w-[80px] shrink-0 items-center justify-center gap-1.5 rounded-full bg-control px-3 py-1.5 text-[12px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
                  >
                    {busy ? <Loader2 size={13} className="mx-auto animate-spin" aria-hidden="true" /> : label}
                  </button>
                )}
              </div>
              {/* limitations stay on the row, not behind a link */}
              {connector.note && <p className="mt-1 text-[11px] leading-snug text-ink-secondary">{t(connector.note)}</p>}
              {connector.transport === "sse" && <p className="mt-1 text-[11px] leading-snug text-ink-secondary">{t("mcpConnectors.sse")}</p>}
              {error && <p role="alert" className="mt-1.5 text-[12px] leading-relaxed text-danger">{error}</p>}
              {signingIn && (
                <div className="mt-2 space-y-2 rounded-lg bg-raised px-3 py-3 text-[12px] text-ink-secondary">
                  <div role="status" className="flex items-center gap-2">
                    <Loader2 size={13} className="animate-spin" aria-hidden="true" /> {t("mcp.auth.waiting")}
                  </div>
                  {flow?.authorizationUrl && mcpSignInLink(flow.authorizationUrl) && (
                    <button
                      type="button"
                      onClick={() => void openExternalLink(flow.authorizationUrl!).catch(() => setCallbackError(t("mcp.auth.openFailed")))}
                      className="text-accent hover:underline"
                    >
                      {t("mcp.auth.openAgain")}
                    </button>
                  )}
                  {flow?.flowId && (
                    <details>
                      <summary className="cursor-pointer font-medium text-ink">{t("mcp.auth.otherComputer")}</summary>
                      <p className="mt-2 leading-relaxed">{t("mcp.auth.otherComputerHint")}</p>
                      <label className="mt-3 block" htmlFor={`connector-callback-${connector.id}`}>{t("mcp.auth.callbackUrl")}</label>
                      <input
                        id={`connector-callback-${connector.id}`}
                        type="text"
                        value={callbackUrl}
                        disabled={completing}
                        onChange={(event) => setCallbackUrl(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="http://127.0.0.1:…/mcp-oauth/callback?…"
                        className="mt-1 w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-ink outline-none focus:border-accent"
                      />
                      <button
                        type="button"
                        disabled={!callbackUrl.trim() || completing}
                        aria-busy={completing}
                        onClick={() => void completeSignIn()}
                        className="mt-2 inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 font-medium text-white disabled:opacity-40"
                      >
                        {completing && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                        {t(completing ? "mcp.auth.completing" : "mcp.auth.complete")}
                      </button>
                    </details>
                  )}
                  {callbackError && <p role="alert" className="text-danger">{callbackError}</p>}
                </div>
              )}
              {state === "connected" && server && (
                <AddServerToBots server={server.name} className="mt-1.5 text-[11px] leading-relaxed text-ink-secondary" />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
