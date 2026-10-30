export type SavedVoiceNote = { audio: Uint8Array<ArrayBuffer>; message: string };

const MAX_NOTES = 10;
const notes = new Map<string, SavedVoiceNote>();

export function saveVoiceNote(draftId: string, note: SavedVoiceNote): void {
  notes.delete(draftId);
  notes.set(draftId, note);
  while (notes.size > MAX_NOTES) notes.delete(notes.keys().next().value!);
}

export function savedVoiceNote(draftId: string): SavedVoiceNote | null {
  return notes.get(draftId) ?? null;
}

export function forgetVoiceNote(draftId: string): void {
  notes.delete(draftId);
}
