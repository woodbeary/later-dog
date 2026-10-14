import type { CloudAccountState } from "./cloud-account.mjs";

export declare function readyHome(state: CloudAccountState | null | undefined): { origin: string } | null;
export declare function enterHomeNow(input: { state: CloudAccountState | null | undefined; activeOrigin: string | null | undefined; enteredOrigin: string | null | undefined }): boolean;
export declare function leaveHomeNow(input: { state: CloudAccountState | null | undefined; homeEntry: { id: string } | null | undefined; environments: { activeId: string } }): boolean;
export declare function hasCloudAccount(state: CloudAccountState | null | undefined): boolean;
export declare function showsServerMenu(state: CloudAccountState | null | undefined): boolean;
export declare function parseOffer(raw: unknown): { answeredAt: number; answer: "signed-in" | "not-now" } | null;
export interface CloudOffer { due(): boolean; decline(): void; signedIn(): void }
export declare function createCloudOffer(options: { read(): unknown; write(contents: string): void; now?: () => number }): CloudOffer;
