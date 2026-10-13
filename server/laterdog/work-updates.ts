export const QUIET_WORK_PROMPT =
  " Work quietly. The app already shows the person that you are working, so do not narrate your steps, tools, files or searches, and do not post progress notes just to show activity. Write to the person mid-task only when it truly helps them: a finding they need now, a question only they can answer, a wait longer than a minute or two, or a change of plan. Finish with one clear answer.";

export const STEP_UPDATES_PROMPT =
  " The person turned on step-by-step updates: before each meaningful step, send one short line saying what you are doing, then finish with one clear answer.";

export function workUpdatesPrompt(stepUpdates: boolean): string {
  return stepUpdates ? STEP_UPDATES_PROMPT : QUIET_WORK_PROMPT;
}

export function quietWorkEnvironment(quiet: boolean | undefined): Record<string, string> {
  return quiet ? { CLAUDE_CODE_SILENT_TURN_REMINDER: "0" } : {};
}
