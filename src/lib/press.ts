import { DURATION, EASE, PRESS_SCALE, SPRINGS, springDuration, springEasing } from "./motion";

const PRESSABLE =
  'button, a[href], summary, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="tab"], [role="option"], [data-press]';

export const PRESS_MAX_WIDTH = 420;
export const PRESS_MAX_HEIGHT = 140;

export function pressTarget(origin: EventTarget | null): HTMLElement | null {
  if (!(origin instanceof Element)) return null;
  const element = origin.closest<HTMLElement>(PRESSABLE);
  if (!element) return null;
  if (element.closest("[data-no-press]")) return null;
  if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") return null;
  const box = element.getBoundingClientRect();
  if (box.width > PRESS_MAX_WIDTH || box.height > PRESS_MAX_HEIGHT) return null;
  return element;
}

function reducedMotion(): boolean {
  if (document.documentElement.dataset.reducedMotion === "true") return true;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

const releaseEasing = springEasing(SPRINGS.bounce);
const releaseDuration = springDuration(SPRINGS.bounce);

export function installPressFeedback(doc: Document = document): () => void {
  let held: { element: HTMLElement; animation: Animation; reduced: boolean } | null = null;

  const release = () => {
    if (!held) return;
    const { element, animation, reduced } = held;
    held = null;
    const property = reduced ? "opacity" : "scale";
    const computed = getComputedStyle(element).getPropertyValue(property);
    const from = computed && computed !== "none" ? computed : "1";
    animation.cancel();
    element.animate(
      [{ [property]: from }, { [property]: "1" }],
      reduced
        ? { duration: DURATION.fast, easing: EASE.exit }
        : { duration: releaseDuration, easing: releaseEasing },
    );
  };

  const press = (event: PointerEvent) => {
    if (event.button !== 0 || typeof Element.prototype.animate !== "function") return;
    const element = pressTarget(event.target);
    if (!element) return;
    release();
    const reduced = reducedMotion();
    const animation = element.animate(
      reduced ? [{ opacity: 1 }, { opacity: 0.7 }] : [{ scale: 1 }, { scale: PRESS_SCALE }],
      { duration: DURATION.fast, easing: EASE.enter, fill: "forwards" },
    );
    held = { element, animation, reduced };
  };

  doc.addEventListener("pointerdown", press, true);
  doc.addEventListener("pointerup", release, true);
  doc.addEventListener("pointercancel", release, true);
  doc.defaultView?.addEventListener("blur", release);
  return () => {
    doc.removeEventListener("pointerdown", press, true);
    doc.removeEventListener("pointerup", release, true);
    doc.removeEventListener("pointercancel", release, true);
    doc.defaultView?.removeEventListener("blur", release);
    release();
  };
}
