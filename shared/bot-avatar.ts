import { z } from "zod";

export const BOT_AVATAR_CROPS = ["mascot", "circle", "rounded", "square"] as const;
export const botAvatarCropSchema = z.enum(BOT_AVATAR_CROPS);
export type BotAvatarCrop = z.infer<typeof botAvatarCropSchema>;

export function avatarCropRadius(crop: BotAvatarCrop): string {
  if (crop === "circle") return "50%";
  if (crop === "rounded") return "22%";
  return "0";
}

export const AVATAR_ZOOM_MIN = 1;
export const AVATAR_ZOOM_MAX = 3;
export const AVATAR_FOCUS_CENTER = 0.5;

export function clampAvatarZoom(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed)) return AVATAR_ZOOM_MIN;
  const clamped = Math.min(AVATAR_ZOOM_MAX, Math.max(AVATAR_ZOOM_MIN, parsed));
  return Math.round(clamped * 100) / 100;
}

export function clampAvatarFocus(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed)) return AVATAR_FOCUS_CENTER;
  const clamped = Math.min(1, Math.max(0, parsed));
  return Math.round(clamped * 1000) / 1000;
}

export const botAvatarUrlSchema = z
  .string()
  .regex(
    /^\/api\/attachments\/[A-Za-z0-9-]+\.(?:png|jpg|gif|webp)$/,
    "must be a stored PNG, JPEG, GIF, or WebP attachment",
  );

export function botAvatarUrlFromStoredPath(path: string): string | null {
  const name = path.replaceAll("\\", "/").split("/").pop();
  if (!name) return null;
  const url = `/api/attachments/${name}`;
  return botAvatarUrlSchema.safeParse(url).success ? url : null;
}

export interface BotAvatarProfileInput {
  avatarUrl?: unknown;
  avatarCrop?: unknown;
}

export interface BotAvatarProfile {
  avatarUrl?: string;
  avatarCrop: BotAvatarCrop;
}

export function botAvatarProfile(value: BotAvatarProfileInput): BotAvatarProfile {
  const profile: BotAvatarProfile = {
    avatarCrop: botAvatarCropSchema.safeParse(value.avatarCrop).data ?? "mascot",
  };
  const url = botAvatarUrlSchema.safeParse(value.avatarUrl);
  if (url.success) profile.avatarUrl = url.data;
  return profile;
}
