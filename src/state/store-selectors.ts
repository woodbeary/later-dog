import { useCallback, useContext, useRef, useSyncExternalStore, type Dispatch } from "react";
import { useStore as wholeStore, type Action, type AppState, type Bot } from "@/state/store";
import { StoreChannelContext } from "@/state/store-channel";

const never = () => () => {};

export function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  return left === right || (left.length === right.length && left.every((item, index) => Object.is(item, right[index])));
}

export function sameFields<T extends object | null | undefined>(left: T, right: T): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const names = Object.keys(left) as Array<keyof typeof left>;
  return names.length === Object.keys(right).length && names.every((name) => Object.is(left[name], right[name]));
}

export function useStoreSelector<T>(select: (state: AppState) => T, same: (left: T, right: T) => boolean = Object.is): T {
  const channel = useContext(StoreChannelContext);
  const whole = channel ? null : wholeStore().state;
  const held = useRef<{ state: AppState; select: (state: AppState) => T; value: T } | null>(null);
  const snapshot = () => {
    const state = channel ? channel.read() : whole!;
    const last = held.current;
    if (last && last.state === state && last.select === select) return last.value;
    const picked = select(state);
    const value = last && same(last.value, picked) ? last.value : picked;
    held.current = { state, select, value };
    return value;
  };
  return useSyncExternalStore(channel ? channel.listen : never, snapshot, snapshot);
}

export function useStoreDispatch(): Dispatch<Action> {
  const channel = useContext(StoreChannelContext);
  return channel ? channel.dispatch : wholeStore().dispatch;
}

export function useStoreReader(): () => AppState {
  const channel = useContext(StoreChannelContext);
  const whole = useRef<AppState | null>(null);
  whole.current = channel ? null : wholeStore().state;
  return useCallback(() => channel ? channel.read() : whole.current!, [channel]);
}

const dogsById = new WeakMap<readonly Bot[], Map<string, Bot>>();

export function dogIn(state: Pick<AppState, "bots">, botId: string): Bot | undefined {
  let byId = dogsById.get(state.bots);
  if (!byId) {
    byId = new Map(state.bots.map((bot) => [bot.id, bot]));
    dogsById.set(state.bots, byId);
  }
  return byId.get(botId);
}
