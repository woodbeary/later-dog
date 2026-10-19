import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { waitForLocalVmReady } from "@/lib/local-vm-readiness";
import { SettingRow } from "./SettingsPrimitives";

export const LOCAL_VM_POLL_MS = 5000;
export const DOCKER_URL = "https://www.docker.com/products/docker-desktop/";

const RUNTIME_NAMES = { docker: "Docker", podman: "Podman", container: "Apple container" } as const;

export interface LocalVmStatus {
  ready: boolean;
  runtime: keyof typeof RUNTIME_NAMES | null;
  daemonUp: boolean;
  image: boolean;
  container: "running" | "stopped" | "missing";
  problem: string | null;
  imageMatches?: boolean;
  managed?: boolean;
  network?: string;
  security?: string;
  persistence?: string;
  desktop_error?: string | null;
  resumable?: boolean;
  stop_reason?: "idle" | null;
  viewer_url?: string;
  commands?: { view?: string | null };
}

type VmAction = "start" | "run" | "recreate";
type Stage = "checking" | "unavailable" | "noRuntime" | "runtimeOff" | "notSetUp" | "settingUp" | "stopped" | "starting" | "ready" | "stuck";

const pillShape = "rounded-full bg-control px-3 py-1.5 text-[13px] font-medium hover:bg-control-hover disabled:opacity-45";
export const pillButton = `${pillShape} text-ink`;
export const dangerPillButton = `${pillShape} text-danger`;

async function readStatus(signal?: AbortSignal): Promise<LocalVmStatus> {
  const response = await fetch("/api/local-computer", { signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? t("vm.err.status", { code: response.status }));
  return body as LocalVmStatus;
}

async function post(action: "pull" | "start" | "run" | "remove", signal: AbortSignal): Promise<LocalVmStatus> {
  const response = await fetch(`/api/local-computer/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? t(action === "remove" ? "vm.deleteError" : action === "start" ? "vm.err.start" : "vm.err.create"));
  signal.throwIfAborted();
  return body as LocalVmStatus;
}

function needsRebuild(status: LocalVmStatus): boolean {
  return Boolean(status.desktop_error) || status.imageMatches === false || status.managed === false
    || [status.network, status.security, status.persistence].includes("unsafe");
}

function localVmStage(status: LocalVmStatus | null, loading: boolean): Stage {
  if (loading) return "checking";
  if (!status) return "unavailable";
  if (status.ready) return "ready";
  if (!status.runtime) return "noRuntime";
  if (!status.daemonUp) return "runtimeOff";
  if (status.container === "missing") return "notSetUp";
  if (status.container === "stopped") return status.resumable === false ? "stuck" : "stopped";
  return needsRebuild(status) ? "stuck" : "starting";
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
      if (action === "recreate" && !(await confirmAction(t("settings.vm.resetConfirm")))) return;
      if (action !== "start" && status?.image === false) await post("pull", controller.signal);
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

  const stage: Stage = pending === "start" ? "starting" : pending ? "settingUp" : localVmStage(status, loading);
  const runtime = RUNTIME_NAMES[status?.runtime ?? "docker"];
  const viewer = status?.viewer_url || status?.commands?.view || null;
  const title = {
    checking: t("common.checking"),
    unavailable: t("settings.vm.unavailable"),
    noRuntime: t("settings.vm.needsDocker"),
    runtimeOff: t("settings.vm.runtimeOff", { runtime }),
    notSetUp: t("settings.vm.notSetUp"),
    settingUp: t("settings.vm.settingUp"),
    stopped: t("settings.vm.stopped"),
    starting: t("settings.vm.starting"),
    ready: t("vm.main.ready"),
    stuck: t("settings.vm.stuck"),
  }[stage];
  const hint = stage === "noRuntime" ? t("settings.vm.needsDockerHint")
    : stage === "runtimeOff" ? t("settings.vm.runtimeOffHint", { runtime })
      : stage === "notSetUp" || stage === "settingUp" ? t("settings.vm.setUpHint")
        : stage === "stopped" ? t(status?.stop_reason === "idle" ? "settings.vm.stoppedIdle" : "settings.vm.stoppedHint")
          : stage === "starting" ? t("settings.vm.startingHint")
            : stage === "stuck" ? t("settings.vm.stuckHint")
              : t("settings.vm.about");
  const button = (action: VmAction, label: string) => (
    <button type="button" onClick={() => void act(action)} disabled={loading} className={pillButton}>{label}</button>
  );
  return (
    <div data-local-vm-rows className="rounded-xl bg-card px-4">
      <div aria-live="polite" data-local-vm-status={stage}>
        <SettingRow title={title} subtitle={error ? <span role="alert" className="text-danger">{error}</span> : hint}>
          {stage === "noRuntime" && <a href={DOCKER_URL} target="_blank" rel="noreferrer" className={pillButton}>{t("settings.vm.getDocker")}</a>}
          {stage === "notSetUp" && button("run", t("settings.vm.setUp"))}
          {stage === "stopped" && button("start", t("settings.vm.start"))}
          {stage === "ready" && viewer && <a href={viewer} target="_blank" rel="noreferrer" className={pillButton}>{t("settings.vm.open")}</a>}
          {stage === "stuck" && button("recreate", t("settings.vm.reset"))}
        </SettingRow>
      </div>
      {(stage === "ready" || stage === "stopped" || stage === "starting") && pending === null && (
        <SettingRow title={t("settings.vm.reset")} subtitle={t("settings.vm.resetHint")}>
          <button type="button" onClick={() => void act("recreate")} disabled={loading} className={dangerPillButton}>{t("settings.vm.reset")}</button>
        </SettingRow>
      )}
    </div>
  );
}
