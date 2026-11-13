
export type ResumeFailureClass =
  | "before-accept"
  | "after-accept"
  | "unknown";

export interface ResumeAttemptState {
  attempted: boolean;
  rejected: boolean;
  promptSubmitted: boolean;
  producedOutput: boolean;
}

export function classifyResumeFailure(state: ResumeAttemptState): ResumeFailureClass {
  if (state.producedOutput || state.promptSubmitted) return "after-accept";
  if (state.attempted && state.rejected) return "before-accept";
  return "unknown";
}

export function mayReplay(failure: ResumeFailureClass): boolean {
  return failure === "before-accept";
}

export interface RecoveryPromptInput {
  recoveryText: string | undefined;
  currentText: string;
  failure: ResumeFailureClass;
}

export interface RecoveryPrompt {
  text: string;
  replayed: boolean;
}

export function recoveryPromptFor(input: RecoveryPromptInput): RecoveryPrompt {
  if (!mayReplay(input.failure)) return { text: input.currentText, replayed: false };
  const replay = input.recoveryText?.trim();
  if (!replay || replay === input.currentText.trim()) return { text: input.currentText, replayed: false };
  return { text: replay, replayed: true };
}

export const CLAUDE_RESUME_REFUSALS = ["No conversation found with session ID", "Failed to resume session"] as const;

export function claudeResumeRefusal(frame: { is_error?: unknown; errors?: unknown }): string | null {
  if (frame.is_error !== true || !Array.isArray(frame.errors)) return null;
  const refusal = frame.errors.find((error): error is string =>
    typeof error === "string" && CLAUDE_RESUME_REFUSALS.some((start) => error.trim().startsWith(start)));
  return refusal?.trim() ?? null;
}
