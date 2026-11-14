export const RESUME_REJECTED = "resume_rejected";

export function pickedConversationBackUp(name: string | undefined): string {
  return `${name?.trim() || "The dog"} picked the conversation back up.`;
}
