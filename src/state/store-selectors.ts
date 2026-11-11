import { useCallback, useContext, useRef, useSyncExternalStore, type Dispatch } from "react";
import { useStore as wholeStore, type Action, type AppState, type Bot, type Group } from "@/state/store";
import { StoreChannelContext, type StoreActions } from "@/state/store-channel";

const never = () => () => {};

export function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  return left === right || (left.length === right.length && left.every((item, index) => Object.is(item, right[index])));
}

export function sameFields<T extends object | null | undefined>(left: T, right: T): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const before = left as Record<string, unknown>;
  const after = right as Record<string, unknown>;
  const names = Object.keys(before);
  return names.length === Object.keys(after).length && names.every((name) => Object.is(before[name], after[name]));
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

export function useStoreActions(): StoreActions {
  const channel = useContext(StoreChannelContext);
  return channel ?? wholeStore();
}

export function useStoreDispatch(): Dispatch<Action> {
  return useStoreActions().dispatch;
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

const drawnDog = (bot: Bot) =>
  [bot.id, bot.name, bot.hidden, bot.color, bot.mascotBody, bot.mascotExpression, bot.avatarUrl, bot.avatarCrop, bot.avatarZoom, bot.avatarFocusX, bot.avatarFocusY].join("\u0001");

export function sameDrawnDogs(left: readonly Bot[], right: readonly Bot[]): boolean {
  return left === right || (left.length === right.length && left.every((bot, index) => bot === right[index] || drawnDog(bot) === drawnDog(right[index]!)));
}

const everyDog = (state: AppState) => state.bots;

export function useDrawnDogs(): readonly Bot[] {
  return useStoreSelector<readonly Bot[]>(everyDog, sameDrawnDogs);
}

function sameApartFromMessages<T extends { messages: unknown }>(left: T, right: T): boolean {
  if (left === right) return true;
  const names = Object.keys(left) as Array<keyof T>;
  return names.length === Object.keys(right).length && names.every((name) => name === "messages" || Object.is(left[name], right[name]));
}

function sameListApartFromMessages<T extends { messages: unknown }>(left: readonly T[], right: readonly T[]): boolean {
  return left === right || (left.length === right.length && left.every((item, index) => sameApartFromMessages(item, right[index]!)));
}

const everyRoom = (state: AppState) => state.groups;

export function useDogsApartFromMessages(): Bot[] {
  return useStoreSelector(everyDog, sameListApartFromMessages);
}

export function useRoomsApartFromMessages(): Group[] {
  return useStoreSelector(everyRoom, sameListApartFromMessages);
}
