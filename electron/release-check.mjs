// later.dog's releases are not signed or notarized and publish no update
// feed, so the in-app updater (updater.mjs) stays idle: Squirrel.Mac installs
// only into a signed app. Until they are, this asks GitHub whether a newer
// release exists, and the update UI says so and offers the release page to
// download it from. Nothing here downloads or installs anything.
//
// One unauthenticated GET of the repository's latest release (GitHub leaves
// drafts and prereleases out of it), a short while after launch and then at
// most every 12 hours while the app runs. The request carries nothing about
// the person: no token, cookie, version or identifier. A failure (offline,
// rate-limited, an answer that does not parse) changes nothing and the next
// interval tries again; only a check the person asked for says it failed.
// Settings → General → Check for new versions, off: no request at all.
import fs from "node:fs";
import path from "node:path";

export const LATEST_RELEASE_API = "https://api.github.com/repos/woodbeary/later-dog/releases/latest";
export const RELEASES_PAGE = "https://github.com/woodbeary/later-dog/releases";
/** Let the app settle before the first check, as the updater does. */
export const RELEASE_CHECK_DELAY_MS = 30_000;
export const RELEASE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** A request that never answers must not hold off every later check. */
export const RELEASE_CHECK_TIMEOUT_MS = 15_000;
/** Shown only when the person's own check fails. The update UI shows the
 * updater's messages as main sends them, in English (update-errors.mjs). */
export const RELEASE_CHECK_FAILED = "Could not check GitHub for a new version. Try again later.";

// ── versions ────────────────────────────────────────────────────────────
// Semantic versions in semver's order (semver.org, §11). The packaged app
// ships no node_modules, so this is the small part of semver it needs.
// Numbers never carry leading zeros, so a longer one is a larger one and
// nothing has to fit in a double.
const NUMBER = "0|[1-9]\\d*";
const IDENTIFIER = `(?:${NUMBER}|\\d*[A-Za-z-][\\dA-Za-z-]*)`;
const VERSION = new RegExp(
  `^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+[\\dA-Za-z-]+(?:\\.[\\dA-Za-z-]+)*)?$`,
);

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const compareNumbers = (a, b) => Math.sign(a.length - b.length) || compareText(a, b);

/** "1.2.3" or "1.2.3-preview.1" as its numbers and prerelease identifiers;
 * null for anything that is not a semantic version. */
export function parseVersion(text) {
  const match = typeof text === "string" ? VERSION.exec(text) : null;
  return match ? { core: match.slice(1, 4), prerelease: match[4] ? match[4].split(".") : [] } : null;
}

function compareIdentifiers(a, b) {
  const numeric = /^\d+$/;
  if (numeric.test(a) && numeric.test(b)) return compareNumbers(a, b);
  // Numeric identifiers sort before alphanumeric ones; those sort as ASCII.
  if (numeric.test(a)) return -1;
  if (numeric.test(b)) return 1;
  return compareText(a, b);
}

/** Semver order of two version strings: negative when `a` is older than `b`,
 * 0 when they are equal, positive when it is newer; null when either is not a
 * semantic version. A prerelease sorts before its release; build metadata
 * never counts. */
export function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    const order = compareNumbers(left.core[index], right.core[index]);
    if (order) return order;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }
  for (let index = 0; index < Math.min(left.prerelease.length, right.prerelease.length); index += 1) {
    const order = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (order) return order;
  }
  return Math.sign(left.prerelease.length - right.prerelease.length);
}

/** The version a release tag names: "v1.2.3" → "1.2.3". A tag that looks
 * like a prerelease ("v1.2.3-preview.1"), carries build metadata, or is not
 * "v" and a semantic version gives null, and is ignored. */
export function releaseTagVersion(tag) {
  const match = typeof tag === "string" ? /^v(\d+\.\d+\.\d+)$/.exec(tag) : null;
  return match && parseVersion(match[1]) ? match[1] : null;
}

/** Where to download a release: GitHub's own page for it when the answer
 * names one in this repository, else the page its tag names. Never another
 * site, whatever the answer says. */
export function releasePageUrl(htmlUrl, tag) {
  try {
    const url = new URL(htmlUrl);
    if (
      url.protocol === "https:" && url.host === "github.com" && !url.username && !url.password &&
      url.pathname.startsWith("/woodbeary/later-dog/releases/")
    ) return url.href;
  } catch {
    // not a URL: fall back to the tag's page
  }
  return `${RELEASES_PAGE}/tag/${encodeURIComponent(tag)}`;
}

/** What GitHub's latest-release answer offers an app at `currentVersion`:
 * `{ version, url }` when it is a plain release newer than this one, else
 * null (the same or an older version, a draft or prerelease, a tag that is
 * not vX.Y.Z, or an answer that is not a release at all). */
export function releaseOffer(release, currentVersion) {
  if (!release || typeof release !== "object" || release.draft === true || release.prerelease === true) return null;
  const version = releaseTagVersion(release.tag_name);
  const order = version && compareVersions(version, currentVersion);
  if (order === null || !(order > 0)) return null;
  return { version, url: releasePageUrl(release.html_url, release.tag_name) };
}

/** One GET of the latest release, with only what GitHub asks of every caller:
 * an Accept header and a User-Agent that names the app (not its version, not
 * the person). No credentials, no cookies. Resolves the parsed answer; rejects
 * on an error status (403 or 429 when rate-limited), a network failure, an
 * abort, or a body that is not JSON. */
export async function fetchLatestRelease(fetchImpl, signal) {
  const response = await fetchImpl(LATEST_RELEASE_API, {
    method: "GET",
    headers: { accept: "application/vnd.github+json", "user-agent": "later.dog", "x-github-api-version": "2022-11-28" },
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
  return response.json();
}

/**
 * The check, wired to the updater's state. `deps`:
 * - currentVersion: this app's version (app.getVersion())
 * - setState(patch): the updater's own, which merges the patch and sends it
 *   to the update UI: `available` ({ version, url } of a newer release, or
 *   undefined), `releaseCheck` ("on" | "off"), and "checking" / "error" for
 *   a check the person asked for
 * - enabled(): the saved switch; saveEnabled(on) remembers a new choice
 * - fetch, now, log(line); delayMs, intervalMs and timeoutMs for tests
 */
export function createReleaseCheck({
  currentVersion,
  setState,
  enabled,
  saveEnabled = () => {},
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  log = () => {},
  delayMs = RELEASE_CHECK_DELAY_MS,
  intervalMs = RELEASE_CHECK_INTERVAL_MS,
  timeoutMs = RELEASE_CHECK_TIMEOUT_MS,
}) {
  let running = false;
  let timer = null;
  // When the last request went out, the person's own checks included.
  let lastRequestAt = null;
  let inFlight = null;
  let offered = null;

  // The timer's check, never the person's: due once 12 hours have passed
  // since the last request, then due again 12 hours after that one. A clock
  // set back never stretches the wait past 12 hours.
  function automatic() {
    clearTimeout(timer);
    timer = null;
    if (!running) return;
    const wait = lastRequestAt === null ? 0 : Math.min(lastRequestAt + intervalMs - now(), intervalMs);
    if (wait <= 0) void check(false);
    timer = setTimeout(automatic, wait > 0 ? wait : intervalMs);
    timer.unref?.();
  }

  function check(manual) {
    if (!running || !enabled()) return Promise.resolve();
    if (inFlight) {
      // The person asks while the timer's request is out: its outcome is theirs.
      if (manual && !inFlight.manual) {
        inFlight.manual = true;
        setState({ status: "checking" });
      }
      return inFlight.promise;
    }
    const operation = { manual, controller: new AbortController(), promise: null };
    inFlight = operation;
    lastRequestAt = now();
    if (manual) setState({ status: "checking" });
    const deadline = setTimeout(() => operation.controller.abort(new Error(`GitHub did not answer within ${timeoutMs / 1000} s`)), timeoutMs);
    deadline.unref?.();
    operation.promise = fetchLatestRelease(fetchImpl, operation.controller.signal)
      .then((release) => {
        if (inFlight !== operation) return; // switched off meanwhile
        const offer = releaseOffer(release, currentVersion);
        if (offer && offer.version !== offered?.version) log(`release check: later.dog ${offer.version} is out (${offer.url})`);
        offered = offer;
        setState({ status: "idle", available: offer ?? undefined, message: undefined });
      })
      .catch((error) => {
        if (inFlight !== operation) return;
        log(`release check failed: ${error?.message ?? error}${error?.cause?.code ? ` (${error.cause.code})` : ""}`);
        // Nobody asked: stay quiet and let the next interval try again. The
        // person's own check says it failed, unless a newer release is
        // already on offer, which stays.
        if (operation.manual) setState(offered ? { status: "idle" } : { status: "error", message: RELEASE_CHECK_FAILED });
      })
      .finally(() => {
        clearTimeout(deadline);
        if (inFlight === operation) inFlight = null;
      });
    return operation.promise;
  }

  return {
    start() {
      if (running) return;
      running = true;
      setState({ releaseCheck: enabled() ? "on" : "off" });
      timer = setTimeout(automatic, delayMs);
      timer.unref?.();
    },
    stop() {
      running = false;
      clearTimeout(timer);
      timer = null;
      inFlight?.controller.abort(new Error("release check stopped"));
      inFlight = null;
    },
    /** `manual`: the person's "Check for updates". Off, it asks nothing. */
    check: (manual = false) => check(manual === true),
    /** Settings → General → Check for new versions. Off stops a request in
     * flight and takes the offer down; on asks at once, unless a request
     * went out within the last 12 hours. Answers the switch's new state. */
    setEnabled(value) {
      const on = value === true;
      saveEnabled(on);
      if (on) {
        setState({ releaseCheck: "on" });
        automatic();
        return on;
      }
      inFlight?.controller.abort(new Error("checking for new versions was switched off"));
      inFlight = null;
      offered = null;
      setState({ releaseCheck: "off", status: "idle", available: undefined, message: undefined });
      return on;
    },
  };
}

// ── the remembered switch ──────────────────────────────────────────────
// On by default. The file lives in the app's own userData beside its other
// desktop switches (routine-wake.json), because the app owns the switch.
const settingsFile = (userData) => path.join(userData, "release-check.json");

export function releaseCheckEnabled(userData) {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(userData), "utf8"))?.enabled !== false;
  } catch {
    return true;
  }
}

/** Temp-and-rename, so a crash mid-write never leaves a truncated file. */
export function rememberReleaseCheck(userData, enabled) {
  const file = settingsFile(userData);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ enabled: enabled !== false }, null, 2));
    fs.renameSync(temporary, file);
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* never created, or already renamed */
    }
  }
}

/** Start checking (updater.mjs, only in a packaged build with no update
 * feed). The switch is read once, then kept in step with each saved choice. */
export function startReleaseCheck({ userData, currentVersion, setState, log }) {
  let on = releaseCheckEnabled(userData);
  const releaseCheck = createReleaseCheck({
    currentVersion,
    setState,
    log,
    enabled: () => on,
    saveEnabled: (value) => {
      on = value;
      rememberReleaseCheck(userData, value);
    },
  });
  releaseCheck.start();
  return releaseCheck;
}
