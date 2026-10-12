import { flushSync } from "react-dom";
import { reducedMotion } from "@/lib/onboarding";

export function withViewTransition(update: () => void): void {
  if (reducedMotion() || typeof document.startViewTransition !== "function") {
    update();
    return;
  }
  document.startViewTransition(() => {
    flushSync(update);
  });
}
