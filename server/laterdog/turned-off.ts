import type { ProviderInstance } from "../contracts.ts";

export class AccountTurnedOff extends Error {
  readonly status = 409;
  readonly code = "account_off";
  constructor(name: string) {
    super(`${name} is turned off`);
  }
}

const withOwn = <T extends object>(base: T, own: Partial<T>): T =>
  Object.create(Object.getPrototypeOf(base), { ...Object.getOwnPropertyDescriptors(base), ...Object.getOwnPropertyDescriptors(own) }) as T;

export function refusedWhileOff(instance: ProviderInstance): ProviderInstance {
  if (instance.enabled) return instance;
  const name = instance.displayName?.trim() || instance.instanceId;
  const adapter = withOwn(instance.adapter, { sendTurn: async () => { throw new AccountTurnedOff(name); } });
  return withOwn(instance, { adapter });
}
