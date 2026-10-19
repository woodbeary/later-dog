import { isCloudComputerBusyMessage } from "../../shared/computer-contention";

export function isActiveTurnRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, message } = error as { status?: unknown; message?: unknown };
  if (status !== undefined && status !== 409) return false;
  return typeof message === "string" && isCloudComputerBusyMessage(message);
}
