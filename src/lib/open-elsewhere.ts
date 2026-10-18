export interface ConversationOwner {
  id: string;
  threadId: string;
}

export function ownerShowingElsewhere<Owner extends ConversationOwner>(
  owners: ReadonlyArray<Owner>,
  threadId: string | undefined,
  viewingId: string,
): Owner | undefined {
  if (!threadId) return undefined;
  return owners.find((owner) => owner.threadId === threadId && owner.id !== viewingId);
}
