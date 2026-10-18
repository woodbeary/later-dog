import { HOME_WAKE_WORDS, isHomeWake } from "../../shared/home-wake";

export const UNREACHABLE_MESSAGE = "Couldn't reach later.dog. Check that it's running and that you're online, then try again.";
export const TOO_SLOW_MESSAGE = "later.dog took too long to answer. Try again in a moment.";
export const GENERIC_MESSAGE = "Something went wrong. Try again.";

const NETWORK_WORDS = /^(?:failed to fetch|load failed|fetch failed)\.?$|networkerror|network request failed|network connection was lost/i;

function statusMessage(status: number): string | null {
  if (status === 502 || status === 503 || status === 504) return "later.dog isn't answering right now. Check that it's running, then try again.";
  if (status === 401 || status === 403) return "later.dog didn't accept that. Sign in again or ask the person who runs this later.dog for access.";
  if (status === 404) return "That isn't there any more. Refresh and try again.";
  if (status >= 500) return GENERIC_MESSAGE;
  return null;
}

export function statusFallback(status: number): string {
  return statusMessage(status) ?? GENERIC_MESSAGE;
}

const CODE_TOKEN = /^[a-z0-9]+(?:[_.:/-][a-z0-9]+)*$/i;
const STATUS_LINE = /^(?:(?:http|error|status)\s*)?\d{3}(?:\s+[a-z][a-z ]*)?$/i;

export function isBareCode(message: string): boolean {
  const trimmed = message.trim();
  return CODE_TOKEN.test(trimmed) || STATUS_LINE.test(trimmed);
}

export function plainClientError(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError") return TOO_SLOW_MESSAGE;
  if (name === "AbortError") return TOO_SLOW_MESSAGE;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if ((error instanceof TypeError && (!message || NETWORK_WORDS.test(message))) || NETWORK_WORDS.test(message)) return UNREACHABLE_MESSAGE;
  const said = message.trim();
  const wake = (error as { wake?: unknown } | null)?.wake;
  if (!said || isBareCode(said)) {
    if (isHomeWake(wake)) return HOME_WAKE_WORDS[wake];
    if (isHomeWake(said)) return HOME_WAKE_WORDS[said];
  }
  if (said && isBareCode(said)) {
    const status = (error as { status?: unknown } | null)?.status;
    const code = typeof status === "number" ? status : Number(/\d{3}/.exec(said)?.[0]);
    return Number.isFinite(code) && code >= 400 ? statusFallback(code) : GENERIC_MESSAGE;
  }
  if (said) return message;
  return GENERIC_MESSAGE;
}
