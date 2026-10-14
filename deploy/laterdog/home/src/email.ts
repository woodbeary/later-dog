import { authorizedState } from "./state.ts";

export const EMAIL_MAX_BYTES = 5 * 1024 * 1024;
const FILENAME = /^[^\p{Cc}/\\]{1,200}$/u;
const TYPE = /^[a-z]+\/[a-z0-9.+-]{1,100}$/i;

export interface OwnerEmail {
  subject: string;
  text: string;
  attachments: Array<{ filename: string; type: string; content: string }>;
}

export interface OwnerMail {
  sendOwnerEmail(accountId: string, email: OwnerEmail): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
}

export function parseOwnerEmail(input: unknown): OwnerEmail | null {
  if (!input || typeof input !== "object") return null;
  const { subject, text, attachments } = input as Record<string, unknown>;
  if (typeof subject !== "string" || !subject.trim() || subject.length > 200) return null;
  if (typeof text !== "string" || !text.trim() || text.length > 30_000) return null;
  if (!Array.isArray(attachments) || attachments.length > 10) return null;
  const parsed: OwnerEmail["attachments"] = [];
  for (const attachment of attachments) {
    const { filename, type, content } = (attachment ?? {}) as Record<string, unknown>;
    if (typeof filename !== "string" || !FILENAME.test(filename)) return null;
    if (typeof type !== "string" || !TYPE.test(type)) return null;
    if (typeof content !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) return null;
    parsed.push({ filename, type, content });
  }
  return { subject: subject.trim(), text, attachments: parsed };
}

export async function handleOwnerEmail(request: Request, params: { token?: string; accountId?: string } | undefined, mail: OwnerMail): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  if (!params?.accountId || !(await authorizedState(request, params.token))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > EMAIL_MAX_BYTES * 2) return Response.json({ error: "That email is too big to send." }, { status: 413 });
  const raw = await request.text();
  if (raw.length > EMAIL_MAX_BYTES * 2) return Response.json({ error: "That email is too big to send." }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "The email could not be read." }, { status: 400 });
  }
  const email = parseOwnerEmail(body);
  if (!email) return Response.json({ error: "The email could not be read." }, { status: 400 });
  const encoded = email.attachments.reduce((sum, attachment) => sum + attachment.content.length, 0) + email.text.length;
  if (encoded > EMAIL_MAX_BYTES) return Response.json({ error: "That email is too big to send. Emails hold up to 3.5 MB of attachments." }, { status: 413 });
  const sent = await mail.sendOwnerEmail(params.accountId, email);
  if (!sent.ok) return Response.json({ error: sent.error }, { status: sent.status });
  return Response.json({ sent: true });
}
