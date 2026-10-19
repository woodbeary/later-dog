import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AppLink } from "../../shared/app-link";
import { appLinkFromBridge, appLinkStep } from "@/lib/app-link-route";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";

export function AppLinkHost() {
  const { state, dispatch } = useStore();
  const [pending, setPending] = useState<{ link: AppLink } | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => window.laterdog?.onAppLink?.((url) => {
    const link = appLinkFromBridge(url);
    if (link) setPending({ link });
  }), []);

  useEffect(() => {
    if (!pending || !state.hydrated) return;
    setPending(null);
    const step = appLinkStep(pending.link, state);
    if (step.kind === "settings") {
      setNotFound(false);
      dispatch({ type: "toggleAppSettings", open: true, section: step.section });
      return;
    }
    if (step.kind === "notFound") {
      setNotFound(true);
      return;
    }
    setNotFound(false);
    if (state.appSettingsOpen) dispatch({ type: "toggleAppSettings", open: false });
    dispatch({ type: "select", id: step.id });
  }, [pending, state, dispatch]);

  return <NotFoundDialog open={notFound} onClose={() => setNotFound(false)} />;
}

export function NotFoundDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") close.current();
      else closeRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected && opener !== document.body) opener.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="app-link-not-found-title"
        aria-describedby="app-link-not-found-body"
        className="w-full max-w-[400px] rounded-sheet border border-hairline/50 bg-panel p-5 shadow-modal"
      >
        <h2 id="app-link-not-found-title" className="text-[15px] font-semibold text-ink">
          {t("appLink.notFound.title")}
        </h2>
        <p id="app-link-not-found-body" className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
          {t("appLink.notFound.body")}
        </p>
        <div className="mt-5 flex justify-end">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-app hover:opacity-90"
          >
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
