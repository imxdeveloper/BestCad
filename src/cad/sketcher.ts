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
  if (points.length < 3) return points
  const n = points.length
  const offsetPoints: [number, number][] = []

  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]
    const curr = points[i]
    const next = points[(i + 1) % n]

    const d1x = curr[0] - prev[0]
    const d1y = curr[1] - prev[1]
    const len1 = Math.hypot(d1x, d1y) || 1
    const n1x = -d1y / len1
    const n1y = d1x / len1

    const d2x = next[0] - curr[0]
    const d2y = next[1] - curr[1]
    const len2 = Math.hypot(d2x, d2y) || 1
    const n2x = -d2y / len2
    const n2y = d2x / len2

    const avgNx = (n1x + n2x) / 2
    const avgNy = (n1y + n2y) / 2
    const avgLen = Math.hypot(avgNx, avgNy) || 1

    offsetPoints.push([
      curr[0] + (avgNx / avgLen) * distance,
      curr[1] + (avgNy / avgLen) * distance,
    ])
  }

  return offsetPoints
}
