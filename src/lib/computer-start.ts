import type { ServerFrame } from "../../shared/wire";

export type ComputerStart = Pick<Extract<ServerFrame, { kind: "computer" }>, "state" | "place">;
