import { api, type Action, type Message } from "@/state/store";
import { chatPane } from "@/state/pane-errors";
import { t } from "@/lib/i18n";
import { OPTIMISTIC_PREFIX } from "@/lib/dog-status";
import { toggledReactions } from "@/lib/reactions";

export function canReactTo(message: Pick<Message, "id">): boolean {
  return !message.id.startsWith(OPTIMISTIC_PREFIX);
}

export async function reactToMessage(
  dispatch: (action: Action) => void,
  threadId: string,
  message: Pick<Message, "id" | "reactions">,
  emoji: string,
): Promise<boolean> {
  if (!canReactTo(message)) return false;
  const messageId = message.id;
  const before = message.reactions;
  dispatch({ type: "reactionsSet", threadId, messageId, reactions: toggledReactions(before, emoji) });
  try {
    const { message: saved } = await api<{ message?: Message }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/reactions`,
      { method: "POST", body: JSON.stringify({ emoji }) },
    );
    if (saved) dispatch({ type: "reactionsSet", threadId, messageId, reactions: saved.reactions });
    return true;
  } catch {
    dispatch({ type: "reactionsSet", threadId, messageId, reactions: before });
    dispatch({ type: "reportError", error: null, pane: chatPane(threadId), line: t("chat.reaction.failed") });
    return false;
  }
}
