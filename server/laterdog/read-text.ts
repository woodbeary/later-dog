export type ReadTextSource = "mail" | "texts" | "phone" | "another dog";

export const READ_TEXT_TAG = "read_text";

const OPENING = /^<read_text from="(mail|texts|phone|another dog)">\n/;
const CLOSING = `\n</${READ_TEXT_TAG}>`;

export function readText(source: ReadTextSource, body: string): string {
  const fenced = body.replace(/<(\/?)read_text/gi, "<$1read-text");
  return `<${READ_TEXT_TAG} from="${source}">\n${fenced}${CLOSING}`;
}

export type MarkedRead = { source: ReadTextSource; body: string; after: string };

export function markedRead(text: string): MarkedRead | null {
  const opening = OPENING.exec(text);
  if (!opening) return null;
  const close = text.indexOf(CLOSING, opening[0].length);
  if (close < 0) return null;
  return { source: opening[1] as ReadTextSource, body: text.slice(opening[0].length, close), after: text.slice(close + CLOSING.length) };
}

export function readTextOverhead(source: ReadTextSource): number {
  return readText(source, "").length;
}
