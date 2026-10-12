import fs from "node:fs";
import path from "node:path";

export const LATEST_RELEASE_API = "https://api.github.com/repos/woodbeary/later-dog/releases/latest";
export const RELEASES_PAGE = "https://github.com/woodbeary/later-dog/releases";
export const RELEASE_CHECK_DELAY_MS = 30_000;
export const RELEASE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const RELEASE_CHECK_TIMEOUT_MS = 15_000;
export const RELEASE_CHECK_FAILED = "Could not check GitHub for a new version. Try again later.";

const NUMBER = "0|[1-9]\\d*";
const IDENTIFIER = `(?:${NUMBER}|\\d*[A-Za-z-][\\dA-Za-z-]*)`;
const VERSION = new RegExp(
  `^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+[\\dA-Za-z-]+(?:\\.[\\dA-Za-z-]+)*)?$`,
);

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const compareNumbers = (a, b) => Math.sign(a.length - b.length) || compareText(a, b);

export function parseVersion(text) {
  const match = typeof text === "string" ? VERSION.exec(text) : null;
  return match ? { core: match.slice(1, 4), prerelease: match[4] ? match[4].split(".") : [] } : null;
}

function compareIdentifiers(a, b) {
  const numeric = /^\d+$/;
  if (numeric.test(a) && numeric.test(b)) return compareNumbers(a, b);
  if (numeric.test(a)) return -1;
  if (numeric.test(b)) return 1;
  return compareText(a, b);
}

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

export function releaseTagVersion(tag) {
  const match = typeof tag === "string" ? /^v(\d+\.\d+\.\d+)$/.exec(tag) : null;
  return match && parseVersion(match[1]) ? match[1] : null;
}

export function releasePageUrl(htmlUrl, tag) {
  try {
    const url = new URL(htmlUrl);
    if (
      url.protocol === "https:" && url.host === "github.com" && !url.username && !url.password &&
      url.pathname.startsWith("/woodbeary/later-dog/releases/")
    ) return url.href;
  } catch {}
  return `${RELEASES_PAGE}/tag/${encodeURIComponent(tag)}`;
}

export function releaseOffer(release, currentVersion) {
  if (!release || typeof release !== "object" || release.draft === true || release.prerelease === true) return null;
  const version = releaseTagVersion(release.tag_name);
  const order = version && compareVersions(version, currentVersion);
  if (order === null || !(order > 0)) return null;
  return { version, url: releasePageUrl(release.html_url, release.tag_name) };
}

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
  let lastRequestAt = null;
  let inFlight = null;
  let offered = null;

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
        if (inFlight !== operation) return;
        const offer = releaseOffer(release, currentVersion);
        if (offer && offer.version !== offered?.version) log(`release check: later.dog ${offer.version} is out (${offer.url})`);
        offered = offer;
        setState({ status: "idle", available: offer ?? undefined, message: undefined });
      })
      .catch((error) => {
        if (inFlight !== operation) return;
        log(`release check failed: ${error?.message ?? error}${error?.cause?.code ? ` (${error.cause.code})` : ""}`);
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
    check: (manual = false) => check(manual === true),
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

const settingsFile = (userData) => path.join(userData, "release-check.json");

export function releaseCheckEnabled(userData) {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(userData), "utf8"))?.enabled !== false;
  } catch {
    return true;
  }
}

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
    } catch {}
  }
}

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
