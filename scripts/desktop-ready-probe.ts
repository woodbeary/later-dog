export interface ComposerReadiness {
  composerAt: number | null;
  composerUncoveredAt: number | null;
}

export function installComposerProbe(perf: ComposerReadiness): () => void {
  const seen = new MutationObserver(check);
  function check() {
    const composer = document.querySelector<HTMLElement>('textarea[aria-label^="Message "]');
    if (!composer) return;
    if (perf.composerAt === null) perf.composerAt = performance.now();
    if (
      perf.composerUncoveredAt === null &&
      !document.querySelector("[data-launch-splash]") &&
      document.visibilityState === "visible" &&
      composer.getClientRects().length
    ) {
      perf.composerUncoveredAt = performance.now();
      seen.disconnect();
    }
  }
  seen.observe(document.documentElement, { childList: true, subtree: true });
  check();
  return () => seen.disconnect();
}
