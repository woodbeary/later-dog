export type ReadTextSource = "mail" | "texts" | "phone" | "another dog";

export const READ_TEXT_TAG = "read_text";

export function readText(source: ReadTextSource, body: string): string {
  const fenced = body.replace(/<(\/?)read_text/gi, "<$1read-text");
  return `<${READ_TEXT_TAG} from="${source}">\n${fenced}\n</${READ_TEXT_TAG}>`;
}
