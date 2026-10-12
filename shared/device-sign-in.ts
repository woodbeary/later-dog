
export type DeviceSignInProvider = "codex" | "grok";

const CODEX_PAGE = "https://auth.openai.com/codex/device";

const RULES: Record<DeviceSignInProvider, { page(value: string): string | null; code: RegExp }> = {
  codex: {
    page: (value) => (/^https:\/\/auth\.openai\.com\/codex\/device\/?$/.test(value) ? CODEX_PAGE : null),
    code: /^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/,
  },
  grok: {
    page: (value) => {
      if (!/^https:\/\/[^\s#]+$/.test(value)) return null;
      let url: URL;
      try { url = new URL(value); } catch { return null; }
      if (url.username || url.password || url.port || !/(^|\.)(x\.ai|grok\.com)$/.test(url.hostname)) return null;
      return [...url.searchParams.keys()].every((key) => key === "user_code") ? url.href : null;
    },
    code: /^[A-Z0-9]{4,12}(?:-[A-Z0-9]{2,12}){0,3}$/,
  },
};

export function deviceSignInLink(provider: DeviceSignInProvider, value: string | null | undefined, userCode?: string): string | null {
  const page = value ? RULES[provider].page(value) : null;
  if (!page) return null;
  return [...new URL(page).searchParams.values()].every((carried) => carried === userCode) ? page : null;
}

export function isDeviceSignInCode(provider: DeviceSignInProvider, value: string | null | undefined): value is string {
  return typeof value === "string" && RULES[provider].code.test(value);
}

export function deviceSignInPrompt(provider: DeviceSignInProvider, text: string): { authorizationUrl: string; userCode: string } | null {
  const lines = text.split(/\r?\n/).slice(0, -1).map((line) => line.trim());
  const at = lines.findIndex((line) => RULES[provider].page(line) !== null);
  if (at < 0) return null;
  const userCode = lines.slice(at + 1).map((line) => line.replace(/^code:\s*/i, "")).find((line) => isDeviceSignInCode(provider, line));
  const authorizationUrl = userCode ? deviceSignInLink(provider, lines[at], userCode) : null;
  return authorizationUrl && userCode ? { authorizationUrl, userCode } : null;
}
