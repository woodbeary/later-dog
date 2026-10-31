export interface Size {
  width: number;
  height: number;
}

export type Point = readonly [number, number];

export const TOOLSET_MAX_EDGE = 2576;
export const TOOLSET_MAX_VISUAL_TOKENS = 4784;
export const FRAME_LONG_EDGE = 1920;
export const FRAME_SHORT_EDGE = 1080;
const MAX_SCREEN_EDGE = 32_767;

export function visualTokens(size: Size): number {
  return Math.ceil(size.width / 28) * Math.ceil(size.height / 28);
}

export function withinToolsetLimits(size: Size): boolean {
  return Math.max(size.width, size.height) <= TOOLSET_MAX_EDGE && visualTokens(size) <= TOOLSET_MAX_VISUAL_TOKENS;
}

export function validScreen(size: Size): boolean {
  return [size.width, size.height].every((edge) => Number.isInteger(edge) && edge > 0 && edge <= MAX_SCREEN_EDGE);
}

export function frameSize(screen: Size): Size {
  if (!validScreen(screen)) throw new Error(`The desktop reported an unusable screen size (${screen.width}x${screen.height}).`);
  const landscape = screen.width >= screen.height;
  const boxWidth = landscape ? FRAME_LONG_EDGE : FRAME_SHORT_EDGE;
  const boxHeight = landscape ? FRAME_SHORT_EDGE : FRAME_LONG_EDGE;
  const scale = Math.min(1, boxWidth / screen.width, boxHeight / screen.height);
  return { width: Math.max(1, Math.floor(screen.width * scale)), height: Math.max(1, Math.floor(screen.height * scale)) };
}

export function sameSize(a: Size, b: Size): boolean {
  return a.width === b.width && a.height === b.height;
}

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

export function toScreen(point: Point, frame: Size, screen: Size): Point {
  return [
    clamp(Math.round((point[0] * screen.width) / frame.width), screen.width - 1),
    clamp(Math.round((point[1] * screen.height) / frame.height), screen.height - 1),
  ];
}

export function toFrame(point: Point, frame: Size, screen: Size): Point {
  return [
    clamp(Math.round((point[0] * frame.width) / screen.width), frame.width - 1),
    clamp(Math.round((point[1] * frame.height) / screen.height), frame.height - 1),
  ];
}
