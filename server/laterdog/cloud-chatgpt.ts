import { join } from "node:path";
import { cloudHomeConfigured } from "../cloud-home.ts";
import { prepareCodexHome } from "./chatgpt-accounts.ts";

export type ChatGptSignIn = "browser" | "device-code";

export function chatgptPlanSignIn(cloudHome = cloudHomeConfigured()): ChatGptSignIn {
  return cloudHome ? "device-code" : "browser";
}

export function cloudChatGptHome(planDirectory: string, environment: Readonly<Record<string, string | undefined>> = {}): string {
  const named = environment.CODEX_HOME;
  if (named) return named;
  const home = join(planDirectory, "codex");
  prepareCodexHome(home);
  return home;
}
