export const APP_LINK_SCHEMES = Object.freeze(["laterdog", "laterdog-dev"]);
export const APP_LINK_HOSTS = Object.freeze(["dog", "chat", "thread", "settings"]);
export const APP_LINK_SETTINGS_SECTIONS = Object.freeze(["general", "computer", "usage", "updates"]);
export const APP_LINK_MAX_LENGTH = 2048;

const ID = /^[\w-]{1,128}$/;
const SPACE_OR_BACKSLASH = /[\s\\]/;
const unsafe = text => SPACE_OR_BACKSLASH.test(text) || [...text].some(char => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
const QUERY_KEYS = Object.freeze({
  dog: [],
  chat: ["thread"],
  thread: ["bot"],
  settings: ["section"],
});

const rejected = reason => ({ ok: false, reason });

function decoded(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function pathSegments(pathname) {
  const trimmed = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return [];
  const parts = trimmed.split("/").map(decoded);
  return parts.every(part => part !== null && part.length > 0) ? parts : null;
}

function singleValues(params, allowed) {
  const values = new Map();
  for (const [key, value] of params) {
    if (!allowed.includes(key) || values.has(key)) return null;
    values.set(key, value);
  }
  return values;
}

export function buildAppLink(link, scheme = "laterdog") {
  if (link.kind === "dog") return `${scheme}://dog/${encodeURIComponent(link.id)}`;
  return link.section ? `${scheme}://settings?section=${link.section}` : `${scheme}://settings`;
}

export function parseAppLink(raw) {
  if (typeof raw !== "string") return rejected("malformed");
  const text = raw.trim();
  if (!text || text.length > APP_LINK_MAX_LENGTH || unsafe(text)) return rejected("malformed");
  let url;
  try {
    url = new URL(text);
  } catch {
    return rejected("malformed");
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!APP_LINK_SCHEMES.includes(scheme)) return rejected("scheme");
  if (url.username || url.password || url.port || url.hash) return rejected("malformed");
  const host = url.hostname.toLowerCase();
  if (!APP_LINK_HOSTS.includes(host)) return rejected("route");
  const segments = pathSegments(url.pathname);
  const query = singleValues(url.searchParams, QUERY_KEYS[host]);
  if (!segments || !query) return rejected("malformed");

  if (host === "settings") {
    if (segments.length > 1 || (segments.length === 1 && query.has("section"))) return rejected("malformed");
    const asked = segments[0] ?? query.get("section");
    const section = asked && APP_LINK_SETTINGS_SECTIONS.includes(asked) ? asked : null;
    const link = { kind: "settings", section };
    return { ok: true, link, canonical: buildAppLink(link) };
  }

  if (segments.length !== 1) return rejected("id");
  const id = host === "thread" ? query.get("bot") : segments[0];
  if (!id || !ID.test(id)) return rejected("id");
  const link = { kind: "dog", id };
  return { ok: true, link, canonical: buildAppLink(link) };
}

export function appLinkLogLabel(raw) {
  if (typeof raw !== "string") return "invalid";
  try {
    const url = new URL(raw.trim());
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    if (!/^[a-z][a-z0-9+.-]{0,31}$/.test(scheme)) return "invalid";
    const host = url.hostname.toLowerCase();
    return /^[a-z0-9.-]{1,253}$/.test(host) ? `${scheme}://${host}` : `${scheme}:`;
  } catch {
    return "invalid";
  }
}
