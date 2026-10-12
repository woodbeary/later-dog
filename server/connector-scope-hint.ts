
const SCOPE_ERROR = /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|insufficientPermissions/i;

function requiredScope(slug: string): string | null {
  if (!slug.startsWith("GMAIL_")) return null;
  if (/FORWARD|SEND_AS|DELEGATE/.test(slug)) return "https://www.googleapis.com/auth/gmail.settings.sharing";
  if (/FILTER|VACATION|AUTO_REPLY|IMAP|POP|LANGUAGE/.test(slug)) return "https://www.googleapis.com/auth/gmail.settings.basic";
  return null;
}

function appName(slug: string): string {
  const toolkit = slug.split("_")[0] ?? "";
  if (toolkit === "GMAIL") return "Gmail";
  if (toolkit.startsWith("GOOGLE")) return "Google";
  return toolkit.charAt(0) + toolkit.slice(1).toLowerCase();
}

export function scopeHint(slugs: readonly string[]): string {
  const slug = slugs.find((candidate) => requiredScope(candidate)) ?? slugs[0] ?? "";
  const app = slug ? appName(slug) : "This app";
  const scope = slug ? requiredScope(slug) : null;
  const permission = scope ? `the ${scope} permission` : "the permission this action needs";
  return `later.dog note: ${app} refused this because the connected account has not granted ${permission}. ` +
    `Reconnecting will not add it: the default Composio connection never asks for it. ` +
    `To allow it, the person creates their own ${app} auth config in their Composio project that includes ${permission}, ` +
    `then reconnects ${app} under Connected apps; later.dog uses that config automatically. ` +
    `Tell the person this. Do not retry this call.`;
}

type ToolResultFrame = { result?: { content?: unknown; isError?: unknown } };

function annotateFrame(frame: unknown, slugs: readonly string[]): boolean {
  const result = (frame as ToolResultFrame | null)?.result;
  if (!result || !Array.isArray(result.content)) return false;
  const refused = result.content.some((item) =>
    item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string" &&
    SCOPE_ERROR.test((item as { text: string }).text));
  if (!refused) return false;
  result.content.push({ type: "text", text: scopeHint(slugs) });
  return true;
}

export function withScopeHint(bytes: Uint8Array, contentType: string, slugs: readonly string[]): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  if (!SCOPE_ERROR.test(text)) return bytes;
  try {
    if (/text\/event-stream/i.test(contentType)) {
      let changed = false;
      const lines = text.split("\n").map((line) => {
        if (!line.startsWith("data:")) return line;
        const frame = JSON.parse(line.slice(5));
        if (!annotateFrame(frame, slugs)) return line;
        changed = true;
        return `data: ${JSON.stringify(frame)}`;
      });
      return changed ? new TextEncoder().encode(lines.join("\n")) : bytes;
    }
    const frame = JSON.parse(text);
    return annotateFrame(frame, slugs) ? new TextEncoder().encode(JSON.stringify(frame)) : bytes;
  } catch {
    return bytes;
  }
}
