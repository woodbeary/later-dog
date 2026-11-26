import type { DriverCreateInput, ProviderAdapter, SendTurnInput } from "../contracts.ts";
import type { EngineFileRoot } from "./engine-files.ts";
import type { GuestDriverRuntime } from "./guest-cli-runtime.ts";

export interface GuestProviderProfile {
  input: DriverCreateInput<unknown>;
  env?: Record<string, string>;
  runtime?: GuestDriverRuntime;
  roots?: EngineFileRoot[];
  mkdirs?: string[];
  renew?: () => Promise<string>;
}

export type GuestRequest =
  | { op: "open"; driver: string; input: DriverCreateInput<unknown>; threadId: string }
  | { op: "send"; turn: SendTurnInput }
  | { op: "interrupt"; turnId?: string }
  | { op: "answer"; requestId: string; decision: Parameters<ProviderAdapter["respondToRequest"]>[2] }
  | { op: "steer"; text: string; images?: SendTurnInput["images"] }
  | { op: "stopActor"; actor: Parameters<NonNullable<ProviderAdapter["stopNativeActor"]>>[1] }
  | { op: "renew"; token: string }
  | { op: "generate"; prompt: string; model?: string }
  | { op: "context" }
  | { op: "dispose" };
