export function inputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string" ? [part.text as string] : [])
    .join("\n");
}

export class SteerReads {
  private waiting: { text: string; read: () => void }[] = [];

  expect(text: string, read: (() => void) | undefined): () => void {
    if (!read || !text) return () => {};
    const entry = { text, read };
    this.waiting.push(entry);
    return () => {
      this.waiting = this.waiting.filter((candidate) => candidate !== entry);
    };
  }

  seen(content: unknown): void {
    const text = inputText(content);
    if (!text || this.waiting.length === 0) return;
    const read = this.waiting.filter((entry) => text.includes(entry.text));
    if (read.length === 0) return;
    this.waiting = this.waiting.filter((entry) => !read.includes(entry));
    for (const entry of read) entry.read();
  }
}
