
export interface Denial {
  status: number;
  error: string;
}

export interface RouteRequest {
  path: string;
  method: string;
  authenticated: boolean;
}

export const CLOUD_DESKTOP_JOIN_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/computer\/join$/,
} as const;

export const MESSAGE_FILE_ROUTE = {
  method: "POST",
  path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/file$/,
} as const;

export const CLOUD_DESKTOP_CONTROL_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/computer\/(?:control|screenshot|viewer-close)$/,
} as const;

export const BROWSER_LIVE_ROUTE = {
  method: "GET",
  path: /^\/api\/bots\/[\w-]+\/browser\/live$/,
} as const;

export const BROWSER_ACTION_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/browser\/action$/,
} as const;

export const LOCAL_VM_JOIN_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/local-computer\/join$/,
} as const;

export const LOCAL_VM_SCREENSHOT_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/local-computer\/screenshot$/,
} as const;

export function isCloudDesktopJoin(method: string, path: string): boolean {
  return method === CLOUD_DESKTOP_JOIN_ROUTE.method && CLOUD_DESKTOP_JOIN_ROUTE.path.test(path);
}

export function isMessageFileDownload(method: string, path: string): boolean {
  return method === MESSAGE_FILE_ROUTE.method && MESSAGE_FILE_ROUTE.path.test(path);
}

export function isCloudDesktopAccess(method: string, path: string): boolean {
  return isCloudDesktopJoin(method, path)
    || (method === CLOUD_DESKTOP_CONTROL_ROUTE.method && CLOUD_DESKTOP_CONTROL_ROUTE.path.test(path))
    || (method === LOCAL_VM_SCREENSHOT_ROUTE.method && LOCAL_VM_SCREENSHOT_ROUTE.path.test(path))
    || (method === LOCAL_VM_JOIN_ROUTE.method && LOCAL_VM_JOIN_ROUTE.path.test(path));
}

export function isBrowserControlAccess(method: string, path: string): boolean {
  return (method === BROWSER_LIVE_ROUTE.method && BROWSER_LIVE_ROUTE.path.test(path))
    || (method === BROWSER_ACTION_ROUTE.method && BROWSER_ACTION_ROUTE.path.test(path));
}

const ALLOWED: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "GET", path: /^\/api\/config$/ },
  { method: "GET", path: /^\/api\/events$/ },
  { method: "GET", path: /^\/api\/instances$/ },
  { method: "POST", path: /^\/api\/instances\/(?!\.+\/)[\w.-]+\/claude-update$/ },
  { method: "GET", path: /^\/api\/team-map$/ },
  { method: "GET", path: /^\/api\/companion\/endpoints$/ },

  { method: "GET", path: /^\/api\/bots$/ },
  { method: "POST", path: /^\/api\/bots$/ },
  { method: "POST", path: /^\/api\/sidebar-sections$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/messages$/ },
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/cards\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/respond$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/interrupt$/ },
  { method: "DELETE", path: /^\/api\/bots\/[\w-]+\/queue\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/read$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/always-allow$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/messages\/[\w-]+\/edit$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/secret-cards\/[\w-]+\/provide$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/active-branch$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/compact$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/tasks$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "GET", path: /^\/api\/bots\/[\w-]+\/overview$/ },
  { method: "GET", path: /^\/api\/bots\/[\w-]+\/activity$/ },
  { method: "GET", path: /^\/api\/team-memory$/ },
  { method: "POST", path: /^\/api\/team-memory$/ },
  { method: "PATCH", path: /^\/api\/team-memory\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/team-memory\/[\w-]+$/ },
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/profile$/ },
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/model$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/avatar\/generate$/ },
  CLOUD_DESKTOP_JOIN_ROUTE,

  CLOUD_DESKTOP_CONTROL_ROUTE,
  BROWSER_LIVE_ROUTE,
  BROWSER_ACTION_ROUTE,
  LOCAL_VM_SCREENSHOT_ROUTE,
  LOCAL_VM_JOIN_ROUTE,
  { method: "POST", path: /^\/api\/groups$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/messages$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/interrupt$/ },
  { method: "DELETE", path: /^\/api\/groups\/[\w-]+\/queue\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/read$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/tasks$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "PATCH", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },

  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/image$/ },
  MESSAGE_FILE_ROUTE,
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/reactions$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/export$/ },
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/respond$/ },
  { method: "GET", path: /^\/api\/search$/ },

  { method: "POST", path: /^\/api\/attachments$/ },
  { method: "GET", path: /^\/api\/attachments\/[\w-]+\.(?:png|jpe?g|gif|webp|mp3)$/i },
  { method: "POST", path: /^\/api\/files$/ },

  { method: "GET", path: /^\/api\/tts\/voices$/ },
  { method: "POST", path: /^\/api\/tts\/prepare$/ },
  { method: "POST", path: /^\/api\/tts\/speak$/ },

  { method: "POST", path: /^\/api\/live\/session$/ },
  { method: "POST", path: /^\/api\/live\/call\/end$/ },
  { method: "GET", path: /^\/api\/live\/call$/ },
  { method: "PATCH", path: /^\/api\/live\/settings$/ },

  { method: "GET", path: /^\/api\/routines$/ },
  { method: "POST", path: /^\/api\/routines$/ },
  { method: "PATCH", path: /^\/api\/routines\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/routines\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/routines\/[\w-]+\/run$/ },
  { method: "POST", path: /^\/api\/routine-runs\/[\w-]+\/(?:cancel|seen)$/ },

  { method: "GET", path: /^\/api\/connectors\/catalog$/ },
  { method: "GET", path: /^\/api\/connectors\/connected$/ },
  { method: "GET", path: /^\/api\/connectors$/ },
  { method: "POST", path: /^\/api\/connectors\/[\w-]+\/authorize$/ },
  { method: "DELETE", path: /^\/api\/connectors\/[\w-]+\/accounts\/[\w-]+$/ },
  { method: "GET", path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/status$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/(?:authorize|resume|dismiss)$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/secret-cards\/[\w-]+\/(?:resume|dismiss)$/ },
];

const COMPANION_NOTICES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/api\/live\/device-revoked$/ },
];

export function isCompanionNotice(method: string, path: string): boolean {
  return COMPANION_NOTICES.some((route) => route.method === method && route.path.test(path));
}

const EXPLAINED: ReadonlyArray<{ path: RegExp; error: string }> = [
  {
    path: /^\/api\/(companion|devices)(\/|$)/,
    error: "Remote access settings are managed on the host computer",
  },
  { path: /^\/api\/config$/, error: "API keys can only be changed on your computer" },
  { path: /^\/api\/local-computer(\/|$)/, error: "the Local VM is set up on your computer" },
  {
    path: /^\/api\/webhooks(\/|$)/,
    error: "webhooks are set up on your computer",
  },
  { path: /^\/api\/connectors(\/|$)/, error: "connected apps are set up on your computer" },
  {
    path: /^\/api\/routines(\/|$)/,
    error: "this routine operation is only available on your computer",
  },
  { path: /^\/api\/teams(\/|$)/, error: "teams are imported and exported on your computer" },
];

export function denyReason({ path, method, authenticated }: RouteRequest): Denial | null {
  if (method === "POST" && path === "/api/pair") return null;
  if (method === "GET" && path === "/api/health") return null;

  if (!authenticated) {
    return { status: 401, error: "pair this device from Remote access settings on the host computer" };
  }

  if (ALLOWED.some((route) => route.method === method && route.path.test(path))) return null;

  const explained = EXPLAINED.find((family) => family.path.test(path));
  if (explained) return { status: 403, error: explained.error };

  return { status: 404, error: `no route: ${method} ${path}` };
}
