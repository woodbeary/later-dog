export const DICTATION_BARS = 28;
export const DICTATION_TICK_MS = 80;
export const DICTATION_REST_LEVEL = 0.08;

const VOICE_SHAPE = [0.62, 1, 0.74, 0.9, 0.5, 0.84, 0.68, 0.96, 0.56, 0.8];
const ENERGY_DECAY = 0.82;
const ENERGY_PER_BURST = 0.4;
const ENERGY_PER_LETTER = 0.05;

export interface DictationMeter {
  levels: number[];
  energy: number;
  heard: number;
  tick: number;
}

export function freshDictationMeter(heard: number): DictationMeter {
  return { levels: [], energy: 0, heard, tick: 0 };
}

export function pushDictationLevel(levels: number[], level: number, count = DICTATION_BARS): number[] {
  const next = [...levels, Math.max(0, Math.min(1, level))];
  return next.length > count ? next.slice(next.length - count) : next;
}

export function stepDictationMeter(meter: DictationMeter, heard: number): DictationMeter {
  const grew = Math.max(0, heard - meter.heard);
  const energy = grew > 0
    ? Math.min(1, meter.energy + ENERGY_PER_BURST + grew * ENERGY_PER_LETTER)
    : meter.energy * ENERGY_DECAY;
  const tick = meter.tick + 1;
  const level = DICTATION_REST_LEVEL + energy * (1 - DICTATION_REST_LEVEL) * VOICE_SHAPE[tick % VOICE_SHAPE.length];
  return { levels: pushDictationLevel(meter.levels, level), energy, heard, tick };
}

export function paddedDictationLevels(levels: number[], count = DICTATION_BARS): number[] {
  if (levels.length >= count) return levels.slice(-count);
  return [...Array.from({ length: count - levels.length }, () => 0), ...levels];
}

export function dictationClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
