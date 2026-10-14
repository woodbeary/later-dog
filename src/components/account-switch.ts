import type { InstanceInfo, ModelSelection } from "@/state/store";

export function modelForAccount(selection: ModelSelection, account: InstanceInfo): string | undefined {
  return [selection.model, account.models.default].find((id) => id && account.models.options.some((option) => option.id === id))
    ?? account.models.options.find((option) => !option.custom)?.id
    ?? account.models.default;
}
