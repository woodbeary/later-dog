import { avatarImageStatus, generateAvatarImage } from "./avatar-image.ts";
import { botAvatarUrlFromStoredPath } from "../shared/bot-avatar.ts";
import { parseProfileChanges } from "./profile-requests.ts";
import { profileRevision } from "./profile-revision.ts";
import type { ProfileRequestChanges } from "../shared/profile-request.ts";
import type { BotRecord } from "./store.ts";

export async function prepareProfileAvatar({ config, target, changes, prompt, generate = generateAvatarImage, save }: {
  config: Parameters<typeof generateAvatarImage>[0];
  target: BotRecord;
  changes: unknown;
  prompt: string;
  generate?: typeof generateAvatarImage;
  save: (bytes: Buffer, mime: string) => { path: string };
}): Promise<{ changes: ProfileRequestChanges; path: string }> {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw Object.assign(new Error("invalid profile changes"), { status: 400 });
  const fields = Object.keys(changes).length ? parseProfileChanges(changes) : {};
  if (!avatarImageStatus(config).configured) {
    throw Object.assign(new Error("Picture generation is not set up. Open this dog's settings, choose its picture, then Generate to add an image API key securely. Do not send keys in chat."), { status: 400 });
  }
  const generated = await generate(config, { ...target, ...fields }, prompt);
  const saved = save(generated.bytes, generated.mime);
  const avatarUrl = botAvatarUrlFromStoredPath(saved.path);
  if (!avatarUrl) throw Object.assign(new Error("Could not store the generated avatar"), { status: 500 });
  return { changes: { ...fields, avatarUrl, avatarCrop: target.avatarCrop && target.avatarCrop !== "mascot" ? target.avatarCrop : "circle" }, path: saved.path };
}

export async function submitProfileAvatar<T>({ currentTarget, assertActive, discard, submit, ...input }: Parameters<typeof prepareProfileAvatar>[0] & {
  currentTarget: () => BotRecord | undefined | null;
  assertActive: () => void;
  discard: (path: string) => void;
  submit: (changes: ProfileRequestChanges) => T;
}): Promise<T> {
  const before = profileRevision(input.target);
  const generated = await prepareProfileAvatar(input);
  try {
    assertActive();
    const current = currentTarget();
    if (!current || profileRevision(current) !== before) {
      throw Object.assign(new Error("The dog's profile changed while its picture was being generated. Try again with the current profile."), { status: 409 });
    }
    return submit(generated.changes);
  } catch (error) {
    discard(generated.path);
    throw error;
  }
}
