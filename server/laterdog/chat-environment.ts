import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { chatTempRoot, prepareChatTemp } from "./chat-temp.ts";
import { cloneShimEnvironment } from "./clone-shim.ts";
import { CHAT_MARK } from "./home-processes.ts";

export const ENGINE_BIN = () => join(DATA_DIR, "engine-bin");

export function chatEngineEnvironment(threadId: string, env: NodeJS.ProcessEnv = process.env, tempRoot = chatTempRoot(), shimDir = ENGINE_BIN()): Record<string, string> {
  const mark = { [CHAT_MARK]: threadId };
  if (env.LATERDOG_CLOUD_ROLE !== "home") return mark;
  return { ...mark, ...prepareChatTemp(tempRoot, threadId), ...cloneShimEnvironment(env.PATH, shimDir, process.execPath, SPAWNED_PROXIES.sharedClone) };
}
