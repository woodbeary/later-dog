import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClipboardPaste, File as FileIcon, LoaderCircle, MessageSquareText, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  attachmentImageUrl,
  intakeFiles,
  formatSize,
  pasteSummary,
  type Attachment,
  type PasteAttachment,
} from "@/lib/composer-attachments";
import { joinNotices } from "@/lib/picture-limit";
import { AttachmentPreviewDialog, previewImage, type PreviewImage } from "./AttachmentPreview";
import { CitationBadge } from "./CitationUI";
import type { CitationAttachment } from "@/lib/citations";

/** Electron 32 removed File.path — only the preload can name a file. */
export function pathForFile(file: File): string {
  return window.laterdog?.getPathForFile?.(file) ?? "";
}

/** Renders pending attachments and their composer actions. */
export function ComposerAttachments({
  items,
  onAdd,
  onRemove,
  onChangeCitation,
  onDisplayInChatBox,
  allowImages = true,
  notice,
  onNotice,
  onPendingChange,
  uploadImage,
  admitFiles,
}: {
  items: Attachment[];
  onAdd: (attachments: Attachment[]) => void;
  onRemove: (id: string) => void;
  onChangeCitation: (citation: CitationAttachment) => void;
  onDisplayInChatBox: (attachment: PasteAttachment) => void;
  allowImages?: boolean;
  notice: string | null;
  onNotice: (notice: string | null) => void;
  onPendingChange?: (pending: boolean) => void;
  uploadImage: (file: File) => Promise<Attachment | null>;
  admitFiles?: (files: File[]) => { files: File[]; notice: string | null };
}) {
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<PreviewImage | null>(null);
  // dragenter/dragleave fire once per element crossed, so the overlay
  // tracks depth rather than the last event it happened to see
  const depth = useRef(0);
  const callbacks = useRef({ onAdd, onNotice, onPendingChange, allowImages, uploadImage, admitFiles });
  callbacks.current = { onAdd, onNotice, onPendingChange, allowImages, uploadImage, admitFiles };
  const pendingDrops = useRef(new Set<symbol>());

  useEffect(() => {
    const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current += 1;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    // without preventDefault the window navigates to the dropped file and
    // the app is simply gone
    const onOver = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const dropped = Array.from(e.dataTransfer?.files ?? []);
      const admitted = callbacks.current.admitFiles?.(dropped) ?? { files: dropped, notice: null };
      // Same intake the attach button uses: a dropped file and a picked one
      // must not appear in a different order.
      const operation = Symbol("attachment-drop");
      pendingDrops.current.add(operation);
      callbacks.current.onPendingChange?.(true);
      try {
        const { attachments, notice: message } = await intakeFiles(admitted.files, {
          allowImages: callbacks.current.allowImages,
          getPath: pathForFile,
          uploadImage: callbacks.current.uploadImage,
        });
        if (attachments.length) callbacks.current.onAdd(attachments);
        const shown = joinNotices(admitted.notice, message);
        if (shown) callbacks.current.onNotice(shown);
      } finally {
        if (pendingDrops.current.delete(operation)) callbacks.current.onPendingChange?.(false);
      }
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return (
    <>
      {dragging && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-10">
          <div className="rounded-2xl border-2 border-dashed border-accent/70 bg-panel/90 px-8 py-6 text-[14px] font-medium text-ink shadow-2xl">
            Drop to attach
          </div>
        </div>,
        document.body,
      )}

      {notice && (
        <div role="status" className="flex items-start gap-2 px-1 pb-1.5 pt-0.5 text-[12px] text-warning">
          <span className="min-w-0 flex-1">{notice}</span>
          <button
            type="button"
            onClick={() => onNotice(null)}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 hover:bg-control"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {items.length > 0 && (
        <div role="list" aria-label="Attachments" data-composer-attachments className="flex items-center gap-2 overflow-x-auto px-1 pb-2 pt-1">
          {items.map((a) =>
            a.kind === "citation" ? (
              <div key={a.id} role="listitem" className="shrink-0">
                <CitationBadge
                  citation={a}
                  onChange={onChangeCitation}
                  onRemove={() => onRemove(a.id)}
                />
              </div>
            ) : a.kind === "paste" ? (
              <div key={a.id} role="listitem" title={a.text.slice(0, 4000)} className={chipClass("w-[200px] gap-2 pl-3 pr-7")}>
                <ClipboardPaste size={16} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="truncate text-[12px] text-ink">{pasteSummary(a)}</div>
                  <button
                    type="button"
                    onClick={() => onDisplayInChatBox(a)}
                    className="flex max-w-full items-center gap-1 text-[11px] text-accent-text hover:underline focus-visible:underline focus-visible:outline-none"
                    aria-label="Display pasted text in chat box"
                  >
                    <MessageSquareText size={11} className="shrink-0" aria-hidden="true" />
                    <span className="truncate">Display in chat box</span>
                  </button>
                </div>
                <RemoveButton label="Remove pasted text" onClick={() => onRemove(a.id)} />
              </div>
            ) : a.kind === "image" ? (
              <div key={a.id} role="listitem" title={a.name} className={chipClass("size-14 overflow-hidden bg-inset")}>
                <button
                  type="button"
                  onClick={() => {
                    const image = previewImage(a.path, a.name);
                    const src = image?.src ?? a.previewUrl;
                    if (src) setPreview(image ?? { src, name: a.name });
                  }}
                  disabled={!attachmentImageUrl(a.path) && !a.previewUrl}
                  aria-busy={a.uploading || undefined}
                  className="relative flex size-full items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 disabled:cursor-default"
                  aria-label={`Preview ${a.name}`}
                >
                  <img
                    src={attachmentImageUrl(a.path) ?? a.previewUrl}
                    alt={a.name}
                    loading="eager"
                    fetchPriority="high"
                    className="size-full object-cover"
                  />
                  {a.uploading && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white">
                      <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                    </span>
                  )}
                </button>
                <RemoveButton label="Remove file" onImage onClick={() => onRemove(a.id)} />
              </div>
            ) : (
              <div key={a.id} role="listitem" title={a.path} className={chipClass("w-[180px] gap-2 pl-3 pr-7")}>
                <FileIcon size={16} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="truncate text-[12px] text-ink">{a.name}</div>
                  <div className="text-[10.5px] text-ink-tertiary">{formatSize(a.size)}</div>
                </div>
                <RemoveButton label="Remove file" onClick={() => onRemove(a.id)} />
              </div>
            ),
          )}
        </div>
      )}
      {preview && <AttachmentPreviewDialog image={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

function chipClass(extra: string) {
  return cn("group relative flex h-14 shrink-0 items-center rounded-xl border border-hairline/40 bg-raised transition-colors hover:border-hairline", extra);
}

function RemoveButton({ label, onClick, onImage = false }: { label: string; onClick: () => void; onImage?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "absolute right-1 top-1 flex size-5 items-center justify-center rounded-full opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 touch:opacity-100",
        onImage ? "bg-black/60 text-white hover:bg-black/75" : "border border-hairline/60 bg-panel text-ink-secondary hover:text-ink",
      )}
    >
      <X size={11} />
    </button>
  );
}
