export const SHARED_WORKSPACE_DOG_LIMIT = 100;
export const SHARED_WORKSPACE_CREATIONS_PER_TURN = 4;

export type WorkspaceOwnership = { ownersWorkspace: boolean };

export function dogLimitRefusal(input: WorkspaceOwnership & { dogs: number }): string | null {
  if (input.ownersWorkspace || input.dogs < SHARED_WORKSPACE_DOG_LIMIT) return null;
  return `this workspace is limited to ${SHARED_WORKSPACE_DOG_LIMIT} dogs`;
}

export function turnCreationRefusal(input: WorkspaceOwnership & { created: number; kind: "dogs" | "group chats" }): string | null {
  if (input.ownersWorkspace || input.created < SHARED_WORKSPACE_CREATIONS_PER_TURN) return null;
  return `You can create at most ${SHARED_WORKSPACE_CREATIONS_PER_TURN} ${input.kind} in one turn here.`;
}
