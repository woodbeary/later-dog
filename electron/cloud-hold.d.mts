export declare const CLOUD_HOLD_ROUTE: string;
export interface MacHold {
  set(held: boolean): Promise<void>;
  flush(): Promise<void>;
  held(): boolean;
  wanted(): boolean | null;
}
export declare function createMacHold(options: { request(route: string, init: RequestInit): Promise<Response>; log?: (message: string) => void }): MacHold;
