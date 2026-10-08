// The face parts every breed shares, as path geometry: DogAvatar draws them in the app, and
// scripts/laterdog-mark.ts draws the same dog into the brandmark and app icon.
import type { BreedLook } from "./dog-breeds.ts";

export const round = (value: number) => Math.round(value * 100) / 100;

/** A dog's nose: a rounded, downward-pointing shield, `w` wide and `h` tall, centred on (50, y). */
export function nosePath(y: number, w: number, h: number): string {
  const n = round, l = 50 - w / 2, r = 50 + w / 2, t = y - h / 2, b = y + h / 2;
  return `M${n(l)} ${n(y - h * 0.22)}C${n(l)} ${n(t + h * 0.02)} ${n(50 - w * 0.3)} ${n(t)} 50 ${n(t)}` +
    `C${n(50 + w * 0.3)} ${n(t)} ${n(r)} ${n(t + h * 0.02)} ${n(r)} ${n(y - h * 0.22)}` +
    `C${n(r)} ${n(y + h * 0.12)} ${n(50 + w * 0.2)} ${n(b - h * 0.04)} 50 ${n(b)}` +
    `C${n(50 - w * 0.2)} ${n(b - h * 0.04)} ${n(l)} ${n(y + h * 0.12)} ${n(l)} ${n(y - h * 0.22)}Z`;
}

/** The mouth: a short line down from the nose that splits into two curves; `join` is where they meet. */
export function mouthGeometry(look: Pick<BreedLook, "nose" | "mouth">): { d: string; join: number } {
  const n = round;
  const top = look.nose.y + look.nose.h / 2 - 0.6;
  const join = look.mouth.y - 2.6;
  const { y, w } = look.mouth;
  return {
    join,
    d: `M50 ${n(top)}L50 ${n(join)}M${n(50 - w)} ${n(y - 2.4)}Q${n(50 - w * 0.42)} ${n(y + 1.9)} 50 ${n(join)}Q${n(50 + w * 0.42)} ${n(y + 1.9)} ${n(50 + w)} ${n(y - 2.4)}`,
  };
}

/** The tongue that shows when a dog is happy: it hangs from where the mouth's curves meet, its top tucked under them. */
export function tonguePath(join: number): string {
  const y = join + 2.6;
  return `M46 ${round(y + 0.6)}Q50 ${round(join - 0.4)} 54 ${round(y + 0.6)}V${round(y + 6)}A4 4 0 0 1 46 ${round(y + 6)}Z`;
}
