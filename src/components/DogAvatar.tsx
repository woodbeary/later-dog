// later.dog's dog: a front-facing head per breed, drawn from data in ./dog-breeds.ts. A dog reads as a dog by the
// things a person checks first — the ears, a pale muzzle with a big dark nose and a mouth line, eyes with a glint —
// and as its breed by ear shape, head shape and markings. Every fill is a tone of the one colour the person picked
// (dog-avatar.css), so any colour still gives the breed. Motion is CSS on a few groups (body, ears, eyes, nose,
// tongue) chosen by the mood on the root; every mood has a still pose too, so a paused or reduced-motion dog still
// reads as what it is doing.
import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { DogState } from "@/lib/mascot";
import { BREEDS, DOG_BREEDS, type BreedLook, type DogBreed, type Shape } from "./dog-breeds";
import { mouthGeometry, nosePath, round, tonguePath } from "./dog-geometry";
import "./dog-avatar.css";

export { BREEDS, DOG_BREEDS, nosePath, type BreedLook, type DogBreed };
export function isDogBreed(id: string | null | undefined): id is DogBreed {
  return (DOG_BREEDS as readonly string[]).includes(id ?? "");
}

/** The ten things a dog can visibly be doing; every app state maps onto one. */
export type DogMood = "rest" | "listen" | "think" | "work" | "search" | "alert" | "happy" | "sleep" | "sad" | "angry";
const MOODS: Partial<Record<DogState, DogMood>> = {
  idle: "rest", humming: "rest", orbit: "rest",
  listening: "listen", dictating: "listen", receiving: "listen", curious: "listen",
  thinking: "think", confused: "think", suspicious: "think",
  working: "work", writing: "work", sending: "work", uploading: "work", loading: "work", dragging: "work", progress: "work",
  searching: "search", radar: "search",
  alerting: "alert", notifying: "alert", scared: "alert", surprised: "alert", waking: "alert", spawning: "alert",
  happy: "happy", excited: "happy", laughing: "happy", playful: "happy", celebrate: "happy", bouncing: "happy", proud: "happy",
  sleeping: "sleep", drowsy: "sleep", "powering-down": "sleep", bored: "sleep",
  sad: "sad", shy: "sad",
  angry: "angry",
};
export function dogMood(state: DogState | undefined): DogMood {
  return (state && MOODS[state]) ?? "rest";
}

const n = round;

const shapes = (list: Shape[] | undefined) =>
  list?.map((shape, index) => <path key={index} className={`ld-t-${shape.tone}`} d={shape.d} />);

export interface DogFaceProps {
  look: BreedLook;
  breed?: string;
  color: string;
  mood?: DogMood;
  size?: number;
  title?: string | null;
  gaze?: { x?: number; y?: number };
  paused?: boolean;
  blinking?: boolean;
  spinMs?: number;
}

/** The drawing alone, for a look given as data (the avatar, the breed picker, the motion library). */
export function DogFace({ look, breed, color, mood = "rest", size = 44, title, gaze, paused = false, blinking = false, spinMs = 0 }: DogFaceProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const svg = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    for (const animation of svg.current?.getAnimations?.({ subtree: true }) ?? []) {
      if (animation.effect?.getTiming().iterations === Infinity) animation.startTime = 0;
    }
  }, [mood, paused, blinking, spinMs]);
  const clamp = (value: number | undefined) => Math.max(-1, Math.min(1, value ?? 0));
  const style = {
    "--dog-ink": color,
    "--gx": clamp(gaze?.x),
    "--gy": clamp(gaze?.y),
    ...(spinMs ? { "--dog-spin": `${spinMs}ms` } : {}),
  } as CSSProperties;
  const [hx, hy] = look.ears.hinge;
  const hinge = `${hx}px ${hy}px`;
  const ear = (side: "l" | "r"): ReactNode => (
    <g className={`ld-dog-ear ld-dog-ear--${side}`}>
      <g className="ld-dog-ear-pose" style={{ transformOrigin: hinge }}>
        <g className="ld-dog-ear-loop" style={{ transformOrigin: hinge }}>{shapes(look.ears.shapes)}</g>
      </g>
    </g>
  );
  const ears = (
    <>
      {ear("l")}
      <g transform="matrix(-1 0 0 1 100 0)">{ear("r")}</g>
    </>
  );
  const { x, y, rx, ry, iris } = look.eyes;
  const eye = (side: "l" | "r") => {
    const cx = side === "l" ? x : 100 - x;
    return (
      <g key={side} className={`ld-dog-eye ld-dog-eye--${side}`}>
        <ellipse className="ld-t-ink" cx={cx} cy={y} rx={rx} ry={ry} />
        {iris && <ellipse cx={cx} cy={y} rx={n(rx * 0.74)} ry={n(ry * 0.74)} fill={iris} />}
        {iris && <ellipse className="ld-t-ink" cx={cx} cy={y} rx={n(rx * 0.4)} ry={n(ry * 0.42)} />}
        <circle className="ld-dog-glint" cx={n(cx - rx * 0.3)} cy={n(y - ry * 0.36)} r={n(Math.min(rx, ry) * 0.36)} />
      </g>
    );
  };
  const arc = (cx: number, from: number, to: number) => `M${n(cx - rx * 1.05)} ${n(from)}Q${n(cx)} ${n(to)} ${n(cx + rx * 1.05)} ${n(from)}`;
  const mouth = mouthGeometry(look);
  const brow = (cx: number) => `M${n(cx - rx * 1.1)} ${n(y - ry - 3.2)}Q${n(cx)} ${n(y - ry - 4.6)} ${n(cx + rx * 1.1)} ${n(y - ry - 3.2)}`;

  return (
    <svg
      ref={svg}
      viewBox="0 0 100 100"
      width={`${size}px`}
      height={`${size}px`}
      className="ld-dog"
      data-mood={mood}
      data-breed={breed}
      data-ears={look.ears.kind}
      data-paused={paused ? "" : undefined}
      data-blink={blinking ? "" : undefined}
      data-spin={spinMs ? "" : undefined}
      style={style}
      role={title ? "img" : undefined}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <clipPath id={`${uid}-head`}>
          <path d={look.head} />
        </clipPath>
        <radialGradient id={`${uid}-sheen`} cx="34%" cy="24%" r="78%">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.05" />
          <stop offset="1" stopColor="#000" stopOpacity="0.08" />
        </radialGradient>
      </defs>
      <g className="ld-dog-body">
        {shapes(look.back)}
        {!look.ears.front && ears}
        <path className="ld-dog-head ld-t-fur" d={look.head} />
        <g clipPath={`url(#${uid}-head)`}>{shapes(look.markings)}</g>
        <path d={look.head} fill={`url(#${uid}-sheen)`} />
        <g className="ld-dog-muzzle">{shapes(look.muzzle)}</g>
        {shapes(look.front)}
        {look.ears.front && ears}
        {look.details && (
          <g className="ld-dog-details" fill="none" strokeLinecap="round" strokeLinejoin="round">
            {look.details.map((line, index) => (
              <path key={index} className={`ld-s-${line.tone}`} d={line.d} strokeWidth={line.width} />
            ))}
          </g>
        )}
        <g className="ld-dog-gaze">
          <g className="ld-dog-eyes ld-dog-eyes--open">
            <g className="ld-dog-blink">{eye("l")}{eye("r")}</g>
          </g>
          <g className="ld-dog-eyes ld-dog-eyes--happy ld-s-ink" fill="none" strokeWidth="2.8" strokeLinecap="round">
            <path d={arc(x, y + ry * 0.35, y - ry * 1.25)} />
            <path d={arc(100 - x, y + ry * 0.35, y - ry * 1.25)} />
          </g>
          <g className="ld-dog-eyes ld-dog-eyes--closed ld-s-ink" fill="none" strokeWidth="2.6" strokeLinecap="round">
            <path d={arc(x, y - ry * 0.1, y + ry * 0.9)} />
            <path d={arc(100 - x, y - ry * 0.1, y + ry * 0.9)} />
          </g>
          <g className="ld-dog-brows ld-s-ink" fill="none" strokeWidth="2.2" strokeLinecap="round">
            <path className="ld-dog-brow ld-dog-brow--l" d={brow(x)} />
            <path className="ld-dog-brow ld-dog-brow--r" d={brow(100 - x)} />
          </g>
        </g>
        <g className="ld-dog-nose">
          <path className="ld-dog-tongue" d={tonguePath(mouth.join)} />
          <path className="ld-dog-mouth ld-s-ink" d={mouth.d} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path className="ld-t-ink" d={nosePath(look.nose.y, look.nose.w, look.nose.h)} />
          <ellipse className="ld-dog-glint" cx={n(50 - look.nose.w * 0.17)} cy={n(look.nose.y - look.nose.h * 0.22)} rx={n(look.nose.w * 0.15)} ry={n(look.nose.h * 0.12)} opacity="0.7" />
        </g>
      </g>
    </svg>
  );
}

export interface BreedAvatarHandle {
  blink(): void;
  spin(durationMs?: number): void;
  setExpression(index: number): void;
}

export interface BreedAvatarProps {
  breed: DogBreed;
  /** The dog's colour; every marking is a tone of it. */
  color: string;
  state?: DogState;
  size?: number;
  title?: string | null;
  /** Where the dog looks, each axis -1..1 (the pointer, or a caller's pin). */
  gaze?: { x?: number; y?: number };
  /** Hold the mood's pose without looping. */
  paused?: boolean;
}

export const BreedAvatar = forwardRef<BreedAvatarHandle, BreedAvatarProps>(function BreedAvatar(
  { breed, color, state, size = 44, title, gaze, paused = false },
  ref,
) {
  const [blinking, setBlinking] = useState(false);
  const [spinMs, setSpinMs] = useState(0);
  useImperativeHandle(ref, () => ({
    blink: () => setBlinking(true),
    spin: (durationMs = 700) => setSpinMs(Math.max(200, durationMs)),
    setExpression: () => {},
  }));
  useEffect(() => {
    if (!blinking) return;
    const timer = setTimeout(() => setBlinking(false), 180);
    return () => clearTimeout(timer);
  }, [blinking]);
  useEffect(() => {
    if (!spinMs) return;
    const timer = setTimeout(() => setSpinMs(0), spinMs);
    return () => clearTimeout(timer);
  }, [spinMs]);
  return (
    <DogFace look={BREEDS[breed] ?? BREEDS.dog} breed={breed} color={color} mood={dogMood(state)} size={size}
      title={title} gaze={gaze} paused={paused} blinking={blinking} spinMs={spinMs} />
  );
});
