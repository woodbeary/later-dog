import { extname } from "node:path";
import { z } from "zod";

export const EMAIL_ME_MAX_BYTES = 3_500_000;
export const EMAIL_ME_MAX_ATTACHMENTS = 10;
const PART = 256 * 1024;
const FILENAME = /^[^\p{Cc}/\\]{1,200}$/u;

const TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".key": "application/vnd.apple.keynote",
  ".pages": "application/vnd.apple.pages",
  ".numbers": "application/vnd.apple.numbers",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
};

const fromText = z.object({ filename: z.string().regex(FILENAME), text: z.string().max(EMAIL_ME_MAX_BYTES) }).strict();
const fromBase64 = z.object({ filename: z.string().regex(FILENAME), base64: z.string().max(Math.ceil(EMAIL_ME_MAX_BYTES / 3) * 4 + 4) }).strict();
const fromMac = z.object({
  computer_id: z.string().uuid().optional(),
  folder_id: z.string().uuid().optional(),
  path: z.string().min(1).max(2048),
  filename: z.string().regex(FILENAME).optional(),
}).strict();

export const emailMeInput = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  attachments: z.array(z.union([fromText, fromBase64, fromMac])).max(EMAIL_ME_MAX_ATTACHMENTS).optional(),
}).strict();

export type EmailMeInput = z.infer<typeof emailMeInput>;

export interface OutgoingAttachment {
  filename: string;
  type: string;
  content: string;
}

export interface OutgoingEmail {
  subject: string;
  text: string;
  attachments: OutgoingAttachment[];
}

export interface MacRead {
  computer_id?: string;
  action: "read_file";
  folder_id?: string;
  path: string;
  encoding: "base64";
  offset?: number;
  length?: number;
}

export interface EmailMeDeps {
  botName: string;
  readMacFile(operation: MacRead): Promise<unknown>;
  deliver(email: OutgoingEmail): Promise<void>;
}

export type EmailMeAnswer = { status: number; body: Record<string, unknown> };

export function attachmentType(filename: string): string {
  return TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

function readResult(result: unknown): { content: string; bytes: number; size?: number } {
  const answer = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | null;
  const content = answer?.content;
  const text = Array.isArray(content) ? content.find((part) => part.type === "text")?.text : undefined;
  if (answer?.isError) throw new Error(text ?? "The Mac refused to read the file");
  if (typeof text !== "string") throw new Error("The Mac did not send the file");
  const parsed = JSON.parse(text) as { content?: unknown; bytes?: unknown; size?: unknown; encoding?: unknown };
  if (typeof parsed.content !== "string" || parsed.encoding !== "base64") throw new Error("The Mac did not send the file");
  return { content: parsed.content, bytes: Number(parsed.bytes ?? 0), ...(typeof parsed.size === "number" ? { size: parsed.size } : {}) };
}

function tooBig(bytes: number): EmailMeAnswer {
  const megabytes = (bytes / 1_000_000).toFixed(1);
  return { status: 413, body: { error: `That's ${megabytes} MB, too big to email. One email holds up to ${EMAIL_ME_MAX_BYTES / 1_000_000} MB of attachments.` } };
}

async function macFile(input: z.infer<typeof fromMac>, deps: EmailMeDeps, budget: number): Promise<Buffer | EmailMeAnswer> {
  const base: MacRead = {
    ...(input.computer_id ? { computer_id: input.computer_id } : {}),
    action: "read_file",
    ...(input.folder_id ? { folder_id: input.folder_id } : {}),
    path: input.path,
    encoding: "base64",
  };
  const parts: Buffer[] = [];
  let offset = 0;
  let size = Number.POSITIVE_INFINITY;
  while (offset < size) {
    const part = readResult(await deps.readMacFile({ ...base, offset, length: PART }));
    size = part.size ?? offset + part.bytes;
    if (size > budget) return tooBig(size);
    if (part.bytes === 0) break;
    parts.push(Buffer.from(part.content, "base64"));
    offset += part.bytes;
  }
  return Buffer.concat(parts);
}

export async function emailMe(raw: unknown, deps: EmailMeDeps): Promise<EmailMeAnswer> {
  const parsed = emailMeInput.safeParse(raw);
  if (!parsed.success) {
    return { status: 400, body: { error: "email_me needs a subject, a body, and optional attachments: { filename, text }, { filename, base64 } or a file on their Mac { path }." } };
  }
  const input = parsed.data;
  const attachments: OutgoingAttachment[] = [];
  let total = 0;
  for (const attachment of input.attachments ?? []) {
    let bytes: Buffer;
    let filename: string;
    if ("text" in attachment) {
      bytes = Buffer.from(attachment.text, "utf8");
      filename = attachment.filename;
    } else if ("base64" in attachment) {
      bytes = Buffer.from(attachment.base64, "base64");
      if (bytes.toString("base64").replace(/=+$/, "") !== attachment.base64.replace(/\s+/g, "").replace(/=+$/, "")) {
        return { status: 400, body: { error: `${attachment.filename} is not valid base64.` } };
      }
      filename = attachment.filename;
    } else {
      const read = await macFile(attachment, deps, EMAIL_ME_MAX_BYTES - total);
      if (!Buffer.isBuffer(read)) return read;
      bytes = read;
      filename = attachment.filename ?? attachment.path.split("/").pop() ?? "file";
    }
    total += bytes.length;
    if (total > EMAIL_ME_MAX_BYTES) return tooBig(total);
    attachments.push({ filename, type: attachmentType(filename), content: bytes.toString("base64") });
  }
  await deps.deliver({
    subject: input.subject,
    text: `${input.body}\n\n— ${deps.botName}, your later.dog dog`,
    attachments,
  });
  return { status: 200, body: { sent: true, to: "your later.dog email", attachments: attachments.map((attachment) => attachment.filename) } };
}

export function cloudEmailDelivery(url: string | undefined, token: string | undefined, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
  if (!url || !token) return null;
  return async (email: OutgoingEmail): Promise<void> => {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(email),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const answer = (await response.json().catch(() => null)) as { error?: unknown } | null;
      throw Object.assign(new Error(typeof answer?.error === "string" ? answer.error : `Email could not be sent (${response.status})`), { status: response.status === 429 ? 429 : 502 });
    }
  };
}
