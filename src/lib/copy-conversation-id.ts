import { copyText, type CopyResult } from "./copy-text";

export function copyConversationId(threadId: string): Promise<CopyResult> {
  return copyText(threadId.trim());
}
