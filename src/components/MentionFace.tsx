import { BotAvatar } from "./Avatar";
import { DOG_COLORS, type DogColor } from "@/lib/mascot";
import { MASCOT_BODY_IDS, type MascotBodyId } from "../../shared/mascot-bodies";

export const MENTION_FACE_SIZE = 15;

function knownBody(value: string | undefined): MascotBodyId | undefined {
  return (MASCOT_BODY_IDS as readonly string[]).includes(value ?? "") ? (value as MascotBodyId) : undefined;
}

export function MentionFace({ color, body }: { color: string | undefined; body?: string }) {
  if (!color || !Object.hasOwn(DOG_COLORS, color)) return null;
  return (
    <span data-mention-face aria-hidden className="mr-[3px] inline-flex shrink-0 translate-y-[2.5px] align-baseline">
      <BotAvatar
        bot={{ color: color as DogColor, mascotBody: knownBody(body) }}
        size={MENTION_FACE_SIZE}
        state="idle"
        motion="none"
        motionKey={0}
        animated={false}
      />
    </span>
  );
}
