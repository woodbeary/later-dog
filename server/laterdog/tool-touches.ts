import type { FileChange, ToolTouch } from "../../shared/turn-results.ts";

type Fields = Record<string, unknown>;

const fields = (value: unknown): Fields | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Fields : undefined;

const pathOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const CLAUDE_FILE_TOOLS: Record<string, { key: string; change: FileChange | "written" }> = {
  Write: { key: "file_path", change: "written" },
  Edit: { key: "file_path", change: "edited" },
  MultiEdit: { key: "file_path", change: "edited" },
  NotebookEdit: { key: "notebook_path", change: "edited" },
};

export function claudeToolTouch(name: unknown, input: unknown): ToolTouch | undefined {
  if (name === "Bash") return { command: true };
  const tool = typeof name === "string" ? CLAUDE_FILE_TOOLS[name] : undefined;
  const path = tool ? pathOf(fields(input)?.[tool.key]) : undefined;
  return tool && path ? { files: [{ path, change: tool.change }] } : undefined;
}

const CODEX_CHANGES: Record<string, FileChange> = { add: "created", delete: "deleted", update: "edited" };

export function codexToolTouch(item: unknown): ToolTouch | undefined {
  const record = fields(item);
  if (record?.type === "commandExecution") return { command: true };
  if (record?.type !== "fileChange" || !Array.isArray(record.changes)) return undefined;
  const files = record.changes.flatMap((entry): NonNullable<ToolTouch["files"]> => {
    const change = fields(entry);
    const path = pathOf(change?.path);
    const kind = fields(change?.kind);
    const type = typeof kind?.type === "string" ? CODEX_CHANGES[kind.type] : undefined;
    if (!path || !type) return [];
    const moved = type === "edited" ? pathOf(kind?.move_path) : undefined;
    return moved ? [{ path, change: "deleted" }, { path: moved, change: "created" }] : [{ path, change: type }];
  });
  return files.length ? { files } : undefined;
}

const CREATED = /^(?:\s*\[\s*\{\s*"type":\s*"text",\s*"text":\s*")?\s*File created successfully at: /;

export function writtenChange(output: string | undefined): FileChange {
  return output && CREATED.test(output.slice(0, 400)) ? "created" : "edited";
}
