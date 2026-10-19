import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Monitor } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import { SleepingDog } from "./AccountCharge";
import { BotAvatar } from "./Avatar";
import { dangerPillButton, pillButton } from "./LocalVmRows";

export interface CloudComputer {
  boxId: string;
  name: string;
  state: string;
  ownerBotId: string | null;
  ownerName: string | null;
  orphaned: boolean;
  inUse: boolean;
}

export interface CloudComputerList {
  configured: boolean;
  available: boolean;
  problem: string | null;
  changeable?: boolean;
  instances: CloudComputer[];
}

const DELETE_RECHECKS_MS = [1_000, 2_000, 4_000] as const;
const ASLEEP = ["archived", "stopped"];
const AWAKE = ["idle", "ready", "running"];

export function cloudComputerState(computer: CloudComputer): string {
  if (computer.inUse) return t("vm.state.inUse");
  if (computer.state === "removing") return t("vm.state.removing");
  if (ASLEEP.includes(computer.state)) return t("vm.state.sleeping");
  if (["archiving", "stopping"].includes(computer.state)) return t("vm.state.goingToSleep");
  if (AWAKE.includes(computer.state)) return t("vm.state.running");
  if (["init", "provisioning", "provisioned", "cloning", "starting"].includes(computer.state)) return t("vm.state.starting");
  return t("vm.state.attention");
}

export function mergeCloudComputers(list: CloudComputerList, previous: CloudComputer[], deleting: ReadonlySet<string>): CloudComputer[] {
  if (list.configured !== true || list.available !== true) return previous;
  return (Array.isArray(list.instances) ? list.instances : [])
    .map((computer) => deleting.has(computer.boxId) ? { ...computer, state: "removing" } : computer);
}

type Action = "delete" | "reset" | "update";

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function ComputerOwner({ computer, owner }: { computer: CloudComputer; owner: Bot | undefined }) {
  if (!owner) return <Monitor size={18} aria-hidden="true" className="w-7 shrink-0 text-ink-tertiary" />;
  if (ASLEEP.includes(computer.state) && !computer.inUse) return <SleepingDog size={28} color={owner.color} bodyId={owner.mascotBody ?? undefined} />;
  return <BotAvatar bot={owner} size={28} label="" trackPointer={false} />;
}

export function CloudComputerRows() {
  const { state } = useStore();
  const keyConfigured = state.config?.box?.configured === true;
  const [computers, setComputers] = useState<CloudComputer[]>([]);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [changeable, setChangeable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ boxId: string; action: Action } | null>(null);
  const latest = useRef<CloudComputer[]>([]);
  const deleting = useRef(new Set<string>());

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/computers/boxes", { signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? t("vm.err.cloudInventory", { code: response.status }));
    const list = body as CloudComputerList;
    const next = mergeCloudComputers(list, latest.current, deleting.current);
    for (const boxId of deleting.current) if (!next.some((computer) => computer.boxId === boxId)) deleting.current.delete(boxId);
    latest.current = next;
    setComputers(next);
    if (list.configured === true && list.available === true) setChangeable(list.changeable === true);
    setProblem(list.configured === true && list.available !== true ? list.problem ?? t("vm.err.cloudUnavailable") : null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    refresh(controller.signal)
      .catch((cause) => { if (!controller.signal.aborted) setProblem(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh, keyConfigured]);

  const remove = async (computer: CloudComputer) => {
    const subject = computer.orphaned ? t("vm.confirm.orphanCloud") : t("vm.confirm.ownedCloud", { name: computer.ownerName ?? "" });
    if (!window.confirm(t("vm.confirm.deleteCloud", { subject }))) return;
    setPending({ boxId: computer.boxId, action: "delete" });
    setError(null);
    try {
      const response = await fetch(`/api/computers/boxes/${encodeURIComponent(computer.boxId)}/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmName: computer.name }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? t("vm.cloud.deleteError"));
      deleting.current.add(computer.boxId);
      latest.current = latest.current.map((current) => current.boxId === computer.boxId ? { ...current, state: "removing" } : current);
      setComputers(latest.current);
      for (const ms of DELETE_RECHECKS_MS) {
        await wait(ms);
        await refresh().catch(() => {});
        if (!deleting.current.has(computer.boxId)) return;
      }
      deleting.current.delete(computer.boxId);
      await refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const change = async (computer: CloudComputer, action: "reset" | "update") => {
    if (!computer.ownerBotId) return;
    const name = computer.ownerName ?? computer.name;
    if (!window.confirm(t(action === "reset" ? "vm.confirm.resetCloud" : "vm.confirm.updateCloud", { name }))) return;
    setPending({ boxId: computer.boxId, action });
    setError(null);
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(computer.ownerBotId)}/computer/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? t(action === "reset" ? "vm.cloud.resetError" : "vm.cloud.updateError"));
      await refresh().catch(() => {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const spinning = (computer: CloudComputer, action: Action) =>
    pending?.boxId === computer.boxId && pending.action === action && <Loader2 size={12} className="animate-spin" />;

  return (
    <div data-cloud-computer-rows="" className="rounded-xl bg-card px-4">
      {loading && computers.length === 0 ? (
        <div className="flex items-center gap-2 border-t border-hairline/40 py-4 text-[13px] text-ink-secondary first:border-t-0">
          <Loader2 size={13} className="animate-spin" /> {t("vm.cloud.checkingList")}
        </div>
      ) : problem ? (
        <p className="border-t border-hairline/40 py-4 text-[12px] text-ink-secondary first:border-t-0">{problem}</p>
      ) : computers.length === 0 ? (
        <p className="border-t border-hairline/40 py-4 text-[12px] text-ink-secondary first:border-t-0">{t("vm.cloud.noneFound")}</p>
      ) : computers.map((computer) => {
        const title = computer.orphaned ? t("vm.cloud.orphan") : computer.ownerName ?? computer.name;
        const held = pending !== null || computer.inUse || computer.state === "removing";
        return (
          <div
            key={computer.boxId}
            role="group"
            aria-label={title}
            data-cloud-computer={computer.boxId}
            className="flex min-h-14 items-center gap-3 border-t border-hairline/40 py-3 first:border-t-0"
          >
            <ComputerOwner computer={computer} owner={computer.ownerBotId ? state.bots.find((bot) => bot.id === computer.ownerBotId) : undefined} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-medium text-ink">{title}</div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
                {computer.inUse ? `${cloudComputerState(computer)} · ${t("vm.cloud.stopFirst")}` : cloudComputerState(computer)}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {computer.orphaned || !computer.ownerBotId ? (
                <button
                  type="button"
                  data-cloud-computer-delete={computer.boxId}
                  onClick={() => void remove(computer)}
                  disabled={held}
                  title={t("vm.cloud.deleteTitle")}
                  className={`${dangerPillButton} flex items-center gap-1.5`}
                >
                  {spinning(computer, "delete")}
                  {t("common.delete")}
                </button>
              ) : changeable && (
                <>
                  <button
                    type="button"
                    data-cloud-computer-update={computer.boxId}
                    onClick={() => void change(computer, "update")}
                    disabled={held}
                    title={t("vm.cloud.updateTitle")}
                    className={`${pillButton} flex items-center gap-1.5`}
                  >
                    {spinning(computer, "update")}
                    {t("vm.cloud.update")}
                  </button>
                  <button
                    type="button"
                    data-cloud-computer-reset={computer.boxId}
                    onClick={() => void change(computer, "reset")}
                    disabled={held}
                    title={t("vm.cloud.resetTitle")}
                    className={`${dangerPillButton} flex items-center gap-1.5`}
                  >
                    {spinning(computer, "reset")}
                    {t("vm.cloud.reset")}
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
      {error && <p role="alert" className="border-t border-hairline/40 py-3 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
