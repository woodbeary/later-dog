import { useEffect, useState } from "react";
import { BreedAvatar } from "@/components/DogAvatar";
import { DEFAULT_DOG_COLOR } from "@/lib/mascot";
import { useStore } from "@/state/store";

export const SPLASH_MIN_MS = 700;
export const SPLASH_FADE_MS = 360;

export function LaunchSplash() {
  const { state } = useStore();
  const ready = state.connected && state.hydrated === true;
  const [held, setHeld] = useState(false);
  const [phase, setPhase] = useState<"shown" | "leaving" | "gone">("shown");

  useEffect(() => {
    const timer = window.setTimeout(() => setHeld(true), SPLASH_MIN_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (ready && held && phase === "shown") setPhase("leaving");
  }, [ready, held, phase]);

  useEffect(() => {
    if (phase !== "leaving") return;
    const timer = window.setTimeout(() => setPhase("gone"), SPLASH_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  if (phase === "gone") return null;
  return (
    <div
      data-launch-splash={phase}
      aria-hidden="true"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-app"
      style={{ opacity: phase === "leaving" ? 0 : 1, transition: `opacity ${SPLASH_FADE_MS}ms ease-out`, pointerEvents: phase === "leaving" ? "none" : "auto" }}
    >
      <div className="animate-[pop-in_420ms_cubic-bezier(0.2,0.9,0.3,1.2)_both]">
        <BreedAvatar breed="dog" color={DEFAULT_DOG_COLOR} size={72} />
      </div>
    </div>
  );
}
