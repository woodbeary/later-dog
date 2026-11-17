export function isPoll(command: string): boolean {
  return command.includes("cat runs/.logs/");
}

export function pollAnswer(command: string, exitCode: number | null, log: string): string {
  const exit = exitCode === null ? "" : `${exitCode}\n`;
  return command.includes("echo alive") ? `alive\n<<<\n${exit}<<<\n${log}` : `${exit}<<<\n${log}`;
}
