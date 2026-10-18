const THREAD_URL_PREFIX = "laterdog://thread/";

export function threadRefUrl(ref: { botId: string; threadId: string }): string {
  return THREAD_URL_PREFIX + encodeURIComponent(ref.threadId) + "?bot=" + encodeURIComponent(ref.botId);
}

export function looksLikeThreadRefUrl(value: string): boolean {
  return value.trim().toLowerCase().startsWith(THREAD_URL_PREFIX);
}

const CODE_OR_THREAD_LINK = /(```[\s\S]*?(?:```|$))|(`+)[\s\S]*?(?:\2|$)|\[((?:\\.|[^\\\]\n])*)\]\(\s*<?(laterdog:\/\/thread\/(?:[^\s()<>]|\([^\s()<>]*\))*)>?\s*\)/gi;

const unescapeLabel = (label: string): string => label.replace(/\\(.)/g, "$1");

export function plainThreadLinks(text: string): string {
  if (!text.toLowerCase().includes("laterdog://thread/")) return text;
  return text.replace(CODE_OR_THREAD_LINK, (match, _fence, _ticks, label: string | undefined, url: string | undefined) => {
    if (label === undefined || !url) return match;
    const plain = unescapeLabel(label).trim();
    if (!plain) return match;
    return plain.startsWith("#") ? plain : `#${plain}`;
  });
}
