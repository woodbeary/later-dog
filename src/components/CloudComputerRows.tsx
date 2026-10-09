import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { CloudComputersRow } from "./ApiKeys";
import { pillButton } from "./LocalVmRows";
import { SettingRow } from "./SettingsPrimitives";

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
  instances: CloudComputer[];
}

const DELETE_RECHECKS_MS = [1_000, 2_000, 4_000] as const;

export function cloudComputerState(computer: CloudComputer): string {
  if (computer.inUse) return t("vm.state.inUse");
  if (computer.state === "removing") return t("vm.state.removing");
  if (["archived", "stopped"].includes(computer.state)) return t("vm.state.sleeping");
  if (["archiving", "stopping"].includes(computer.state)) return t("vm.state.goingToSleep");
  if (["idle", "ready", "running"].includes(computer.state)) return t("vm.state.running");
  if (["init", "provisioning", "provisioned", "cloning", "starting"].includes(computer.state)) return t("vm.state.starting");
  return t("vm.state.attention");
}

export function mergeCloudComputers(list: CloudComputerList, previous: CloudComputer[], deleting: ReadonlySet<string>): CloudComputer[] {
  if (list.configured !== true || list.available !== true) return previous;
  return (Array.isArray(list.instances) ? list.instances : [])
    .map((computer) => deleting.has(computer.boxId) ? { ...computer, state: "removing" } : computer);
}

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function CloudComputerRows() {
  const keyConfigured = useStore().state.config?.box?.configured === true;
  const [computers, setComputers] = useState<CloudComputer[]>([]);
  const [listed, setListed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
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
    setListed(list.configured === true && list.available === true);
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
    setPending(computer.boxId);
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

  return (
    <div data-cloud-computer-rows="" className="rounded-xl bg-card px-4">
      <div className="py-4"><CloudComputersRow /></div>
      {loading && computers.length === 0 ? (
        <div className="flex items-center gap-2 border-t border-hairline/40 py-4 text-[13px] text-ink-secondary">
          <Loader2 size={13} className="animate-spin" /> {t("vm.cloud.checkingList")}
        </div>
      ) : problem ? (
        <p className="border-t border-hairline/40 py-4 text-[12px] text-ink-secondary">{problem}</p>
      ) : listed && computers.length === 0 ? (
        <p className="border-t border-hairline/40 py-4 text-[12px] text-ink-secondary">{t("vm.cloud.noneFound")}</p>
      ) : computers.map((computer) => (
        <SettingRow
          key={computer.boxId}
          title={computer.orphaned ? t("vm.cloud.orphan") : computer.ownerName ?? computer.name}
          subtitle={computer.inUse ? `${cloudComputerState(computer)} · ${t("vm.cloud.stopFirst")}` : cloudComputerState(computer)}
        >
          <button
            type="button"
            data-cloud-computer-delete={computer.boxId}
            onClick={() => void remove(computer)}
            disabled={pending !== null || computer.inUse || computer.state === "removing"}
            title={t("vm.cloud.deleteTitle")}
            className={`${pillButton} flex items-center gap-1.5 text-danger`}
          >
            {pending === computer.boxId && <Loader2 size={12} className="animate-spin" />}
            {t("common.delete")}
          </button>
        </SettingRow>
      ))}
      {error && <p role="alert" className="border-t border-hairline/40 py-3 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
