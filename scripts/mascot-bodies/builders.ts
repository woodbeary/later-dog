/**
 * The ten catalog outlines, as absolute cubic path data.
 *
 * Adapted from Blob Studio's studio/src/shapes/builtin.ts at fixed parameters.
 * Cubics only, because the phone's twenty-line path parser understands `M`, `C`
 * and `Z` and nothing else — emitting anything richer here would mean growing a
 * parser on the platform least able to afford it.
 *
 * Every generated outline is one closed, non-self-intersecting subpath centred on
 * (100, 100) of a 200x200 stage, wound the same way, so its interior is
 * unambiguous under the non-zero winding rule however the later rasteriser walks
 * it. `viewBox` is advisory and must not be used to normalise — see the note on
 * the field.
 */

export interface BodyDef {
  id: string
  name: string
  /** Absolute cubic path data: `M`, `C` and `Z` only. */
  d: string
  /**
   * `[minX, minY, width, height]` of the artwork's nominal canvas — advisory only.
   *
   * Do not normalise against this. Derive bounds by flattening the path, because
   * `blob`'s deliberately disagrees with its box: it is padded past the 200x200 stage
   * so its lobe is not shaved off.
   */
  viewBox: [number, number, number, number]
  /**
   * Optional parts drawn over the body in the same gradient, as raw SVG markup in the
   * outline's own coordinate space with `{{GRADIENT}}` where the body's paint goes. They
   * are decoration only: the solver sizes the face against `d`, the clip is `d`, and the
   * native catalogs (which draw the outline alone) never see them. Each part carries a
   * stable class so `src/styles.css` can move it with the mascot state.
   */
  decorations?: string
}

type Sextet = [number, number, number, number, number, number]

/** Quadratic control point to its exact cubic pair. */
function quadToCubic(
  x0: number, y0: number, cx: number, cy: number, x1: number, y1: number
): Sextet {
  return [
    x0 + (2 / 3) * (cx - x0), y0 + (2 / 3) * (cy - y0),
    x1 + (2 / 3) * (cx - x1), y1 + (2 / 3) * (cy - y1),
    x1, y1,
  ]
}

/** A straight run as a degenerate cubic, so the emitted path stays cubics-only. */
function lineToCubic(x0: number, y0: number, x1: number, y1: number): Sextet {
  return [
    x0 + (x1 - x0) / 3, y0 + (y1 - y0) / 3,
    x0 + (2 * (x1 - x0)) / 3, y0 + (2 * (y1 - y0)) / 3,
    x1, y1,
  ]
}

/** Circular-arc magic number: four cubics approximate a circle to ~0.02%. */
const KAPPA = 0.5522847498307936

/**
 * Fixed-point to five decimals, trailing zeros trimmed.
 *
 * Never exponent notation: the iOS parser is a character scanner that reads every
 * letter as a command, so a stray `e` would be taken for a curve and would
 * silently corrupt the outline.
 */
function fmt(n: number): string {
  let s = n.toFixed(5)
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "")
  return s === "-0" ? "0" : s
}

/** Accumulates `M`/`C`/`Z`, closing the ring with a real cubic rather than leaning on `Z`. */
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

  /** Absolute cubic from the current point. */
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

  /**
   * One quarter of an axis-aligned ellipse, from the current point to (x, y),
   * bulging towards the corner (kx, ky) — the point where the tangents at the two
   * ends meet, i.e. the box corner the arc rounds off. Reads like `quadTo`, but
   * pulls each control point only KAPPA of the way to the corner instead of 2/3,
   * which is what makes the result a circle rather than a parabola.
   */
  quarterTo(kx: number, ky: number, x: number, y: number): Path {
    const [x0, y0] = this.at
    return this.curveTo([
      x0 + (kx - x0) * KAPPA, y0 + (ky - y0) * KAPPA,
      x + (kx - x) * KAPPA, y + (ky - y) * KAPPA,
      x, y,
    ])
  }

  /** Closes the ring, adding a straight cubic back to the start if we are not already there. */
  close(): string {
    const [x, y] = this.at
    const [sx, sy] = this.origin
    if (Math.abs(x - sx) > 1e-9 || Math.abs(y - sy) > 1e-9) this.lineTo(sx, sy)
    return this.parts.join("") + "Z"
  }
}

/* ------------------------------------------------------------------ builders */

/** Blob Studio's `circle`, as four KAPPA quarters instead of two `A` halves. */
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

/**
 * Blob Studio's `roundedBox`, with its quadratic corners promoted to KAPPA arcs.
 * Quadratics bulge visibly at a 75-unit radius, and the capsule's caps are meant
 * to be circles.
 */
function buildRoundedBox(w: number, h: number, radius: number): string {
  const x = 100 - w / 2
  const y = 100 - h / 2
  const k = Math.min(radius, w / 2, h / 2)
  // A cap that eats the whole side leaves a zero-length run; skip it rather than
  // emit a degenerate cubic the rasteriser would have to special-case.
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

/**
 * Blob Studio's `blob`: a circle whose radius breathes around the turn, drawn as
 * quadratics through the midpoints between successive samples. Each quadratic
 * becomes its exact cubic, so the curve is unchanged, not re-fitted.
 */
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

/**
 * Blob Studio's `drop`. Its two `C` segments carry over untouched; its one `A`
 * — a semicircle of radius `hw` across the bottom — becomes two KAPPA quarters.
 */
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

/** Blob Studio's `cone`: quadratics via `quadToCubic`, straight runs via `lineToCubic`. */
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

/** Blob Studio's `hex`: each vertex cut back along both its edges and arced across. */
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

/* ------------------------------------------------------------------ catalog */

/**
 * later.dog's own body: a round head with two floppy ears hanging past the cheeks, as one
 * silhouette. The ears are lobes on the outline rather than separate shapes, so the interior
 * stays one roomy head and the face solver finds a large circle here.
 * Drawn clockwise from the crown: the right half is authored, the left half is the same
 * curves mirrored and walked back up to the crown. The notch where each ear meets the
 * cheek is a real concave corner: its two curves leave the point in different directions.
 */
const DOG_RIGHT: Sextet[] = [
  [120, 24, 134, 30, 142, 44],     // crown to the root of the right ear
  [160, 50, 182, 78, 184, 112],    // the ear's outer edge, falling past the cheek
  [185, 130, 174, 140, 160, 138],  // the ear's rounded tip
  [156, 134, 150, 124, 146, 112],  // its inner edge, up into the cheek notch
  [144, 140, 128, 176, 100, 178],  // cheek down to the chin
]

/** The three curves of `DOG_RIGHT` that are the ear: outer edge, tip, inner edge. */
const DOG_EAR = DOG_RIGHT.slice(1, 4)

/** Mirrors a cubic across the stage's vertical centre line. */
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

/**
 * The dog's ears as two separate parts, so CSS can swing each one with the mascot's
 * state while the outline underneath stays the solver's and the clip's truth.
 *
 * Each part traces the silhouette's own ear curves exactly — outer edge, tip and inner
 * edge are `DOG_EAR` verbatim, so at rest the part sits on the lobe pixel for pixel —
 * and closes through the inside of the head, where the same gradient hides the seam.
 * The closing run starts 6 units in from the ear's root and ends at the cheek notch,
 * which keeps it inside the head through every pose the stylesheet uses (a few degrees
 * about the root, a few units of travel). The hinge is that root, (142, 44): the point
 * where the crown turns into the ear.
 */
function buildDogEar(side: "left" | "right"): string {
  const curves = side === "right" ? DOG_EAR : DOG_EAR.map(mirror)
  const sx = side === "right" ? 1 : -1
  const x = (v: number) => (side === "right" ? v : 200 - v)
  const p = new Path().moveTo(x(136), 44).lineTo(x(142), 44)
  for (const c of curves) p.curveTo(c)
  // from the notch, back inside the head and up to the start
  p.curveTo([x(146) - 6 * sx, 110, x(136), 90, x(136), 62])
  return p.close()
}

function buildDogDecorations(): string {
  const part = (side: "left" | "right") =>
    `<path class="mascot-part mascot-ear mascot-ear--${side}" fill="{{GRADIENT}}" d="${buildDogEar(side)}"/>`
  return part("left") + part("right")
}

/** The catalog in persisted order: the eight dog breeds first (`dog`, the Retriever, is the default), then the shapes. */
export const BODY_DEFS: BodyDef[] = [
  { id: "dog", name: "Retriever", d: buildDog(), viewBox: [0, 0, 200, 200], decorations: buildDogDecorations() },
  // The other breeds. The desktop draws every breed with DogAvatar (src/components/DogAvatar.tsx); the outline here is
  // the round head the face solver and the native catalogs use, so a breed chosen on the desktop still renders anywhere.
  ...([["beagle", "Beagle"], ["shepherd", "Shepherd"], ["corgi", "Corgi"], ["husky", "Husky"], ["pug", "Pug"], ["poodle", "Poodle"], ["chihuahua", "Chihuahua"]] as const)
    .map(([id, name]): BodyDef => ({ id, name, d: buildEllipse(200, 190), viewBox: [0, 0, 200, 200] })),
  // The wobble pushes lobes past the nominal 200x200 stage — its radius factor peaks at
  // 1.042, so the outline reaches 4.2 units outside. Its box is padded to hold that: a
  // 200x200 viewBox here would let the scanline pass silently shave the top lobe flat.
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
