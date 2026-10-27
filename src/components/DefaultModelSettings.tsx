import { useState } from "react";
import { api, useStore, type ConfigStatus, type InstanceInfo, type ModelSelection } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";
import { effortLevelsFor, effortName } from "@/lib/model-friendly";
import { t } from "@/lib/i18n";
import { SettingRow } from "./SettingsPrimitives";

const SELECT_CLASS = "min-h-8 w-full max-w-[240px] rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink focus:border-focus disabled:cursor-wait disabled:opacity-50";

export function readyAccounts(instances: readonly InstanceInfo[]): InstanceInfo[] {
  return instances.filter((instance) => instance.snapshot.state === "available" && instance.snapshot.authenticated !== false && !instance.policy);
}

export function pickKey(selection: Pick<ModelSelection, "instanceId" | "model">): string {
  return `${selection.instanceId}\u0000${selection.model}`;
}

export function selectionForPick(instances: readonly InstanceInfo[], key: string): ModelSelection | undefined {
  const [instanceId, model] = key.split("\u0000");
  const instance = instances.find((candidate) => candidate.instanceId === instanceId);
  const option = instance?.models.options.find((candidate) => candidate.id === model);
  if (!instance || !option) return undefined;
  const levels = effortLevelsFor(instance, model);
  const effort = option.defaultEffort && levels.includes(option.defaultEffort) ? option.defaultEffort : undefined;
  return effort ? { instanceId, model, effort } : { instanceId, model };
}

export function DefaultModelRow() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const accounts = readyAccounts(state.instances);
  const current = state.config?.defaultModelSelection;
  if (!accounts.length) return null;
  const instance = accounts.find((candidate) => candidate.instanceId === current?.instanceId);
  const option = instance?.models.options.find((candidate) => candidate.id === current?.model);
  const levels = instance && option ? effortLevelsFor(instance, option.id) : [];

  const save = async (next: ModelSelection) => {
    setSaving(true);
    setFailed(false);
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PATCH", body: JSON.stringify({ defaultModelSelection: next }) });
      dispatch({ type: "configStatus", config });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      title={t("settings.defaultModel.title")}
      subtitle={t("settings.defaultModel.subtitle")}
      message={failed && <span role="alert" className="text-danger">{t("settings.defaultModel.error")}</span>}
    >
      <div className="flex w-full max-w-[240px] flex-col gap-1.5">
        <select
          aria-label={t("settings.defaultModel.title")}
          value={current && option ? pickKey(current) : ""}
          disabled={saving}
          onChange={(event) => {
            const next = selectionForPick(accounts, event.target.value);
            if (next) void save(next);
          }}
          className={SELECT_CLASS}
        >
          {!option && <option value="">{t("settings.defaultModel.none")}</option>}
          {accounts.map((account) => (
            <optgroup key={account.instanceId} label={account.displayName}>
              {account.models.options.map((model) => (
                <option key={model.id} value={pickKey({ instanceId: account.instanceId, model: model.id })}>{model.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {current && levels.length > 0 && (
          <select
            aria-label={t("settings.defaultModel.effort")}
            value={current.effort ?? option?.defaultEffort ?? ""}
            disabled={saving}
            onChange={(event) => void save({ instanceId: current.instanceId, model: current.model, effort: event.target.value as EffortLevel })}
            className={SELECT_CLASS}
          >
            {levels.map((level) => (
              <option key={level} value={level}>{effortName(level, instance?.driverKind)}</option>
            ))}
          </select>
        )}
      </div>
    </SettingRow>
  );
}
