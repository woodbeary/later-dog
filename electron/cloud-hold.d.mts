export declare const CLOUD_HOLD_ROUTE: string;
export declare const HOLD_RETRY_MS: readonly number[];
export interface MacHold {
  set(held: boolean): Promise<void>;
  flush(): Promise<void>;
  held(): boolean;
  wanted(): boolean | null;
  close(): void;
}
export declare function createMacHold(options: {
  request(route: string, init: RequestInit): Promise<Response>;
  log?: (message: string) => void;
  retryMs?: readonly number[];
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: never) => void;
}): MacHold;
