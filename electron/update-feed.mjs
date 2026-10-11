export const UPDATE_FEED_FIELD = "laterdogUpdateFeed";
export const NOTES_LIMIT = 4000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function updateFeedUrl({ env = {}, packageJson = null } = {}) {
  const override = typeof env.LATERDOG_UPDATE_URL === "string" ? env.LATERDOG_UPDATE_URL.trim() : "";
  const baked = typeof packageJson?.[UPDATE_FEED_FIELD] === "string" ? packageJson[UPDATE_FEED_FIELD].trim() : "";
  const text = override || baked;
  if (!text) return null;
  let feed;
  try {
    feed = new URL(text);
  } catch {
    return { error: "later.dog's update feed is not a URL" };
  }
  const loopbackTest = Boolean(override) && feed.protocol === "http:" && LOOPBACK_HOSTS.has(feed.hostname);
  if ((feed.protocol !== "https:" && !loopbackTest) || feed.username || feed.password) {
    return { error: "later.dog updates require an HTTPS feed without URL credentials" };
  }
  return { url: feed.href, source: override ? "environment" : "build" };
}

export function updateNotes(info) {
  const notes = info?.releaseNotes;
  const text = typeof notes === "string"
    ? notes
    : Array.isArray(notes)
      ? notes.map((entry) => (typeof entry?.note === "string" ? entry.note : "")).filter(Boolean).join("\n\n")
      : "";
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return undefined;
  return trimmed.length > NOTES_LIMIT ? `${trimmed.slice(0, NOTES_LIMIT).trimEnd()}…` : trimmed;
}
