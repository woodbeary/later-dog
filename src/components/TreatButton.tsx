import { useState } from "react";
import { Bone } from "lucide-react";
import { t } from "@/lib/i18n";
import { giveTreat } from "@/lib/treats";
import { cn } from "@/lib/cn";
import { messageActionClass } from "./MessageActions";

export function TreatButton({ botId, name, onTreat }: { botId: string; name: string; onTreat: () => void }) {
  const [pops, setPops] = useState<number[]>([]);
  return (
    <button
      type="button"
      onClick={() => {
        giveTreat(botId);
        onTreat();
        const id = Date.now();
        setPops((current) => [...current.slice(-2), id]);
        setTimeout(() => setPops((current) => current.filter((pop) => pop !== id)), 900);
      }}
      aria-label={t("chat.giveTreat", { name })}
      title={t("chat.giveTreat", { name })}
      className={cn(messageActionClass, "relative")}
    >
      <Bone size={14} />
      {pops.map((pop) => (
        <span key={pop} aria-hidden className="treat-pop pointer-events-none absolute -top-1 left-1/2 text-[11px] font-semibold text-accent">
          +1
        </span>
      ))}
    </button>
  );
}
