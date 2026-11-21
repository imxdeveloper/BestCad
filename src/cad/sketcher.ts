import type { SketchEntity, SketchConstraint } from './types'
import { solveCoupledConstraints } from './constraintSolver'

export { solveCoupledConstraints }

export function solveSketchConstraints(
  entities: SketchEntity[],
  constraints: SketchConstraint[],
  maxIterations = 50,
): SketchEntity[] {
  if (!constraints || constraints.length === 0) return entities
  const result = solveCoupledConstraints(entities, constraints, maxIterations)
  return result.solvedEntities
}

export function offsetPolygon(points: [number, number][], distance: number): [number, number][] {
  if (points.length < 3 || !Number.isFinite(distance)) return points.map((point) => [...point] as [number, number])
  const area = points.reduce((sum, point, i) => {
    const next = points[(i + 1) % points.length]
    return sum + point[0] * next[1] - next[0] * point[1]
  }, 0) / 2
  const orientation = area >= 0 ? 1 : -1
  const shiftedEdges = points.map((point, i) => {
    const next = points[(i + 1) % points.length]
    const dx = next[0] - point[0]
    const dy = next[1] - point[1]
    const length = Math.hypot(dx, dy)
    if (length <= 1e-12) return null
    // Positive distance moves outward, independent of polygon winding.
    const nx = orientation * dy / length
    const ny = -orientation * dx / length
    return { point: [point[0] + nx * distance, point[1] + ny * distance] as [number, number], direction: [dx, dy] as [number, number] }
  })
  if (shiftedEdges.some((edge) => !edge)) return points.map((point) => [...point] as [number, number])
  return points.map((_, i) => {
    const previous = shiftedEdges[(i - 1 + points.length) % points.length]!
    const current = shiftedEdges[i]!
    const cross = previous.direction[0] * current.direction[1] - previous.direction[1] * current.direction[0]
    if (Math.abs(cross) < 1e-10) return current.point
    const dx = current.point[0] - previous.point[0]
    const dy = current.point[1] - previous.point[1]
    const t = (dx * current.direction[1] - dy * current.direction[0]) / cross
    const intersection: [number, number] = [previous.point[0] + previous.direction[0] * t, previous.point[1] + previous.direction[1] * t]
    // Bound extreme miters when a large offset approaches a sharp corner.
    return Math.hypot(intersection[0] - points[i][0], intersection[1] - points[i][1]) <= Math.max(Math.abs(distance) * 20, 1000) ? intersection : current.point
  })
}

export function offsetOpenPath(points: [number, number][], distance: number): [number, number][] {
  if (points.length < 2 || !Number.isFinite(distance)) return points.map((point) => [...point] as [number, number])
  return points.map((point, i) => {
    const before = points[Math.max(0, i - 1)]
    const after = points[Math.min(points.length - 1, i + 1)]
    const dx = after[0] - before[0]
    const dy = after[1] - before[1]
    const length = Math.hypot(dx, dy) || 1
    return [point[0] - dy / length * distance, point[1] + dx / length * distance]
  })
}
