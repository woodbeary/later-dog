import { CHAT_MARK } from "./home-processes.ts";

export function chatEngineEnvironment(threadId: string): Record<string, string> {
  return { [CHAT_MARK]: threadId };
}
