import { FACE_BOX } from "../../src/components/cursor-face-data.ts"

type Point = [number, number]

interface Edge {
  y0: number
  y1: number
  x0: number
  slope: number
  winding: 1 | -1
}

interface Crossing {
  x: number
  winding: 1 | -1
}

function edgesOf(points: Point[]): Edge[] {
  const edges: Edge[] = []
  const n = points.length
  for (let i = 0; i < n; i++) {
    const [ax, ay] = points[i]
    const [bx, by] = points[(i + 1) % n]
    if (ay === by) continue
    if (ay < by) {
      edges.push({ y0: ay, y1: by, x0: ax, slope: (bx - ax) / (by - ay), winding: 1 })
    } else {
      edges.push({ y0: by, y1: ay, x0: bx, slope: (ax - bx) / (ay - by), winding: -1 })
    }
  }
  return edges
}

function fillSpan(
  mask: Uint8Array, row: number, spanStartX: number, spanEndX: number, unitsPerPixel: number, size: number
): void {
  const startPx = Math.max(0, Math.ceil(spanStartX / unitsPerPixel - 0.5))
  const endPx = Math.min(size - 1, Math.ceil(spanEndX / unitsPerPixel - 0.5) - 1)
  for (let px = startPx; px <= endPx; px++) mask[row + px] = 1
}

export function maskFromPolylines(polylines: Point[][], size = 256): Uint8Array {
  const mask = new Uint8Array(size * size)
  const unitsPerPixel = FACE_BOX / size

  const edges: Edge[] = []
  for (const line of polylines) {
    if (line.length < 2) continue
    edges.push(...edgesOf(line))
  }
  if (edges.length === 0) return mask

  for (let py = 0; py < size; py++) {
    const y = (py + 0.5) * unitsPerPixel

    const crossings: Crossing[] = []
    for (const edge of edges) {
      if (y < edge.y0 || y >= edge.y1) continue
      const x = edge.x0 + (y - edge.y0) * edge.slope
      crossings.push({ x, winding: edge.winding })
    }
    if (crossings.length === 0) continue
    crossings.sort((a, b) => a.x - b.x)

    const row = py * size
    let winding = 0
    let spanStartX = 0
    for (const crossing of crossings) {
      const wasInside = winding !== 0
      winding += crossing.winding
      const isInside = winding !== 0

      if (!wasInside && isInside) {
        spanStartX = crossing.x
      } else if (wasInside && !isInside) {
        fillSpan(mask, row, spanStartX, crossing.x, unitsPerPixel, size)
      }
    }
  }

  return mask
}
