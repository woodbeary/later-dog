export function isPoll(command: string): boolean {
  return /cat runs\/\.logs\/[0-9a-f]+\.exit/.test(command);
}

export function pollAnswer(command: string, exitCode: number | null, log: string): string {
  const exit = exitCode === null ? "" : `${exitCode}\n`;
  return command.includes("echo alive") ? `alive\n<<<\n${exit}<<<\n${log}` : `${exit}<<<\n${log}`;
}
