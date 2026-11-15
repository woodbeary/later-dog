import { ClipboardList } from "lucide-react";

import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";

export function DigestChip({ message }: { message: Message }) {
  const digest = message.digest;
  if (!digest) return null;
  const files = digest.files ? digest.files.changed.length + digest.files.added.length + digest.files.deleted.length + (digest.files.truncated ?? 0) : null;
  if (!digest.tools.length && !digest.toolCalls && !digest.toolsDropped &&
      !files && !digest.memory.length && !digest.memoryDropped) return null;
  const tools = digest.toolCalls ?? `${digest.tools.reduce((n, tool) => n + tool.count, 0)}${digest.toolsDropped ? "+" : ""}`;
  const label = files === null
    ? t("chat.digestChipNoFiles", { tools })
    : t("chat.digestChip", { tools, files });
  return (
    <div className="flex justify-start" data-testid="digest-chip">
      <span
        title={message.text ?? t("chat.digestTitle")}
        className="inline-flex max-w-[480px] items-center gap-1.5 rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12px] text-ink-secondary"
      >
        <ClipboardList size={12} />
        <span className="truncate">{label}</span>
      </span>
    </div>
  );
}

const PLAIN_LINE_CHARS = 200;

export function compactionLine(summary: string): string | null {
  const line = summary.trim();
  return line && line.length <= PLAIN_LINE_CHARS && !/[\n[\]{}]/.test(line) ? line : null;
}

export function CompactionChip({ message }: { message: Message }) {
  if (!message.compaction) return null;
  const line = compactionLine(message.compaction.summary);
  return (
    <details className="max-w-[600px] rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[12px] text-ink-secondary" data-testid="compaction-chip">
      <summary className="cursor-pointer font-medium">{t("chat.compactionTitle")}</summary>
      {line && <p className="mt-2 break-words">{line}</p>}
      <p className="mt-2">{t("chat.compactionHint")}</p>
    </details>
  );
}
