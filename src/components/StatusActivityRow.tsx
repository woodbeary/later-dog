import { ArrowRight, Info, RefreshCw } from "lucide-react";
import { statusActivity } from "@/lib/activity-runs";
import { useEffect, useState } from "react";
import { useStore, type Message } from "@/state/store";

import { RechargeLine, SleepingDog, rechargeProgress } from "./AccountCharge";
import { InstanceProviderMark } from "./ProviderIcons";

function CarriedAccount({ from, to, text }: { from: string; to: string; text: string }) {
  const { state } = useStore();
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  const rest = state.config?.accountBattery?.resting?.[from];
  const active = state.instances.find((instance) => instance.instanceId === to);
  return <div role="status" data-account-carry className="flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink-secondary">
    {rest && Date.parse(rest.until) > now && <><SleepingDog size={20} /><RechargeLine progress={rest.estimated ? null : rechargeProgress(rest, now)} /></>}
    <ArrowRight size={13} aria-hidden="true" />{active && <InstanceProviderMark instance={active} size={15} />}
    <span className="min-w-0 break-words">{text}</span>
  </div>;
}

export function StatusActivityRow({ message }: { message: Message }) {
  const status = statusActivity(message);
  if (!status) return null;
  if (message.tool?.carry) return <CarriedAccount {...message.tool.carry} text={status.text} />;
  const Icon = status.kind === "recovery" ? RefreshCw : Info;
  return (
    <div role="status" className="flex w-fit max-w-full items-start gap-2 rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink-secondary">
      <Icon size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">{status.text}</span>
    </div>
  );
}
