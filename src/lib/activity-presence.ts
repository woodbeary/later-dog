import { useEffect, useRef, useState } from "react";
import { t } from "./i18n";

export function presenceWords(label: string, elapsedMs: number): string {
  if (label !== t("chat.activity.thinking")) return label;
  return elapsedMs >= 15_000 ? t("chat.activity.deepWork") : "";
}

export function presenceElapsed(elapsedMs: number): string {
  if (elapsedMs < 60_000) return "";
  const minutes = Math.floor(elapsedMs / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

export function useActivityPresence(label: string, since: number | null, active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active, since]);
  const elapsed = since === null ? 0 : Math.max(0, now - since);
  const next = presenceWords(label, elapsed);
  const [phrase, setPhrase] = useState(next);
  const changedAt = useRef(Date.now());
  useEffect(() => {
    if (next === phrase) return;
    const timer = setTimeout(() => { changedAt.current = Date.now(); setPhrase(next); }, Math.max(0, 800 - (Date.now() - changedAt.current)));
    return () => clearTimeout(timer);
  }, [next, phrase]);
  return { phrase, elapsed: presenceElapsed(elapsed), now };
}
