export type EngineProgram = "Claude Code" | "Codex";

export function leftoverProgramsNotice(engine: EngineProgram): string {
  return `${engine} has stopped, but some programs it started could not be confirmed closed and may still be running.`;
}
