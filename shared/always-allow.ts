export const RUN_KEY = "run:";
export const EXACT_KEY = "exact:";
export const FILES_EDIT_KEY = "files:edit";
export const TOOL_KEY = "tool:";
export const COMPUTER_KEY = "computer:";
export const MAX_GRANT_KEY_BYTES = 480;

export type GrantShape =
  | { kind: "run"; program: string }
  | { kind: "exact"; command: string }
  | { kind: "files" }
  | { kind: "tool"; tool: string };

export interface ReadGrant {
  shape: GrantShape;
  onComputer: boolean;
}

export function readGrantKey(key: string): ReadGrant | null {
  const onComputer = key.startsWith(COMPUTER_KEY);
  const rest = onComputer ? key.slice(COMPUTER_KEY.length) : key;
  if (rest.startsWith(RUN_KEY)) return { onComputer, shape: { kind: "run", program: rest.slice(RUN_KEY.length) } };
  if (rest.startsWith(EXACT_KEY)) return { onComputer, shape: { kind: "exact", command: rest.slice(EXACT_KEY.length) } };
  if (rest === FILES_EDIT_KEY) return { onComputer, shape: { kind: "files" } };
  if (rest.startsWith(TOOL_KEY)) return { onComputer, shape: { kind: "tool", tool: rest.slice(TOOL_KEY.length) } };
  return null;
}
