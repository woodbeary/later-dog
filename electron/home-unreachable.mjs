export const TRY_AGAIN_URL = "https://try-again.invalid/";
export const HOME_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000]);

const laterBy = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return timer;
};

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function unreachableLine({ name, home }) {
  return home ? "Couldn't reach your home" : `Couldn't reach ${name}`;
}

export function unreachablePage(target) {
  const line = escapeHtml(unreachableLine(target));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark light"><title>later.dog</title><style>
:root{--bg:#070707;--ink:#ededed;--muted:#8f8f8f}
@media (prefers-color-scheme: light){:root{--bg:#fafafa;--ink:#111111;--muted:#6b6b6b}}
html,body{height:100%;margin:0;background:var(--bg)}
body{display:flex;align-items:center;justify-content:center;color:var(--muted);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-app-region:drag;user-select:none}
p{margin:0 16px;text-align:center}
a{color:var(--ink);font-weight:500;text-decoration:none;-webkit-app-region:no-drag}
a:hover{text-decoration:underline}
</style></head><body><p role="status" data-home-unreachable>${line} · <a href="${TRY_AGAIN_URL}">Try again</a></p></body></html>`;
}

export function unreachablePageUrl(target) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(unreachablePage(target))}`;
}

export function isTryAgainLink(url) {
  try { return new URL(url).href === TRY_AGAIN_URL; } catch { return false; }
}

export function createHomeRetry({ reconnect, show, delays = HOME_RETRY_DELAYS_MS, setTimer = laterBy, clearTimer = clearTimeout, log = () => {} }) {
  let failing = null, attempts = 0, timer = null, inFlight = null;

  function cancel() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  function schedule() {
    cancel();
    const wait = delays[Math.min(attempts, delays.length - 1)];
    attempts++;
    timer = setTimer(() => { timer = null; void attempt(); }, wait);
    return wait;
  }

  function attempt() {
    const target = failing;
    if (!target) return Promise.resolve();
    inFlight ??= (async () => {
      try { await reconnect(target); } catch (error) {
        log(`${unreachableLine(target)} (${error?.message ?? error}); trying again`);
        if (failing === target && !timer) schedule();
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  function failed(target) {
    if (failing?.origin !== target.origin) attempts = 0;
    failing = { origin: target.origin, name: target.name, home: target.home === true };
    show(unreachablePageUrl(failing));
    return schedule();
  }

  function tryNow() {
    if (!failing) return false;
    cancel();
    attempts = 0;
    void attempt();
    return true;
  }

  function stop() {
    cancel();
    failing = null;
    attempts = 0;
  }

  return { failed, tryNow, loaded: stop, stop, failing: () => failing?.origin ?? null };
}
