import type { Message } from "@/state/store";
import { isStatusActivity } from "./activity-runs";

export function standingNotice(message: Message): boolean {
  const tool = message.kind === "activity" ? message.tool : undefined;
  return Boolean(tool?.carry && !tool.quota && !tool.resume && !tool.pickup && isStatusActivity(message));
}
