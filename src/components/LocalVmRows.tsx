import { useEffect, useRef, useState } from "react";
import { Check, Circle, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { waitForLocalVmReady } from "@/lib/local-vm-readiness";
import { SettingRow } from "./SettingsPrimitives";

export const LOCAL_VM_POLL_MS = 5000;

export interface LocalVmStatus {
  ready: boolean;
  container: "running" | "stopped" | "missing";
  problem: string | null;
  resumable?: boolean;
  stop_reason?: "idle" | null;
  viewer_url?: string;
  commands?: { view?: string | null };
}

type VmAction = "start" | "run" | "recreate";

export const pillButton = "rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-45";

async function readStatus(signal?: AbortSignal): Promise<LocalVmStatus> {
  const response = await fetch("/api/local-computer", { signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? t("vm.err.status", { code: response.status }));
  return body as LocalVmStatus;
}

async function post(action: "start" | "run" | "remove", signal: AbortSignal): Promise<LocalVmStatus> {
  const response = await fetch(`/api/local-computer/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? t(action === "remove" ? "vm.deleteError" : action === "run" ? "vm.err.create" : "vm.err.start"));
  signal.throwIfAborted();
  return body as LocalVmStatus;
}

export function localVmStatusLabel(status: LocalVmStatus | null, loading: boolean): string {
  if (loading) return t("common.checking");
  if (!status) return t("vm.main.statusUnavailable");
  if (status.ready) return t("vm.main.ready");
  return status.problem ?? t("vm.main.notReady");
}

export function LocalVmRows() {
  const [status, setStatus] = useState<LocalVmStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<VmAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const actionController = useRef<AbortController | null>(null);
  useEffect(() => () => actionController.current?.abort(), []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller = new AbortController();
      try {
        const next = await readStatus(controller.signal);
        if (active) { setStatus(next); setError(null); }
      } catch (e) {
        if (active && !(e instanceof DOMException && e.name === "AbortError")) {
          setStatus(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (active) {
          setLoading(false);
          timer = window.setTimeout(() => void poll(), LOCAL_VM_POLL_MS);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refreshKey]);

  const confirmAction = (message: string) => window.laterdog?.confirm ? window.laterdog.confirm(message) : window.confirm(message);

  const act = async (action: VmAction) => {
    if (pending !== null || actionController.current) return;
    const controller = new AbortController();
    actionController.current = controller;
    setPending(action);
    setError(null);
    try {
      if (action === "recreate" && !(await confirmAction(t("vm.confirm.recreate")))) return;
      if (action === "recreate") await post("remove", controller.signal);
      let result = await post(action === "start" ? "start" : "run", controller.signal);
      setStatus(result);
      result = await waitForLocalVmReady(result, async () => {
        const next = await readStatus(controller.signal);
        setStatus(next);
        return next;
      }, controller.signal);
      if (!result.ready) throw new Error(result.problem ?? t("vm.err.start"));
      setRefreshKey((key) => key + 1);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      actionController.current = null;
      if (!controller.signal.aborted) setPending(null);
    }
  };

  const ready = status?.ready === true;
  const stopped = status?.container === "stopped" && status.resumable !== false;
  const waiting = pending !== null && status?.container === "running" && !ready;
  const viewer = status?.viewer_url || status?.commands?.view || null;
  return (
    <div data-local-vm-rows className="rounded-xl bg-card px-4">
      <SettingRow
        title={t("settings.vm.status")}
        subtitle={error
          ? <span role="alert" className="text-danger">{error}</span>
          : stopped ? t(status.stop_reason === "idle" ? "vm.stopped.idle" : "vm.stopped.detail") : undefined}
      >
        <span
          aria-live="polite"
          data-local-vm-status={loading ? "checking" : ready ? "ready" : "not-ready"}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px]",
            ready ? "bg-success/15 text-success" : "bg-control text-ink-secondary",
          )}
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : ready ? <Check size={12} /> : <Circle size={9} />}
          {waiting ? t("vm.setup.waiting") : localVmStatusLabel(status, loading)}
        </span>
      </SettingRow>
      <SettingRow title={t("settings.vm.actions")} subtitle={t("settings.vm.actionsHint")}>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {ready && viewer && (
            <a href={viewer} target="_blank" rel="noreferrer" className={pillButton}>{t("settings.vm.open")}</a>
          )}
          {(stopped || pending === "start") && (
            <button type="button" onClick={() => void act("start")} disabled={loading || pending !== null} aria-busy={pending === "start"} className={pillButton}>
              {t(pending === "start" ? "vm.setup.starting" : "vm.setup.start")}
            </button>
          )}
          <button
            type="button"
            onClick={() => void act(status?.container === "missing" ? "run" : "recreate")}
            disabled={loading || pending !== null}
            aria-busy={pending === "run" || pending === "recreate"}
            className={pillButton}
          >
            {pending === "run" || pending === "recreate" ? t("settings.vm.working") : status?.container === "missing" ? t("settings.vm.create") : t("settings.vm.reset")}
          </button>
        </div>
      </SettingRow>
    </div>
  );
}
