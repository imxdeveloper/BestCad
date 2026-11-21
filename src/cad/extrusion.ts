import type { Part } from './types'

/** World-space start-cap position for one-sided and symmetric extrusions. */
export function getExtrusionOrigin(part: Part): Part['position'] {
  if (part.extrudeMode !== 'symmetric') return [...part.position]
  const plane = part.profilePlane ?? 'top'
  const depth = part.arbitraryPlane ? part.size[2] : part.size[plane === 'top' ? 1 : plane === 'front' ? 2 : 0]
  const direction = part.arbitraryPlane?.normal ?? (plane === 'top' ? [0, 1, 0] : plane === 'front' ? [0, 0, 1] : [1, 0, 0])
  const length = Math.hypot(...direction)
  if (!Number.isFinite(depth) || depth <= 0 || length < 1e-9) return [...part.position]
  return part.position.map((coordinate, index) => coordinate - direction[index] / length * depth / 2) as Part['position']
}
