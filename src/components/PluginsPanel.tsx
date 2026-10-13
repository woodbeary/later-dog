import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, RefreshCw, Search, TriangleAlert, X } from "lucide-react";
import { api, useStore, type Bot, type InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";
import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { readCachedInventory, writeCachedInventory } from "@/lib/connected-apps-cache";
import { reserveConnectionPage, reusableConnectionUrl, type PendingAuthorization } from "@/lib/connector-oauth";
import { mcpSignInLink } from "@/lib/mcp-sign-in";
import { managedConnectorUnavailableReason } from "../../shared/connector-availability";
import { connectorServiceAccess, isConnectorToolGrantShape } from "@/lib/connector-grants";
import { MCP_CONNECTOR_CATEGORIES, MCP_CONNECTORS, connectorMatchesSearch, type McpConnectorCategory } from "@/lib/mcp-connectors";
import { ComposioKeyNotice } from "./ApiKeys";
import { BotAvatar } from "./Avatar";
import { McpConnectorCards } from "./McpConnectorCards";
import { McpServersPanel } from "./McpServersPanel";
import { useMenuMotion } from "./MenuMotion";

export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  noAuth?: boolean;
  domain: string | null;
}

export interface ConnectorStatus {
  connected: boolean;
  pending?: boolean;
  status?: string;
  accounts?: Array<{
    id: string;
    alias?: string;
    status: string;
  }>;
}

let cachedConnectorStatus: Record<string, ConnectorStatus> | null = null;
let cachedConnectorStatusAt = 0;
let cachedConnectorStatusAuthoritative = true;
let connectorStatusRequest: Promise<ConnectorInventory> | null = null;
const CONNECTOR_STATUS_CACHE_MS = 30_000;

export interface ConnectorInventory {
  services: Record<string, ConnectorStatus>;
  authoritative: boolean;
}

export function preloadConnectedApps(force = false): Promise<ConnectorInventory> {
  if (!force && cachedConnectorStatus !== null && Date.now() - cachedConnectorStatusAt < CONNECTOR_STATUS_CACHE_MS) {
    return Promise.resolve({
      services: cachedConnectorStatus,
      authoritative: cachedConnectorStatusAuthoritative,
    });
  }
  if (connectorStatusRequest) return connectorStatusRequest;
  connectorStatusRequest = api("/api/connectors/connected")
    .then((response) => {
      const services: Record<string, ConnectorStatus> = response.services ?? {};
      if (response.credentialStore === "unavailable") {
        return { services: readCachedInventory()?.services ?? {}, authoritative: false };
      }
      cachedConnectorStatus = services;
      cachedConnectorStatusAt = Date.now();
      cachedConnectorStatusAuthoritative = true;
      writeCachedInventory(services, Date.now());
      return { services, authoritative: true };
    })
    .catch(() => ({ services: readCachedInventory()?.services ?? {}, authoritative: false }))
    .finally(() => {
      connectorStatusRequest = null;
    });
  return connectorStatusRequest;
}

export function disconnectAccountConfirmation(
  service: string,
  account: { id: string; alias?: string },
) {
  const identity = account.alias ? `“${account.alias}” (${account.id})` : `“${account.id}”`;
  return t("connectors.disconnectConfirm", { identity, service });
}

export function botsMissingConnectedApps(bots: Bot[], instances: InstanceInfo[]): Bot[] {
  return bots.filter((bot) =>
    !bot.hidden &&
    bot.composio === false &&
    instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)
      ?.capabilities?.composioMcp === true);
}

export function botsWithLimitedServiceTools(bots: Bot[], instances: InstanceInfo[], slug: string): Bot[] {
  return bots.filter((bot) => {
    if (bot.hidden || bot.composio === false) return false;
    if (!instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)
      ?.capabilities?.composioMcp) return false;
    const record: unknown = bot.connectorTools;
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    const grant = (record as Record<string, unknown>)[slug];
    if (grant === undefined) return true;
    return !isConnectorToolGrantShape(grant) || grant.tools !== "*";
  });
}

export function hasUsableConnectedApps(configured: boolean, phase: ConnectorInventoryPhase, stale: boolean, status: Record<string, ConnectorStatus>): boolean {
  return configured && phase === "ready" && !stale && Object.values(status).some((service) => service.connected);
}

export type ConnectorSetup = "ready" | "needs-setup" | "service-unavailable";

export function connectorSetupNotice(state: {
  configured: boolean;
  stale: boolean;
  setup: ConnectorSetup | undefined;
  remoteClient: boolean;
}): { key: LocaleKey; tone: "info" | "warning" } | null {
  if (state.configured || state.stale) return null;
  if (state.setup === "needs-setup") {
    return { key: state.remoteClient ? "connectors.setupNeededRemote" : "connectors.setupNeeded", tone: "info" };
  }
  return { key: "connectors.notConfigured", tone: "warning" };
}

export function requiresAccountAlias(message: string) {
  return /account alias.*existing connection.*not replaced/i.test(message);
}

export type ConnectorInventoryPhase = "loading" | "ready" | "error";

export function connectorActionLabel(
  phase: ConnectorInventoryPhase,
  state: { busy: boolean; included: boolean; canContinue: boolean; pending?: boolean; hasAccounts: boolean; failed: boolean },
) {
  if (state.busy) return null;
  if (state.included) return t("connectors.action.included");
  if (phase === "loading") return t("connectors.action.checking");
  if (phase === "error") return t("connectors.action.unavailable");
  if (state.canContinue) return t("connectors.action.continue");
  if (state.pending) return t("connectors.action.checkStatus");
  if (state.hasAccounts) return t("connectors.action.addAccount");
  if (state.failed) return t("connectors.action.retry");
  return t("connectors.action.connect");
}

export function connectedInventoryCopy(phase: ConnectorInventoryPhase) {
  if (phase === "loading") return {
    title: t("connectors.empty.loadingTitle"),
    description: t("connectors.empty.loadingDesc"),
  };
  if (phase === "error") return {
    title: t("connectors.empty.errorTitle"),
    description: t("connectors.empty.errorDesc"),
  };
  return {
    title: t("connectors.empty.noneTitle"),
    description: t("connectors.empty.noneHint"),
  };
}

export function mergeCurrentConnectorStatus(
  current: Record<string, ConnectorStatus>,
  incoming: Record<string, ConnectorStatus>,
  latestGenerations: ReadonlyMap<string, number>,
  requestGenerations: ReadonlyMap<string, number>,
) {
  const next = { ...current };
  for (const [slug, state] of Object.entries(incoming)) {
    if ((latestGenerations.get(slug) ?? 0) !== (requestGenerations.get(slug) ?? 0)) continue;
    next[slug] = state;
  }
  return next;
}

export function mergeCompleteConnectorStatus(
  current: Record<string, ConnectorStatus>,
  incoming: Record<string, ConnectorStatus>,
  latestGenerations: ReadonlyMap<string, number>,
  requestGenerations: ReadonlyMap<string, number>,
  authoritative = true,
) {
  const next = { ...current };
  if (!authoritative) return mergeCurrentConnectorStatus(next, incoming, latestGenerations, requestGenerations);
  for (const [slug, state] of Object.entries(current)) {
    if (incoming[slug]) continue;
    if (!state.connected && !state.accounts?.length) continue;
    if ((latestGenerations.get(slug) ?? 0) !== (requestGenerations.get(slug) ?? 0)) continue;
    next[slug] = { connected: false, pending: false, status: "not_connected", accounts: [] };
  }
  return mergeCurrentConnectorStatus(next, incoming, latestGenerations, requestGenerations);
}

export function onlyLatestConnectorResponses(
  incoming: Record<string, ConnectorStatus>,
  latestRequests: ReadonlyMap<string, number>,
  requestIds: ReadonlyMap<string, number>,
) {
  return Object.fromEntries(
    Object.entries(incoming).filter(
      ([slug]) => (latestRequests.get(slug) ?? 0) === (requestIds.get(slug) ?? 0),
    ),
  );
}

export function ServiceIcon({ card, className = "size-11" }: { card: Pick<ToolkitCard, "logo" | "domain" | "label">; className?: string }) {
  const [stage, setStage] = useState(card.logo ? 0 : card.domain ? 1 : 2);
  if (stage === 0 && card.logo) {
    return (
      <img
        src={card.logo}
        alt=""
        loading="lazy"
        className={cn("rounded-xl object-contain", className)}
        onError={() => setStage(1)}
      />
    );
  }
  if (stage === 1 && card.domain) {
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${card.domain}&sz=64`}
        alt=""
        loading="lazy"
        className={cn("rounded-xl object-contain", className)}
        onError={() => setStage(2)}
      />
    );
  }
  return (
    <div className={cn("flex items-center justify-center rounded-xl bg-raised text-[15px] font-semibold text-ink-secondary", className)}>
      {card.label.slice(0, 1).toUpperCase()}
    </div>
  );
}

export interface CatalogPagination {
  items: number;
  totalItems?: number;
  stalled: boolean;
  reason?: string;
}

export type AppsFilter = "all" | "connected" | "mcp";

export const APPS_PREVIEW_COUNT = 48;

export const APPS_GROUP_PREVIEW_COUNT = 4;

export const APPS_FEATURED_CATEGORIES: readonly McpConnectorCategory[] = ["projects", "email", "design", "code"];

const MORE_CATEGORIES = (Object.keys(MCP_CONNECTOR_CATEGORIES) as McpConnectorCategory[])
  .filter((category) => !APPS_FEATURED_CATEGORIES.includes(category));

const MORE_MENU_MAX = 560;

const chipClass = (active: boolean) => cn(
  "rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-colors",
  active ? "bg-accent text-accent-ink" : "bg-control/70 text-ink-secondary hover:bg-control-hover hover:text-ink",
);

export const USED_BY_AVATAR_SIZE = 16;

export function botsUsingService(bots: Bot[], instances: InstanceInfo[], slug: string): Bot[] {
  return bots.filter((bot) =>
    !bot.hidden &&
    bot.composio !== false &&
    instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)
      ?.capabilities?.composioMcp === true &&
    connectorServiceAccess(bot.connectorTools, slug).level !== "none");
}

export function PluginsPanel() {
  const { state, dispatch } = useStore();
  const remoteClient = window.laterdog?.remoteClient?.active === true;
  const dialogRef = useRef<HTMLDivElement>(null);
  const surface = state.pluginsSurface;
  const [cards, setCards] = useState<ToolkitCard[] | null>(null);
  const [source, setSource] = useState<"api" | "curated">("curated");
  const [pagination, setPagination] = useState<CatalogPagination | null>(null);
  const [configured, setConfigured] = useState(false);
  const [catalogRead, readCatalogAgain] = useReducer((read: number) => read + 1, 0);
  const [mode, setMode] = useState<"managed" | "self-hosted" | "unavailable">("unavailable");
  const [setup, setSetup] = useState<ConnectorSetup | undefined>(undefined);
  const [status, setStatus] = useState<Record<string, ConnectorStatus>>(
    () => cachedConnectorStatus ?? readCachedInventory()?.services ?? {},
  );
  const [stale, setStale] = useState(
    cachedConnectorStatus !== null && !cachedConnectorStatusAuthoritative,
  );
  const [pendingUrls, setPendingUrls] = useState<Record<string, PendingAuthorization>>({});
  const [aliasSlug, setAliasSlug] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [inventoryPhase, setInventoryPhase] = useState<ConnectorInventoryPhase>(
    cachedConnectorStatus === null ? "loading" : "ready",
  );
  const [error, setError] = useState<string | { key: LocaleKey } | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"marketplace" | "connected">("marketplace");
  const [showAllApps, setShowAllApps] = useState(false);
  const [whopConnected, setWhopConnected] = useState<boolean | null>(null);
  const [whopRefresh, setWhopRefresh] = useState(0);
  const [connectedConnectors, setConnectedConnectors] = useState<string[]>([]);
  const [category, setCategory] = useState<McpConnectorCategory | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreRoom, setMoreRoom] = useState(MORE_MENU_MAX);
  const moreMotion = useMenuMotion(moreOpen);

  const pollTimers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const statusGenerations = useRef(new Map<string, number>());
  const latestStatusRequests = useRef(new Map<string, number>());
  const opening = useRef<ReturnType<typeof reserveConnectionPage> | null>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback((slugs: string[]): Promise<Record<string, ConnectorStatus>> => {
    if (!slugs.length) return Promise.resolve({});
    const requestGenerations = new Map(slugs.map((slug) => [slug, statusGenerations.current.get(slug) ?? 0]));
    const requestIds = new Map(slugs.map((slug) => {
      const requestId = (latestStatusRequests.current.get(slug) ?? 0) + 1;
      latestStatusRequests.current.set(slug, requestId);
      return [slug, requestId];
    }));
    return api(`/api/connectors?services=${slugs.join(",")}`)
      .then((r) => {
        const services = onlyLatestConnectorResponses(
          r.services ?? {},
          latestStatusRequests.current,
          requestIds,
        );
        setStatus((current) => mergeCurrentConnectorStatus(
          current,
          services,
          statusGenerations.current,
          requestGenerations,
        ));
        for (const [slug, state] of Object.entries(services)) {
          const isCurrent = (statusGenerations.current.get(slug) ?? 0) === (requestGenerations.get(slug) ?? 0);
          if (isCurrent && ((state.connected && !state.pending) || /^(expired|failed)$/i.test(state.status ?? ""))) setPendingUrls((current) => {
            if (!current[slug]) return current;
            const next = { ...current };
            delete next[slug];
            return next;
          });
        }
        return services;
      })
      .catch(() => ({}));
  }, []);

  const refreshConnectedStatus = useCallback((force = false): Promise<Record<string, ConnectorStatus>> => {
    const requestGenerations = new Map(statusGenerations.current);
    setRefreshing(true);
    return preloadConnectedApps(force)
      .then(({ services, authoritative }) => {
        setStale(!authoritative);
        setStatus((current) => mergeCompleteConnectorStatus(
          current,
          services,
          statusGenerations.current,
          requestGenerations,
          authoritative,
        ));
        for (const [slug, state] of Object.entries(services)) {
          const isCurrent = (statusGenerations.current.get(slug) ?? 0) === (requestGenerations.get(slug) ?? 0);
          if (isCurrent && ((state.connected && !state.pending) || /^(expired|failed)$/i.test(state.status ?? ""))) setPendingUrls((current) => {
            if (!current[slug]) return current;
            const next = { ...current };
            delete next[slug];
            return next;
          });
        }
        return services;
      })
      .finally(() => setRefreshing(false));
  }, []);

  const loadConnectionInventory = useCallback((force = false) => {
    const hadCachedInventory = cachedConnectorStatus !== null;
    if (!hadCachedInventory) setInventoryPhase("loading");
    setError(null);
    return refreshConnectedStatus(force)
      .then((services) => {
        setInventoryPhase("ready");
        return services;
      })
      .catch((cause) => {
        if (!hadCachedInventory) setInventoryPhase("error");
        setError(cause instanceof Error ? cause.message : String(cause));
        return {};
      });
  }, [refreshConnectedStatus]);

  useEffect(() => () => {
    opening.current?.cancel();
    opening.current = null;
    for (const timer of pollTimers.current.values()) clearInterval(timer);
    pollTimers.current.clear();
  }, []);

  useEffect(() => {
    if (inventoryPhase !== "ready") return;
    cachedConnectorStatus = status;
    cachedConnectorStatusAt = Date.now();
    cachedConnectorStatusAuthoritative = !stale;
  }, [inventoryPhase, stale, status]);

  useEffect(() => {
    let alive = true;
    void loadConnectionInventory();
    api("/api/connectors/catalog")
      .then((r) => {
        if (!alive) return;
        setCards(r.cards ?? []);
        setSource(r.source ?? "curated");
        setPagination(r.pagination ?? null);
        setConfigured(Boolean(r.configured));
        setMode(r.mode ?? "unavailable");
        setSetup(r.setup);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [loadConnectionInventory, catalogRead]);

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);

    const controls = focusable();
    (controls.find((element) => element.matches("input")) ?? controls[0] ?? dialog)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "togglePlugins", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1)!;
      if (!items.some((element) => element === document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      returnFocus?.focus();
    };
  }, [dispatch]);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !moreRef.current?.contains(event.target)) setMoreOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [moreOpen]);

  const openConnectUrl = async (url: string) => {
    if (opening.current) return;
    const launch = reserveConnectionPage();
    opening.current = launch;
    try {
      if (!await launch.open(url) && opening.current === launch) {
        setError({ key: "connectors.popupBlockedContinue" });
      }
    } finally {
      launch.cancel();
      if (opening.current === launch) opening.current = null;
    }
  };

  const startPolling = (slug: string) => {
    const old = pollTimers.current.get(slug);
    if (old) clearInterval(old);
    let tries = 0;
    const timer = setInterval(() => {
      void refreshStatus([slug]).then((services) => {
        const state = services[slug];
        if (++tries >= 24 || (state?.connected && !state.pending) || (state?.status && /^(expired|failed)$/i.test(state.status))) {
          clearInterval(timer);
          pollTimers.current.delete(slug);
        }
      });
    }, 5000);
    pollTimers.current.set(slug, timer);
  };

  const connect = async (slug: string, alias?: string) => {
    if (busySlug || opening.current) return;
    const launch = reserveConnectionPage();
    opening.current = launch;
    statusGenerations.current.set(slug, (statusGenerations.current.get(slug) ?? 0) + 1);
    setBusySlug(slug);
    setError(null);
    try {
      const createdAt = Date.now();
      const request: RequestInit = { method: "POST" };
      if (alias) request.body = JSON.stringify({ alias });
      const result = await api(`/api/connectors/${slug}/authorize`, request);
      if (opening.current !== launch) return;
      const url = mcpSignInLink(typeof result.url === "string" ? result.url : null);
      if (!url) throw new Error(t("connectors.invalidAuthorizationUrl"));
      setPendingUrls((current) => ({ ...current, [slug]: { url, createdAt } }));
      setStatus((current) => ({
        ...current,
        [slug]: {
          ...current[slug],
          connected: current[slug]?.connected ?? false,
          pending: true,
          status: "INITIATED",
        },
      }));
      setAliasSlug(null);
      setAliasDraft("");
      startPolling(slug);
      if (!await launch.open(url) && opening.current === launch) {
        setError({ key: "connectors.popupBlockedContinue" });
      }
    } catch (e) {
      if (opening.current !== launch) return;
      const message = e instanceof Error ? e.message : String(e);
      if (requiresAccountAlias(message)) {
        setAliasSlug(slug);
        setAliasDraft("");
        setError({ key: "connectors.aliasNeeded" });
        void refreshStatus([slug]);
      } else {
        setError(message);
      }
    } finally {
      launch.cancel();
      if (opening.current === launch) {
        opening.current = null;
        setBusySlug(null);
      }
    }
  };

  const disconnectAccount = (slug: string, accountId: string) => {
    setBusySlug(slug);
    api(`/api/connectors/${slug}/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" })
      .then(() => refreshStatus([slug]))
      .catch((e) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  const isConnected = (slug: string) => Boolean(status[slug]?.connected || status[slug]?.accounts?.length);
  const matching = (cards ?? []).filter(
    (c) => (!search || `${c.label} ${c.slug} ${c.blurb}`.toLowerCase().includes(search.toLowerCase()))
      && (isConnected(c.slug) || !MCP_CONNECTORS.some((connector) => connector.id === c.slug)),
  );
  const filter: AppsFilter = surface === "mcp" ? "mcp" : tab === "connected" ? "connected" : "all";
  const whopMatches = !search || `whop ${t("whop.description")}`.toLowerCase().includes(search.toLowerCase().trim());
  const browsing = filter === "all" ? category : null;
  const showWhop = whopMatches && (filter === "all"
    ? browsing === null || browsing === "payments"
    : filter === "connected" && whopConnected !== false);
  const connectorMatches = MCP_CONNECTORS.filter((connector) => connectorMatchesSearch(connector, search));
  const shownConnectors = filter === "connected"
    ? connectorMatches.filter((connector) => connectedConnectors.includes(connector.id))
    : browsing
      ? connectorMatches.filter((connector) => connector.category === browsing)
      : connectorMatches;
  const grouped = filter === "all" && browsing === null && !search;
  const visible = (filter === "connected" ? matching.filter((card) => isConnected(card.slug)) : matching.filter((card) => configured || isConnected(card.slug)))
    .map((card, index) => ({ card, index }))
    .sort((a, b) => Number(isConnected(b.card.slug)) - Number(isConnected(a.card.slug)) || a.index - b.index)
    .map(({ card }) => card);
  const needKey = !configured && matching.some((card) => !isConnected(card.slug));
  const listed = browsing === null ? visible : [];
  const capped = filter === "all" && browsing === null && !search && !showAllApps && visible.length > APPS_PREVIEW_COUNT;
  const shown = capped ? visible.slice(0, APPS_PREVIEW_COUNT) : listed;
  const connectedCount = Object.values(status).filter((service) => service.connected || service.accounts?.length).length + Number(whopConnected === true)
    + connectedConnectors.length;
  const connectedEmptyCopy = connectedInventoryCopy(inventoryPhase);
  const close = () => dispatch({ type: "togglePlugins", open: false });
  const setupNotice = connectorSetupNotice({ configured, stale, setup, remoteClient });
  const botsWithoutApps = hasUsableConnectedApps(configured, inventoryPhase, stale, status)
    ? botsMissingConnectedApps(state.bots, state.instances)
    : [];
  const chooseFilter = (next: AppsFilter) => {
    setCategory(null);
    setMoreOpen(false);
    if (next === "mcp") {
      dispatch({ type: "togglePlugins", open: true, surface: "mcp" });
      return;
    }
    setTab(next === "connected" ? "connected" : "marketplace");
    if (surface !== "apps") dispatch({ type: "togglePlugins", open: true, surface: "apps" });
  };
  const chooseCategory = (next: McpConnectorCategory) => {
    setCategory(next);
    setTab("marketplace");
    setMoreOpen(false);
    if (surface !== "apps") dispatch({ type: "togglePlugins", open: true, surface: "apps" });
    bodyRef.current?.scrollTo({ top: 0 });
  };
  const viewAll = (next: McpConnectorCategory) => {
    chooseCategory(next);
    chipsRef.current?.querySelector<HTMLElement>(`[data-apps-filter="${APPS_FEATURED_CATEGORIES.includes(next) ? next : "more"}"]`)?.focus();
  };
  const chips: Array<{ id: string; label: string; active: boolean; choose: () => void }> = [
    { id: "all", label: t("apps.filter.all"), active: filter === "all" && browsing === null, choose: () => chooseFilter("all") },
    {
      id: "connected",
      label: `${t("apps.filter.connected")}${connectedCount > 0 ? ` ${connectedCount}` : ""}`,
      active: filter === "connected",
      choose: () => chooseFilter("connected"),
    },
    ...APPS_FEATURED_CATEGORIES.map((key) => ({
      id: key,
      label: t(MCP_CONNECTOR_CATEGORIES[key]),
      active: browsing === key,
      choose: () => chooseCategory(key),
    })),
  ];
  const custom = { id: "mcp", label: t("apps.filter.custom"), active: filter === "mcp", choose: () => chooseFilter("mcp") };
  const moreLabel = browsing !== null && !APPS_FEATURED_CATEGORIES.includes(browsing) ? t(MCP_CONNECTOR_CATEGORIES[browsing]) : null;
  const renderChip = (item: { id: string; label: string; active: boolean; choose: () => void }) => (
    <button
      key={item.id}
      type="button"
      data-apps-filter={item.id}
      aria-pressed={item.active}
      onClick={item.choose}
      className={chipClass(item.active)}
    >
      {item.label}
    </button>
  );

  return (
    <div
      className="glass-popup-frame"
      style={glassPopupFrameStyle()}
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
      <div
        ref={dialogRef}
        data-tour="apps-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugins-title"
        tabIndex={-1}
        className="glass-surface glass-popup animate-pop-in relative flex flex-col overflow-hidden rounded-[24px]"
      >
        <header className="flex flex-col gap-4 px-6 pb-3 pt-6 sm:px-8 sm:pt-7">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id="plugins-title" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">{t("apps.title")}</h2>
              <p className="mt-1 text-[13px] text-ink-secondary">{t("apps.subtitleShort")}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <label className="hidden h-10 w-[260px] items-center gap-2.5 rounded-xl bg-control/70 px-3.5 md:flex">
                <Search size={16} className="shrink-0 text-ink-secondary" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("connectors.searchPlaceholder")}
                  aria-label={t("connectors.searchPlaceholder")}
                  className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
                />
              </label>
              <button
                onClick={() => { setWhopRefresh((value) => value + 1); void loadConnectionInventory(true); }}
                disabled={refreshing}
                className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                title={t("connectors.refreshTitle")}
                aria-label={t("connectors.refreshTitle")}
              >
                <RefreshCw size={17} className={cn(refreshing && "animate-spin")} />
              </button>
              <button data-tour="apps-close"
                onClick={close}
                aria-label={t("connectors.closeAria")}
                className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <X size={21} />
              </button>
            </div>
          </div>
          <label className="flex h-10 w-full items-center gap-2.5 rounded-xl bg-control/70 px-3.5 md:hidden">
            <Search size={16} className="shrink-0 text-ink-secondary" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("connectors.searchPlaceholder")}
              aria-label={t("connectors.searchPlaceholder")}
              className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </label>
          <div ref={chipsRef} className="flex flex-wrap gap-2" role="group" aria-label={t("apps.filter.aria")}>
            {chips.map(renderChip)}
            <div
              ref={moreRef}
              className="relative"
              onKeyDown={(event) => {
                if (event.key !== "Escape" || !moreOpen) return;
                event.stopPropagation();
                setMoreOpen(false);
                moreButton.current?.focus();
              }}
            >
              <button
                ref={moreButton}
                type="button"
                data-apps-filter="more"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => {
                  const pane = moreButton.current?.closest(".glass-popup")?.getBoundingClientRect();
                  const chip = moreButton.current?.getBoundingClientRect();
                  if (pane && chip) setMoreRoom(Math.max(160, Math.min(MORE_MENU_MAX, pane.bottom - chip.bottom - 18)));
                  setMoreOpen((open) => !open);
                }}
                className={cn(chipClass(moreLabel !== null), "flex items-center gap-1")}
              >
                {moreLabel ?? t("apps.filter.more")}
                <ChevronDown size={13} aria-hidden="true" className={cn("shrink-0 transition-transform", moreOpen && "rotate-180")} />
              </button>
              {moreMotion.shown && (
                <div
                  role="menu"
                  aria-label={t("apps.filter.moreAria")}
                  className={cn(
                    "absolute left-0 top-full z-40 mt-1.5 w-[232px] overflow-y-auto overscroll-contain rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/50",
                    moreMotion.className,
                  )}
                  style={{ maxHeight: moreRoom }}
                  {...moreMotion.exitProps}
                >
                  {MORE_CATEGORIES.map((key) => (
                    <button
                      key={key}
                      type="button"
                      role="menuitemradio"
                      aria-checked={browsing === key}
                      data-apps-category={key}
                      onClick={() => {
                        chooseCategory(key);
                        moreButton.current?.focus();
                      }}
                      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-raised/70"
                    >
                      <span className="min-w-0 flex-1 truncate">{t(MCP_CONNECTOR_CATEGORIES[key])}</span>
                      {browsing === key && <Check size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {renderChip(custom)}
          </div>
        </header>

        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-2 sm:px-8">
          {stale && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
              <TriangleAlert size={14} className="mt-px shrink-0" />
              <span>
                {t("connectors.stale")}
              </span>
            </div>
          )}
          {setupNotice?.tone === "warning" && filter !== "mcp" && (
            <div className="mb-2 rounded-xl bg-warning/10 px-4 py-3 text-[13px] text-warning">
              {t(whopConnected ? "whop.otherAppsSetup" : setupNotice.key)}
            </div>
          )}
          {botsWithoutApps.length > 0 && (
            <div className="glass-card mb-2 rounded-xl px-4 py-3 text-[12.5px] leading-relaxed text-ink-secondary">
              <span className="font-medium text-ink">{t("connectors.perBot.title")}</span>{" "}
              {t("connectors.perBot.body")}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {botsWithoutApps.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => dispatch({ type: "updateBot", botId: candidate.id, patch: { composio: true } })}
                    className="rounded-full bg-control px-2.5 py-1 text-[11.5px] font-medium text-ink hover:bg-control-hover"
                  >
                    {t("connectors.perBot.allow", { name: candidate.name })}
                  </button>
                ))}
              </div>
            </div>
          )}
          {configured && !remoteClient && source === "curated" && mode === "self-hosted" && filter !== "mcp" && (
            <div className="mb-2 text-[12px] text-ink-secondary">
              {t("connectors.featuredBefore")}
            </div>
          )}
          {error && <div role="alert" className="mb-2 mt-1 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{typeof error === "string" ? error : t(error.key)}</div>}

          {filter !== "mcp" && (
            <section data-apps-grid aria-labelledby="apps-grid-title" className="@container pt-3">
              <div id="apps-grid-title" className="mb-3 text-[12px] font-medium text-ink-secondary">
                {filter === "connected"
                  ? t("connectors.section.yours")
                  : browsing
                    ? t(MCP_CONNECTOR_CATEGORIES[browsing])
                    : search
                      ? t("connectors.section.results")
                      : t("connectors.section.available")}
                {filter === "all" && browsing === null && !search && pagination
                  && (pagination.stalled || (pagination.totalItems !== undefined && pagination.items < pagination.totalItems)) && (
                  <span className="ml-2 font-normal">
                    {pagination.totalItems !== undefined && pagination.items < pagination.totalItems
                      ? t("connectors.marketplace.partialCount", {
                        shown: pagination.items.toLocaleString(),
                        total: pagination.totalItems.toLocaleString(),
                      })
                      : t("connectors.marketplace.partialStalled")}
                    {pagination.reason
                      ? ` — ${t("connectors.marketplace.partialReason", { reason: pagination.reason })}`
                      : null}
                  </span>
                )}
              </div>
              <McpConnectorCards connectors={shownConnectors} refreshKey={whopRefresh} onConnected={setConnectedConnectors}
                grouped={grouped ? { limit: APPS_GROUP_PREVIEW_COUNT, onViewAll: viewAll } : undefined}
                onServersChange={() => setWhopRefresh((value) => value + 1)} />
              {grouped && (showWhop || shown.length > 0 || (setupNotice?.tone === "info" && needKey)) && (
                <h3 data-apps-more-heading className="mb-2 flex min-h-8 items-center text-[13px] font-semibold text-ink">{t("apps.moreApps")}</h3>
              )}
              {filter === "all" && browsing === null && setupNotice?.tone === "info" && needKey && (
                <ComposioKeyNotice remote={remoteClient} onSaved={readCatalogAgain} />
              )}
              <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @3xl:grid-cols-3">
                <div className={showWhop ? "contents" : "hidden"}>
                  <McpServersPanel whopCard refreshKey={whopRefresh} onWhopConnection={setWhopConnected} />
                </div>
                {shown.map((card) => renderTile(card))}
              </div>
              {cards === null && browsing === null && (
                <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary">
                  <Loader2 size={14} className="animate-spin" /> {t("connectors.loadingCatalog")}
                </div>
              )}
              {capped && (
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    onClick={() => setShowAllApps(true)}
                    className="rounded-full bg-control/70 px-4 py-2 text-[12.5px] font-medium text-ink hover:bg-control-hover"
                  >
                    {t("apps.showAll", { count: visible.length.toLocaleString() })}
                  </button>
                </div>
              )}
              {(cards !== null || browsing !== null) && listed.length === 0 && !showWhop && shownConnectors.length === 0 && (
                <div className="flex min-h-40 flex-col items-center justify-center text-center">
                  <div className="text-[14px] font-medium text-ink">
                    {filter === "connected" ? connectedEmptyCopy.title : t("connectors.noAppsFound")}
                  </div>
                  <div className="mt-1 text-[12.5px] text-ink-secondary">
                    {filter === "connected" ? connectedEmptyCopy.description : t("connectors.tryDifferentSearch")}
                  </div>
                  {filter === "connected" && inventoryPhase === "error" && (
                    <button
                      type="button"
                      disabled={refreshing}
                      onClick={() => void loadConnectionInventory(true)}
                      className="mt-4 flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-50"
                    >
                      <RefreshCw size={13} className={cn(refreshing && "animate-spin")} />
                      {t("connectors.action.retry")}
                    </button>
                  )}
                </div>
              )}
            </section>
          )}

          {filter === "mcp" && (
            <div className="pt-3">
              <McpServersPanel embedded refreshKey={whopRefresh} />
            </div>
          )}
        </div>
      </div>
    </div>
  );

  function renderTile(card: ToolkitCard) {
    const serviceStatus = status[card.slug];
    const failed = serviceStatus?.status && /^(expired|failed)$/i.test(serviceStatus.status);
    const pending = serviceStatus?.pending && !failed;
    const pendingAuthorization = pending && !failed ? pendingUrls[card.slug] : undefined;
    const authorizationUrl = reusableConnectionUrl(pendingAuthorization);
    const accounts = serviceStatus?.accounts ?? [];
    const included = card.noAuth === true
      || (serviceStatus?.connected === true && !accounts.length && !pending && !failed);
    const connected = Boolean(serviceStatus?.connected || accounts.length);
    const addingAccount = aliasSlug === card.slug && !included;
    const busy = busySlug === card.slug;
    const unavailableReason = managedConnectorUnavailableReason(mode, card.slug)
      ? t("connectors.selfHostOnlyReason")
      : null;
    const usedBy = connected || included ? botsUsingService(state.bots, state.instances, card.slug) : [];
    return (
      <div
        key={card.slug}
        data-app-tile={card.slug}
        className="glass-card flex min-h-[132px] flex-col rounded-2xl p-4"
      >
        <div className="flex items-start gap-3">
          <ServiceIcon card={card} className="size-10" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-medium text-ink">{card.label}</div>
            <div
              className="mt-0.5 line-clamp-1 text-[12px] text-ink-secondary"
              title={unavailableReason ?? card.blurb}
            >
              {unavailableReason ?? (
                pending
                  ? authorizationUrl
                    ? t("connectors.finishSetup")
                    : t("connectors.finishSetupOrDisconnect")
                  : failed && !accounts.length
                    ? t("connectors.authExpired")
                    : card.blurb
              )}
            </div>
          </div>
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 pt-3">
          {connected && !pending ? (
            <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-success">
              <Check size={13} className="shrink-0" /> {t("apps.connected")}
            </span>
          ) : <span />}
          <div className="flex min-w-0 items-center gap-2">
            {usedBy.length > 0 && (
              <span
                className="flex shrink-0 -space-x-1.5"
                title={t("apps.usedBy", { names: usedBy.map((candidate) => candidate.name).join(", ") })}
                aria-label={t("apps.usedBy", { names: usedBy.map((candidate) => candidate.name).join(", ") })}
                role="img"
              >
                {usedBy.slice(0, 3).map((candidate) => (
                  <span
                    key={candidate.id}
                    data-used-by-avatar={candidate.id}
                    className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-menu ring-2 ring-menu"
                  >
                    <BotAvatar bot={candidate} size={USED_BY_AVATAR_SIZE} animated={false} />
                  </span>
                ))}
              </span>
            )}
            <button
              type="button"
              disabled={!configured || inventoryPhase !== "ready" || busy || included || Boolean(unavailableReason)}
              title={unavailableReason ?? undefined}
              onClick={() => {
                if (pending && !failed) {
                  const url = reusableConnectionUrl(pendingAuthorization);
                  if (url) {
                    setError(null);
                    void openConnectUrl(url).catch((e) => setError(e.message));
                  } else {
                    void connect(card.slug);
                  }
                } else {
                  setAliasSlug((current) => current === card.slug ? null : card.slug);
                  setAliasDraft("");
                }
              }}
              className="flex min-w-[80px] items-center justify-center gap-1.5 rounded-full bg-control px-3 py-1.5 text-[12px] text-ink transition-colors hover:bg-control-hover disabled:opacity-40"
            >
              {unavailableReason ? (
                t("connectors.selfHostOnly")
              ) : busy ? (
                <Loader2 size={13} className="mx-auto animate-spin" />
              ) : (
                connectorActionLabel(inventoryPhase, {
                  busy,
                  included,
                  canContinue: Boolean(pendingAuthorization),
                  pending,
                  hasAccounts: accounts.length > 0,
                  failed: Boolean(failed),
                })
              )}
            </button>
          </div>
        </div>
        {authorizationUrl && (
          <a href={authorizationUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => {
            if (!reusableConnectionUrl(pendingAuthorization)) {
              event.preventDefault();
              void connect(card.slug);
            }
          }} className="mt-2 text-[12px] text-accent-text underline underline-offset-2 transition-opacity hover:opacity-80">
            {t("connectors.openAuthorizationPage")}
          </a>
        )}
        {accounts.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {accounts.map((account) => {
              const active = /^active$/i.test(account.status);
              return (
                <div key={account.id} className="flex items-center gap-2 rounded-lg bg-inset/60 px-2.5 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                      {active && <Check size={12} className="shrink-0 text-success" />}
                      <span className="truncate">{account.alias || account.id}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[10.5px] text-ink-secondary">
                      {account.alias ? `${account.id} · ` : ""}{account.status.toLowerCase()}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(disconnectAccountConfirmation(card.label, account))) return;
                      disconnectAccount(card.slug, account.id);
                    }}
                    className="rounded-md px-2 py-1 text-[11px] text-ink-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                    aria-label={t("connectors.disconnectAria", {
                      account: account.alias || account.id,
                      service: card.label,
                    })}
                  >
                    {t("connectors.disconnect")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {(serviceStatus?.connected || included) && (() => {
          const limited = botsWithLimitedServiceTools(state.bots, state.instances, card.slug);
          if (!limited.length) return null;
          return (
            <div data-limited-tools={card.slug} className="mt-2 text-[11px] leading-relaxed text-ink-secondary">
              <span>{t("connectors.grants.limited", { count: limited.length })}</span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {limited.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    data-allow-all-tools={candidate.id}
                    onClick={() => dispatch({
                      type: "updateBot",
                      botId: candidate.id,
                      patch: { connectorTools: { ...candidate.connectorTools, [card.slug]: { tools: "*" } } },
                    })}
                    className="rounded-full bg-control px-2.5 py-1 text-[11.5px] font-medium text-ink hover:bg-control-hover"
                  >
                    {t("connectors.grants.allowAll", { name: candidate.name })}
                  </button>
                ))}
              </div>
            </div>
          );
        })()}
        {addingAccount && (
          <form
            className="mt-3 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const alias = aliasDraft.trim();
              if (!alias) {
                setError({ key: "connectors.aliasRequired" });
                return;
              }
              void connect(card.slug, alias);
            }}
          >
            <input
              autoFocus
              value={aliasDraft}
              maxLength={64}
              onChange={(event) => setAliasDraft(event.target.value)}
              placeholder={t("connectors.aliasPlaceholder")}
              aria-label={accounts.length > 0
                ? t("connectors.aliasAriaAnother", { service: card.label })
                : t("connectors.aliasAriaNew", { service: card.label })}
              className="min-w-0 flex-1 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              type="submit"
              disabled={busy || !aliasDraft.trim()}
              className="rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-accent-ink disabled:opacity-40 transition-[filter] enabled:hover:brightness-110"
            >
              {t("connectors.action.continue")}
            </button>
          </form>
        )}
      </div>
    );
  }
}
