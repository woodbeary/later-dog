import { api } from "@/state/store";

export async function startNewConversation(botId: string): Promise<string> {
  const created = await api<{ task: { threadId: string } }>(`/api/bots/${encodeURIComponent(botId)}/tasks`, { method: "POST", body: "{}" });
  return created.task.threadId;
}
