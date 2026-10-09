// What a dog has made in its open conversation, for the editor's Library tab.
import { attachmentBasename } from "@/lib/composer-attachments";
import { visibleMessages, type Bot } from "@/state/store";
import { collectMessageFiles, splitMessageAttachments } from "../AttachmentGallery";

export interface LibraryItem {
  key: string;
  name: string;
  kind: "image" | "file";
  at: number;
  messageId: string;
}

/** Images and files the dog attached, plus local files its replies link
 * to — the same set the chat's attachment gallery shows under each
 * message. Newest first. */
export function botLibraryItems(bot: Bot): LibraryItem[] {
  const groups: LibraryItem[][] = [];
  const seen = new Set<string>();
  for (const message of [...visibleMessages(bot)].reverse()) {
    const items: LibraryItem[] = [];
    groups.push(items);
    if (message.role !== "bot" || message.kind !== "text") continue;
    const attached = splitMessageAttachments(message.attachments);
    const files = [
      ...attached.files,
      ...collectMessageFiles(message.text ?? "", [...attached.images, ...attached.files.map((file) => file.path)]),
    ];
    const add = (path: string, name: string, kind: LibraryItem["kind"]) => {
      if (seen.has(path)) return;
      seen.add(path);
      items.push({ key: `${message.id}:${path}`, name, kind, at: message.at, messageId: message.id });
    };
    for (const image of attached.images) add(image, attachmentBasename(image), "image");
    for (const file of files) add(file.path, file.name || attachmentBasename(file.path), "file");
  }
  // Newest message first; a message's own files keep the order it gave them.
  return groups.flat();
}
