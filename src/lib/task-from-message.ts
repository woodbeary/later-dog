const QUOTE_MAX = 600;

export function quotedReply(text: string): string {
  const flat = text.replace(/```[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!flat) return "";
  const cut = flat.length > QUOTE_MAX ? `${flat.slice(0, QUOTE_MAX).trimEnd()}…` : flat;
  return cut.split("\n").map((line) => (line.trim() ? `> ${line}` : ">")).join("\n");
}

export function taskDraft(lead: string, text: string): string {
  const quote = quotedReply(text);
  return quote ? `${lead}\n${quote}\n\n` : "";
}
