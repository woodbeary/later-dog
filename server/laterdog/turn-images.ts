import type { Message } from "../store.ts";
import { deleteAttachment, saveImage } from "../attachments.ts";
import { decodeGeneratedImage } from "../generated-image.ts";
import { TOOL_NAMESPACE, screenTouchingTool, toolSurfaceKind } from "../../shared/tool-surface.ts";

export type TurnImageMessage = Omit<Message, "id" | "at">;

const LOOKING_TOOLS: ReadonlySet<string> = new Set(["read", "read_file", "read_media_file", "shared_computer"]);

export function postTurnImage(data: string, turnId: string | undefined, post: (message: TurnImageMessage) => unknown): void {
  const decoded = decodeGeneratedImage(data);
  const saved = saveImage(decoded.bytes, decoded.mime);
  try {
    post({
      role: "bot",
      kind: "text",
      text: "",
      attachments: [{ kind: "image", path: saved.path, mime: saved.mime }],
      ...(turnId ? { turnId } : {}),
    });
  } catch (error) {
    deleteAttachment(saved.path);
    throw error;
  }
}

export function latestTurnAnswer(messages: readonly Message[], turnId: string | undefined): Message | undefined {
  return messages.findLast((message) =>
    message.role === "bot" &&
    message.kind === "text" &&
    message.turnId === turnId &&
    Boolean(message.text?.trim()));
}

export function lookedAtImage(messages: readonly Message[], itemId: string | undefined): boolean {
  if (!itemId) return false;
  const name = messages.findLast((message) => message.kind === "activity" && message.tool?.itemId === itemId)?.tool?.name;
  if (!name) return false;
  return screenTouchingTool(name) || toolSurfaceKind(name) !== null || LOOKING_TOOLS.has(name.toLowerCase().replace(TOOL_NAMESPACE, ""));
}
