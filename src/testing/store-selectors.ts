import type { Dispatch } from "react";
import type { Action, AppState } from "@/state/store";
import type { StoreActions } from "@/state/store-channel";

type MockedStore = StoreActions & { state: AppState; dispatch: Dispatch<Action> };

export async function selectorsOverMockedStore() {
  const { useStore } = await import("@/state/store");
  const held = () => useStore() as unknown as MockedStore;
  return {
    useStoreSelector: <T>(select: (state: AppState) => T): T => select(held().state),
    useStoreActions: (): StoreActions => held(),
    useStoreDispatch: (): Dispatch<Action> => held().dispatch,
    useStoreReader: () => () => held().state,
    useDrawnDogs: () => held().state.bots,
    useDogsApartFromMessages: () => held().state.bots,
    useRoomsApartFromMessages: () => held().state.groups,
  };
}
