import { chatTempRoot, prepareChatTemp } from "./chat-temp.ts";
import { CHAT_MARK } from "./home-processes.ts";

export function chatEngineEnvironment(threadId: string, env: NodeJS.ProcessEnv = process.env, tempRoot = chatTempRoot()): Record<string, string> {
  const mark = { [CHAT_MARK]: threadId };
  return env.LATERDOG_CLOUD_ROLE === "home" ? { ...mark, ...prepareChatTemp(tempRoot, threadId) } : mark;
}
