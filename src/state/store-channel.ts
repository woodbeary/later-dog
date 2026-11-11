import { createContext, type Dispatch } from "react";
import type { Action, AppState } from "@/state/store";

export interface StoreChannel {
  read(): AppState;
  listen(heard: () => void): () => void;
  dispatch: Dispatch<Action>;
}

export interface StoreFeed {
  read(): AppState;
  listen(heard: () => void): () => void;
  publish(state: AppState): void;
  announce(): void;
}

export const StoreChannelContext = createContext<StoreChannel | null>(null);

export function createStoreFeed(first: AppState): StoreFeed {
  let current = first;
  let announced = first;
  const listeners = new Set<() => void>();
  return {
    read: () => current,
    listen: (heard) => {
      listeners.add(heard);
      return () => {
        listeners.delete(heard);
      };
    },
    publish: (state) => {
      current = state;
    },
    announce: () => {
      if (announced === current) return;
      announced = current;
      for (const heard of [...listeners]) heard();
    },
  };
}
