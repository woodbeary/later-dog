import { splitTranscriptCitations } from "./citations";
import {
  attachmentBasename,
  fileAttachment,
  isPrivateAttachmentPath,
  splitTranscriptAttachments,
  type Attachment,
  type ImageAttachment,
  type TranscriptFileAttachment,
  type TranscriptImageAttachment,
} from "./composer-attachments";
import { appendDraftAttachments, draftAttachments, prependComposerDraft } from "./drafts";

const UPLOADED_IMAGE_MIMES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export type EditableMessage = {
  text: string;
  attachments: Attachment[];
};

export function uploadedImageMime(path: string): string | null {
  if (!isPrivateAttachmentPath(path)) return null;
  const extension = attachmentBasename(path).split(".").at(-1)?.toLowerCase() ?? "";
  return UPLOADED_IMAGE_MIMES[extension] ?? null;
}

function sentAttachment(kind: "image" | "file", path: string): boolean {
  return kind === "file" || uploadedImageMime(path) !== null;
}

export function editableMessage(sent: string): EditableMessage {
  const cited = splitTranscriptCitations(sent);
  const attached = splitTranscriptAttachments(cited.display, true, false, sentAttachment);
  return {
    text: attached.display,
    attachments: [
      ...cited.citations,
      ...attached.images.map((image): ImageAttachment => ({
        ...fileAttachment(image.name, image.path, 0),
        kind: "image",
        mime: uploadedImageMime(image.path)!,
      })),
      ...attached.files.map((file) => fileAttachment(file.name, file.path, 0)),
    ],
  };
}

export function editableGallery(attachments: readonly Attachment[]): {
  images: TranscriptImageAttachment[];
  files: TranscriptFileAttachment[];
} {
  const shown = (attachment: { path: string; name: string }) => ({
    path: attachment.path,
    name: attachment.name,
    ...(isPrivateAttachmentPath(attachment.path) ? { private: true } : {}),
  });
  return {
    images: attachments.flatMap((attachment) => attachment.kind === "image" ? [shown(attachment)] : []),
    files: attachments.flatMap((attachment) => attachment.kind === "file" ? [shown(attachment)] : []),
  };
}

function identity(attachment: Attachment): string {
  return attachment.kind === "image" || attachment.kind === "file"
    ? `${attachment.kind}:${attachment.path}`
    : `${attachment.kind}:${attachment.id}`;
}

export function restoreEditableMessage(draftId: string, message: EditableMessage): void {
  if (message.text) prependComposerDraft(draftId, message.text);
  const present = new Set(draftAttachments(draftId).map(identity));
  appendDraftAttachments(draftId, message.attachments.filter((attachment) => {
    const key = identity(attachment);
    if (present.has(key)) return false;
    present.add(key);
    return true;
  }));
}
