import { useEffect, useState } from "react";
import { useCloudMove } from "@/components/CloudMove";
import { cloudAccountBridge, useCloudAccount } from "@/lib/cloud-account-view";
import { DONE_LINE_MS, moveLine } from "@/lib/cloud-move-line";
import { t } from "@/lib/i18n";

const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

export function CloudQuietLine() {
  const moveBridge = window.laterdog?.remoteClient?.active ? undefined : window.laterdog?.cloudMove;
  const move = useCloudMove(moveBridge);
  const accountBridge = window.laterdog?.remoteClient !== undefined ? cloudAccountBridge() : undefined;
  const { account, accept } = useCloudAccount(accountBridge);
  const [retrying, setRetrying] = useState(false);
  const line = moveLine(move.overview, move.state);
  const { run } = move;

  useEffect(() => {
    if (line?.kind !== "done") return;
    const timer = setTimeout(() => run("dismiss"), DONE_LINE_MS);
    return () => clearTimeout(timer);
  }, [line?.kind]);

  let text: string | null = null;
  let action: { label: string; onClick: () => void } | null = null;
  if (line) {
    if (line.kind === "moving") text = line.percent === null ? t("cloudMoveLine.moving") : t("cloudMoveLine.movingPercent", { percent: line.percent });
    else if (line.kind === "finishing") text = t("cloudMoveLine.finishing");
    else if (line.kind === "done") { text = t("cloudMoveLine.done"); action = { label: t("cloudMoveLine.ok"), onClick: () => run("dismiss") }; }
    else if (line.kind === "kept") { text = t("cloudMoveLine.kept"); action = { label: t("cloudMoveLine.ok"), onClick: () => run("dismiss") }; }
    else {
      text = t("cloudMoveLine.failed");
      if (line.retry) action = { label: t("cloudMoveLine.retry"), onClick: () => run("start") };
    }
  } else if (account?.fellBack && accountBridge) {
    text = t("cloudHomeNotice.unreachable");
    action = {
      label: t("cloudMoveLine.retry"),
      onClick: () => {
        if (retrying) return;
        setRetrying(true);
        void accountBridge.connectHome().then(accept).catch(() => {}).finally(() => setRetrying(false));
      },
    };
  }
  if (text === null) return null;
  return (
    <div role="status" data-cloud-quiet-line={line?.kind ?? "home-unreachable"} style={noDrag}
      className="fixed left-1/2 top-3 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full border border-hairline/40 bg-panel px-4 py-1.5 text-[12.5px] text-ink-secondary shadow-lg shadow-black/10">
      <span className="min-w-0 truncate">{text}</span>
      {action && <button type="button" disabled={move.pending || retrying} onClick={action.onClick} className="shrink-0 font-medium text-ink hover:underline disabled:opacity-50">{action.label}</button>}
    </div>
  );
}
