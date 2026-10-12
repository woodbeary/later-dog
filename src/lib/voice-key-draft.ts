export type CloudVoiceProvider = "elevenlabs" | "fish";
export type VoiceKeyDraft = { provider: CloudVoiceProvider | null; value: string };

export function voiceKeyDraftValue(draft: VoiceKeyDraft, provider: CloudVoiceProvider): string {
  return draft.provider === provider ? draft.value : "";
}
