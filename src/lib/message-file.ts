import { t } from "@/lib/i18n";

export interface MessageAttachmentContext { threadId: string; messageId: string }

export async function requestMessageFile(
  filePath: string,
  message: MessageAttachmentContext,
  signal: AbortSignal,
  folder?: { entry?: string; list?: boolean },
): Promise<Response> {
  const response = await fetch(`/api/threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.messageId)}/file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: filePath,
      ...(folder?.entry !== undefined ? { entry: folder.entry } : folder?.list ? { listFolder: true } : {}),
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    throw Object.assign(new Error(body?.error ?? t("attach.downloadFailed")), { code: body?.code });
  }
  return response;
}
