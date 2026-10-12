
export const SHELL_TOOL = "shell";

export function nameIsCommand(name: string): boolean {
  return /[\s/]/.test(name);
}

export function toolIdentity(name: string): string {
  return nameIsCommand(name) ? SHELL_TOOL : name;
}
