(() => {
  if (window.top !== window || window.__openChat) return;
  const paintTimed = typeof PerformanceObserver !== "undefined" && (PerformanceObserver.supportedEntryTypes ?? []).includes("paint");
  const firstPaint = () => performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
  const until = (test) =>
    new Promise((done) => {
      const check = () => (test() ? done(performance.now()) : setTimeout(check, 4));
      check();
    });
  const frames = (count) =>
    new Promise((done) => {
      const fallback = setTimeout(done, 200);
      const step = (left) => {
        if (left > 0) return requestAnimationFrame(() => step(left - 1));
        clearTimeout(fallback);
        done();
      };
      step(count);
    });
  const composer = () => document.querySelector('textarea[aria-label^="Message "]');
  window.__openChat = async (rowId, name) => {
    const started = performance.now();
    document.querySelector(`[data-sidebar-bot-row="${rowId}"]`).click();
    await until(() => Boolean(document.querySelector(`textarea[aria-label="Message ${name}"]`)) && Boolean(document.querySelector(`[role="log"][aria-label*="${name}"] [data-mid]`)));
    await frames(2);
    window.__report(JSON.stringify({ event: "opened", name, ms: performance.now() - started, rows: document.querySelectorAll('[role="log"] [data-mid]').length }));
  };
  until(() => Boolean(document.body) && Boolean(composer()) && (!paintTimed || firstPaint() !== null)).then((composerAt) => {
    window.__report(JSON.stringify({ event: "ready", composerAt, firstPaint: firstPaint(), engine: navigator.userAgent }));
  });
})();
