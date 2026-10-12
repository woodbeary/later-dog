import {
  EXPRESSIONS,
  FACE_CENTRE,
  GAZE,
  GAZE_TRAVEL,
  MOUTHS,
  MOUTH_STROKE,
  mouthFrame,
} from "../../src/components/cursor-face-data.ts"
import { sampleSdf, type Sdf } from "./sdf.ts"

const PAD = 2

interface Cloud {
  points: Float32Array
  need: Float32Array
}

export interface Aim {
  x: number
  y: number
}

export function buildClouds(
  lookAround: number,
  mouthStroke = MOUTH_STROKE,
  aim: Aim = { x: 0, y: 0 }
): Cloud[] {
  const aimX = clamp(aim.x, -1, 1) * GAZE_TRAVEL.x
  const aimY = clamp(aim.y, -1, 1) * GAZE_TRAVEL.y
  const eyePad = PAD
  return EXPRESSIONS.map((ex, k) => {
    const ox = GAZE[k][0] * lookAround + aimX
    const oy = GAZE[k][1] * lookAround + aimY
    const rings = ex.map(ring => ring.map(p => [p[0] + ox, p[1] + oy] as [number, number]))

    const xs: number[] = []
    const needs: number[] = []
    for (const ring of rings) {
      for (const p of ring) {
        xs.push(p[0] - FACE_CENTRE[0], p[1] - FACE_CENTRE[1])
        needs.push(eyePad)
      }
    }

    const spec = MOUTHS[k]
    const frame = mouthFrame(rings, spec)
    const ca = Math.cos(frame.angle)
    const sa = Math.sin(frame.angle)
    const half = mouthStroke / 2
    for (let i = 0; i <= 16; i++) {
      const t = i / 16
      const lx = (1 - t) * (1 - t) * -spec[0] + t * t * spec[0]
      const ly = 2 * (1 - t) * t * spec[1]
      xs.push(
        frame.x + lx * ca - ly * sa - FACE_CENTRE[0],
        frame.y + lx * sa + ly * ca - FACE_CENTRE[1]
      )
      needs.push(PAD + half)
    }

    return { points: new Float32Array(xs), need: new Float32Array(needs) }
  })
}

function clearanceOf(cloud: Cloud, sdf: Sdf, ax: number, ay: number, scale: number): number {
  let worst = Infinity
  const pts = cloud.points
  for (let i = 0, n = 0; i < pts.length; i += 2, n++) {
    const margin = sampleSdf(sdf, ax + pts[i] * scale, ay + pts[i + 1] * scale) - cloud.need[n]
    if (margin < worst) {
      worst = margin
      if (worst < 0) return worst
    }
  }
  return worst
}

function worstAcross(clouds: Cloud[], sdf: Sdf, ax: number, ay: number, scale: number): number {
  let worst = Infinity
  for (const cloud of clouds) {
    const c = clearanceOf(cloud, sdf, ax, ay, scale)
    if (c < worst) {
      worst = c
      if (worst < 0) return worst
    }
  }
  return worst
}

export function maxScaleAt(clouds: Cloud[], sdf: Sdf, ax: number, ay: number, cap: number): number {
  if (worstAcross(clouds, sdf, ax, ay, 0.02) < 0) return 0
  let lo = 0.02
  let hi = cap
  if (worstAcross(clouds, sdf, ax, ay, hi) >= 0) return hi
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2
    if (worstAcross(clouds, sdf, ax, ay, mid) >= 0) lo = mid
    else hi = mid
  }
  return lo
}

export function report(
  clouds: Cloud[],
  sdf: Sdf,
  anchor: { x: number; y: number; scale: number }
): { clipping: number[]; clearance: number } {
  const clipping: number[] = []
  let clearance = Infinity
  clouds.forEach((cloud, i) => {
    const c = clearanceOf(cloud, sdf, anchor.x, anchor.y, anchor.scale)
    if (c < 0) clipping.push(i)
    if (c < clearance) clearance = c
  })
  return { clipping, clearance: Math.round(clearance * 10) / 10 }
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
