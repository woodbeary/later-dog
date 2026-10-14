export const DURATION = {
  instant: 50,
  fast: 100,
  normal: 150,
  slow: 200,
  slower: 300,
} as const;

export const MOTION = {
  ...DURATION,
  micro: DURATION.fast,
  base: DURATION.slow,
  enter: DURATION.slower,
  exit: DURATION.slower,
} as const;

export const EASE = {
  enter: "cubic-bezier(0.16, 1, 0.3, 1)",
  exit: "cubic-bezier(0.4, 0, 1, 1)",
  loop: "cubic-bezier(0.45, 0, 0.55, 1)",
} as const;

export interface Spring {
  mass: number;
  stiffness: number;
  damping: number;
}

export const SPRINGS = {
  standard: { mass: 1, stiffness: 175, damping: 26 },
  slow: { mass: 1, stiffness: 100, damping: 20 },
  bounce: { mass: 1, stiffness: 175, damping: 18.5 },
} as const satisfies Record<string, Spring>;

export const PRESS_SCALE = 0.93;

const SETTLED = 0.01;
const SAMPLES = 32;

function stepResponse({ mass, stiffness, damping }: Spring, seconds: number): number {
  const natural = Math.sqrt(stiffness / mass);
  const ratio = damping / (2 * Math.sqrt(stiffness * mass));
  if (ratio >= 1) {
    return 1 - Math.exp(-natural * seconds) * (1 + natural * seconds);
  }
  const damped = natural * Math.sqrt(1 - ratio * ratio);
  const decay = Math.exp(-ratio * natural * seconds);
  return 1 - decay * (Math.cos(damped * seconds) + ((ratio * natural) / damped) * Math.sin(damped * seconds));
}

export function springDuration(spring: Spring): number {
  let seconds = 0;
  let lastOutside = 0;
  while (seconds < 5) {
    if (Math.abs(1 - stepResponse(spring, seconds)) > SETTLED) lastOutside = seconds;
    seconds += 0.005;
  }
  return Math.round((lastOutside + 0.005) * 1000);
}

export function springEasing(spring: Spring): string {
  const total = springDuration(spring) / 1000;
  const stops: string[] = [];
  for (let step = 0; step <= SAMPLES; step += 1) {
    const value = step === SAMPLES ? 1 : stepResponse(spring, (total * step) / SAMPLES);
    stops.push(String(Math.round(value * 1000) / 1000));
  }
  return `linear(${stops.join(", ")})`;
}
