export const MAC_PROMPT_REPEAT_MS = 10 * 60_000;

const KNOWN: Record<string, string> = {
  UserNotificationCenter: "a macOS permission",
  universalAccessAuthWarn: "Accessibility",
  SecurityAgent: "your Mac password",
  CoreServicesUIAgent: "a macOS confirmation",
  tccd: "a macOS permission",
  ScreenCaptureUI: "screen access",
};

export function macPromptOf(result: unknown): { owner: string } | null {
  const prompt = (result as { macPrompt?: { owner?: unknown } } | null)?.macPrompt;
  return prompt && typeof prompt.owner === "string" && prompt.owner ? { owner: prompt.owner } : null;
}

export function macPromptWords(owner: string): string {
  return `Click Allow on your Mac: ${KNOWN[owner] ?? "a macOS permission"} window is waiting for you`;
}

export function createMacPromptGate(now: () => number = Date.now) {
  const last = new Map<string, number>();
  return (threadId: string): boolean => {
    const at = last.get(threadId);
    if (at !== undefined && now() - at < MAC_PROMPT_REPEAT_MS) return false;
    last.set(threadId, now());
    return true;
  };
}
