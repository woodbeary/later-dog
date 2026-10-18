import { useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { useDesktopCapabilities } from "./DesktopCapabilities";

export function computerName(label: unknown): string | null {
  if (typeof label !== "string") return null;
  return label.trim().replace(/\.local$/i, "") || null;
}

export function ThisComputerRow() {
  const { capabilities, ready } = useDesktopCapabilities();
  const given = computerName(capabilities.host.name);
  const askServer = ready && !given && capabilities.remote !== true;
  const [served, setServed] = useState<string | null>(null);

  useEffect(() => {
    if (!askServer) return;
    let active = true;
    api<{ label?: unknown }>("/.well-known/laterdog/environment", { timeoutMs: 5_000 })
      .then((environment) => { if (active) setServed(computerName(environment.label)); })
      .catch(() => {});
    return () => { active = false; };
  }, [askServer]);

  const name = given ?? (askServer ? served : null);
  return (
    <div data-this-computer="" className="flex min-h-14 items-center gap-3 py-3">
      <Monitor size={18} aria-hidden="true" className="shrink-0 text-ink-secondary" />
      <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{name ?? t("place.local")}</span>
    </div>
  );
}
