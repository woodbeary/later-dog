export const BLINK_EVERY_MS = 5_400;
export const BLINK_MS = 180;

const BLINK_FRAMES = [{ transform: "scaleY(1)" }, { transform: "scaleY(0.12)" }, { transform: "scaleY(1)" }];

interface Blinks {
  watch(face: Element): () => void;
}

export function createBlinks(host: {
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  observer?: (seen: (entries: readonly { target: Element; isIntersecting: boolean }[]) => void) => { observe(face: Element): void; unobserve(face: Element): void };
  still(): boolean;
}): Blinks {
  const watched = new Set<Element>();
  const onScreen = new Set<Element>();
  let timer: unknown = null;
  const observer = host.observer?.((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && watched.has(entry.target)) onScreen.add(entry.target);
      else onScreen.delete(entry.target);
    }
  });
  const blink = () => {
    if (host.still()) return;
    for (const face of observer ? onScreen : watched) {
      if (face.hasAttribute("data-paused")) continue;
      face.querySelector(".ld-dog-blink")?.animate?.(BLINK_FRAMES, { duration: BLINK_MS, easing: "ease-in-out" });
    }
  };
  return {
    watch(face) {
      watched.add(face);
      observer?.observe(face);
      if (timer === null) timer = host.setInterval(blink, BLINK_EVERY_MS);
      return () => {
        watched.delete(face);
        onScreen.delete(face);
        observer?.unobserve(face);
        if (watched.size === 0 && timer !== null) {
          host.clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}

function reducedMotion(): boolean {
  return document.documentElement.dataset.reducedMotion === "true" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

let shared: Blinks | null = null;

export function watchBlinks(face: Element): () => void {
  shared ??= createBlinks({
    setInterval: (run, ms) => window.setInterval(run, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
    observer: typeof IntersectionObserver === "function"
      ? (seen) => new IntersectionObserver((entries) => seen(entries))
      : undefined,
    still: () => document.hidden || reducedMotion(),
  });
  return shared.watch(face);
}
