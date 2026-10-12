export interface BodyDef {
  id: string
  name: string
  d: string
  viewBox: [number, number, number, number]
  decorations?: string
}

type Sextet = [number, number, number, number, number, number]

function quadToCubic(
  x0: number, y0: number, cx: number, cy: number, x1: number, y1: number
): Sextet {
  return [
    x0 + (2 / 3) * (cx - x0), y0 + (2 / 3) * (cy - y0),
    x1 + (2 / 3) * (cx - x1), y1 + (2 / 3) * (cy - y1),
    x1, y1,
  ]
}

function lineToCubic(x0: number, y0: number, x1: number, y1: number): Sextet {
  return [
    x0 + (x1 - x0) / 3, y0 + (y1 - y0) / 3,
    x0 + (2 * (x1 - x0)) / 3, y0 + (2 * (y1 - y0)) / 3,
    x1, y1,
  ]
}

const KAPPA = 0.5522847498307936

function fmt(n: number): string {
  let s = n.toFixed(5)
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "")
  return s === "-0" ? "0" : s
}

class Path {
  private parts: string[] = []
  private origin: [number, number] = [0, 0]
  private at: [number, number] = [0, 0]

  moveTo(x: number, y: number): Path {
    this.parts.push("M" + fmt(x) + " " + fmt(y))
    this.origin = [x, y]
    this.at = [x, y]
    return this
  }

  curveTo(c: Sextet): Path {
    this.parts.push("C" + c.map(fmt).join(" "))
    this.at = [c[4], c[5]]
    return this
  }

  lineTo(x: number, y: number): Path {
    return this.curveTo(lineToCubic(this.at[0], this.at[1], x, y))
  }

  quadTo(cx: number, cy: number, x: number, y: number): Path {
    return this.curveTo(quadToCubic(this.at[0], this.at[1], cx, cy, x, y))
  }

  quarterTo(kx: number, ky: number, x: number, y: number): Path {
    const [x0, y0] = this.at
    return this.curveTo([
      x0 + (kx - x0) * KAPPA, y0 + (ky - y0) * KAPPA,
      x + (kx - x) * KAPPA, y + (ky - y) * KAPPA,
      x, y,
    ])
  }

  close(): string {
    const [x, y] = this.at
    const [sx, sy] = this.origin
    if (Math.abs(x - sx) > 1e-9 || Math.abs(y - sy) > 1e-9) this.lineTo(sx, sy)
    return this.parts.join("") + "Z"
  }
}

function buildEllipse(w: number, h: number): string {
  const rx = w / 2
  const ry = h / 2
  return new Path()
    .moveTo(100 + rx, 100)
    .quarterTo(100 + rx, 100 + ry, 100, 100 + ry)
    .quarterTo(100 - rx, 100 + ry, 100 - rx, 100)
    .quarterTo(100 - rx, 100 - ry, 100, 100 - ry)
    .quarterTo(100 + rx, 100 - ry, 100 + rx, 100)
    .close()
}

function buildRoundedBox(w: number, h: number, radius: number): string {
  const x = 100 - w / 2
  const y = 100 - h / 2
  const k = Math.min(radius, w / 2, h / 2)
  const wide = w - 2 * k > 1e-9
  const tall = h - 2 * k > 1e-9
  const p = new Path().moveTo(x + k, y)
  if (wide) p.lineTo(x + w - k, y)
  p.quarterTo(x + w, y, x + w, y + k)
  if (tall) p.lineTo(x + w, y + h - k)
  p.quarterTo(x + w, y + h, x + w - k, y + h)
  if (wide) p.lineTo(x + k, y + h)
  p.quarterTo(x, y + h, x, y + h - k)
  if (tall) p.lineTo(x, y + k)
  p.quarterTo(x, y, x + k, y)
  return p.close()
}

function buildBlob(w: number, h: number, wobble: number): string {
  const STEPS = 24
  const pts: [number, number][] = []
  for (let i = 0; i < STEPS; i++) {
    const a = (i / STEPS) * Math.PI * 2
    const r = 1 + Math.sin(a * 3 + 0.6) * 0.07 * wobble + Math.sin(a * 2 - 1.1) * 0.05 * wobble
    pts.push([100 + Math.cos(a) * (w / 2) * r, 100 + Math.sin(a) * (h / 2) * r])
  }
  const mid = (i: number): [number, number] => {
    const c = pts[i]
    const n = pts[(i + 1) % STEPS]
    return [(c[0] + n[0]) / 2, (c[1] + n[1]) / 2]
  }
  const p = new Path().moveTo(mid(0)[0], mid(0)[1])
  for (let i = 1; i < STEPS; i++) {
    const m = mid(i)
    p.quadTo(pts[i][0], pts[i][1], m[0], m[1])
  }
  const first = mid(0)
  p.quadTo(pts[0][0], pts[0][1], first[0], first[1])
  return p.close()
}

function buildDrop(w: number, h: number, belly: number): string {
  const hw = w / 2
  const top = 100 - h / 2
  const b = h * (0.3 + belly * 0.35)
  const waist = 100 + h / 2 - hw
  return new Path()
    .moveTo(100, top)
    .curveTo([100 + hw * 0.78, top + b * 0.75, 100 + hw, top + b, 100 + hw, waist])
    .quarterTo(100 + hw, waist + hw, 100, waist + hw)
    .quarterTo(100 - hw, waist + hw, 100 - hw, waist)
    .curveTo([100 - hw, top + b, 100 - hw * 0.78, top + b * 0.75, 100, top])
    .close()
}

function buildCone(w: number, h: number, tip: number, base: number): string {
  const hw = w / 2
  const hh = h / 2
  const t = hw * tip
  const b = hw * base * 0.55
  return new Path()
    .moveTo(100 - t, 100 - hh + t * 0.9)
    .quadTo(100, 100 - hh, 100 + t, 100 - hh + t * 0.9)
    .lineTo(100 + hw - b * 0.4, 100 + hh - b)
    .quadTo(100 + hw, 100 + hh, 100 + hw - b, 100 + hh)
    .lineTo(100 - hw + b, 100 + hh)
    .quadTo(100 - hw, 100 + hh, 100 - hw + b * 0.4, 100 + hh - b)
    .close()
}

const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
]

function buildPolygon(w: number, h: number, sides: number, round: number): string {
  const n = Math.max(3, Math.round(sides))
  const pts: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    pts.push([100 + Math.cos(a) * (w / 2), 100 + Math.sin(a) * (h / 2)])
  }
  const p = new Path()
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n]
    const cur = pts[i]
    const next = pts[(i + 1) % n]
    const a = lerp(cur, prev, round * 0.5)
    const b = lerp(cur, next, round * 0.5)
    if (i === 0) p.moveTo(a[0], a[1])
    else p.lineTo(a[0], a[1])
    p.quadTo(cur[0], cur[1], b[0], b[1])
  }
  return p.close()
}

const DOG_RIGHT: Sextet[] = [
  [120, 24, 134, 30, 142, 44],
  [160, 50, 182, 78, 184, 112],
  [185, 130, 174, 140, 160, 138],
  [156, 134, 150, 124, 146, 112],
  [144, 140, 128, 176, 100, 178],
]

const DOG_EAR = DOG_RIGHT.slice(1, 4)

const mirror = (c: Sextet): Sextet => [200 - c[0], c[1], 200 - c[2], c[3], 200 - c[4], c[5]]

function buildDog(): string {
  const right = DOG_RIGHT
  const starts: [number, number][] = [[100, 24]]
  for (const c of right) starts.push([c[4], c[5]])
  const p = new Path().moveTo(100, 24)
  for (const c of right) p.curveTo(c)
  for (let i = right.length - 1; i >= 0; i--) {
    const c = right[i]
    const s = starts[i]
    p.curveTo([200 - c[2], c[3], 200 - c[0], c[1], 200 - s[0], s[1]])
  }
  return p.close()
}

function buildDogEar(side: "left" | "right"): string {
  const curves = side === "right" ? DOG_EAR : DOG_EAR.map(mirror)
  const sx = side === "right" ? 1 : -1
  const x = (v: number) => (side === "right" ? v : 200 - v)
  const p = new Path().moveTo(x(136), 44).lineTo(x(142), 44)
  for (const c of curves) p.curveTo(c)
  p.curveTo([x(146) - 6 * sx, 110, x(136), 90, x(136), 62])
  return p.close()
}

function buildDogDecorations(): string {
  const part = (side: "left" | "right") =>
    `<path class="mascot-part mascot-ear mascot-ear--${side}" fill="{{GRADIENT}}" d="${buildDogEar(side)}"/>`
  return part("left") + part("right")
}

export const BODY_DEFS: BodyDef[] = [
  { id: "dog", name: "Retriever", d: buildDog(), viewBox: [0, 0, 200, 200], decorations: buildDogDecorations() },
  ...([["beagle", "Beagle"], ["shepherd", "Shepherd"], ["corgi", "Corgi"], ["husky", "Husky"], ["pug", "Pug"], ["poodle", "Poodle"], ["chihuahua", "Chihuahua"]] as const)
    .map(([id, name]): BodyDef => ({ id, name, d: buildEllipse(200, 190), viewBox: [0, 0, 200, 200] })),
  { id: "blob", name: "Blob", d: buildBlob(200, 200, 0.35), viewBox: [-5, -5, 210, 210] },
  { id: "circle", name: "Circle", d: buildEllipse(200, 200), viewBox: [0, 0, 200, 200] },
  { id: "squircle", name: "Squircle", d: buildRoundedBox(200, 200, (Math.min(200, 200) / 2) * 0.5), viewBox: [0, 0, 200, 200] },
  { id: "capsule", name: "Capsule", d: buildRoundedBox(150, 200, Math.min(150, 200) / 2), viewBox: [0, 0, 200, 200] },
  { id: "drop", name: "Drop", d: buildDrop(156, 194, 0.62), viewBox: [0, 0, 200, 200] },
  { id: "shield", name: "Shield", d: buildCone(190, 200, 0.45, 0.9), viewBox: [0, 0, 200, 200] },
  { id: "hexagon", name: "Hexagon", d: buildPolygon(196, 196, 6, 0.12), viewBox: [0, 0, 200, 200] },
  { id: "diamond", name: "Diamond", d: buildPolygon(196, 196, 4, 0.12), viewBox: [0, 0, 200, 200] },
]

export const BODY_IDS: string[] = BODY_DEFS.map(s => s.id)
