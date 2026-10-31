import { useState } from "react";
import { Eye, LoaderCircle, RotateCcw } from "lucide-react";

import { t } from "@/lib/i18n";
import { QUICK_LOOK_MAX_BYTES, quickLookWay } from "@/lib/quick-look";
import { requestMessageFile, type MessageAttachmentContext } from "./AttachmentPreview";

const OPEN_TIMEOUT_MS = 60_000;

export function QuickLookButton({ path, name, message }: { path: string; name: string; message: MessageAttachmentContext }) {
  const [state, setState] = useState<"idle" | "opening" | "failed">("idle");
  const way = typeof window === "undefined" ? null : quickLookWay(name, window.laterdog);
  if (!way) return null;

  const open = async () => {
    if (state === "opening") return;
    const tab = way === "browser" ? window.open("about:blank", "_blank") : null;
    setState("opening");
    try {
      const response = await requestMessageFile(path, message, AbortSignal.timeout(OPEN_TIMEOUT_MS));
      if (Number(response.headers.get("content-length")) > QUICK_LOOK_MAX_BYTES) throw new Error("size");
      const blob = await response.blob();
      if (blob.size === 0 || blob.size > QUICK_LOOK_MAX_BYTES) throw new Error("size");
      if (way === "native") {
        if (!await window.laterdog?.previewFile?.(name, new Uint8Array(await blob.arrayBuffer()))) throw new Error("refused");
      } else {
        if (!tab) throw new Error("blocked");
        const url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
        tab.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), OPEN_TIMEOUT_MS);
      }
      setState("idle");
    } catch {
      tab?.close();
      setState("failed");
    }
  };

  const label = t(state === "failed" ? "quickLook.failed" : "quickLook.open", { name });
  return (
    <button type="button" className="table-action" data-quick-look={way} title={label} aria-label={label} disabled={state === "opening"} onClick={() => void open()}>
      {state === "opening" ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : state === "failed" ? <RotateCcw size={14} className="text-danger" aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
    </button>
  );
}
