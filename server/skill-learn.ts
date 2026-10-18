export const LEARN_SOURCE_PREFIX = "learn:";

export function learnSource(request: string): string {
  const compact = request.replace(/\s+/g, " ").trim();
  const body = compact || "conversation";
  return `${LEARN_SOURCE_PREFIX}${body.slice(0, 180)}`;
}
