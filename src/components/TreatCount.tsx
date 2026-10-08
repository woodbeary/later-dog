// How many treats a dog has been given, under its name on its profile. Hidden until the first treat.
import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { onTreat, treatCount } from "@/lib/treats";

export function TreatCount({ botId }: { botId: string }) {
  const [count, setCount] = useState(() => treatCount(botId));
  useEffect(() => {
    setCount(treatCount(botId));
    return onTreat(() => setCount(treatCount(botId)));
  }, [botId]);
  if (count === 0) return null;
  return (
    <span className="text-[12px] text-ink-secondary" aria-live="polite">
      🦴 {count === 1 ? t("chat.treatCountOne") : t("chat.treatCount", { count })}
    </span>
  );
}
