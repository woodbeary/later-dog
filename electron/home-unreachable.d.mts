export declare const TRY_AGAIN_URL: string;
export declare const HOME_RETRY_DELAYS_MS: readonly number[];
export interface UnreachableTarget {
  origin: string;
  name: string;
  home?: boolean;
}
export interface HomeRetry {
  failed(target: UnreachableTarget): number;
  tryNow(): boolean;
  loaded(): void;
  stop(): void;
  failing(): string | null;
}
export declare function unreachableLine(target: { name: string; home?: boolean }): string;
export declare function unreachablePage(target: { name: string; home?: boolean }): string;
export declare function unreachablePageUrl(target: { name: string; home?: boolean }): string;
export declare function isTryAgainLink(url: string): boolean;
export declare function createHomeRetry(options: {
  reconnect(target: UnreachableTarget): unknown;
  show(url: string): unknown;
  delays?: readonly number[];
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: never) => void;
  log?: (message: string) => void;
}): HomeRetry;
