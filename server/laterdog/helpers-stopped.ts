export interface StoppedWork {
  helpers: number;
  commands: number;
}

const counted = (count: number, one: string, many: string) => (count === 1 ? one : `${count} ${many}`);

export function helpersStoppedLine({ helpers, commands }: StoppedWork): string | null {
  if (helpers <= 0 && commands <= 0) return null;
  if (commands <= 0) return `${counted(helpers, "A helper", "helpers")} stopped when this turn ended.`;
  const running = `${counted(commands, "a command", "commands")} running in the background`;
  if (helpers <= 0) return `${running[0]!.toUpperCase()}${running.slice(1)} stopped when this turn ended.`;
  return `${counted(helpers, "A helper", "helpers")} and ${running} stopped when this turn ended.`;
}
