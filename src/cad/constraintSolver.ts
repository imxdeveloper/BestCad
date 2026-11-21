import type { NonLinearConstraint, SketchEntity, SolverDiagnostics } from './types'

export type ConstraintPointRef = {
  entityId: string
  pointIndex: number
  varIdxX: number
  varIdxY: number
}

/**
 * Coupled Non-Linear Geometric Constraint Solver
 * Implements the Levenberg-Marquardt (LM) iterative non-linear optimization
 * with numerical Jacobian evaluation to solve coupled CAD constraints.
 */
export function solveCoupledConstraints(
  entities: SketchEntity[],
  constraints: NonLinearConstraint[],
  maxIterations = 40,
  tolerance = 1e-4,
): {
  solvedEntities: SketchEntity[]
  diagnostics: SolverDiagnostics
} {
  if (!constraints || constraints.length === 0) {
    // Count raw DOFs (2 DOFs per point)
    let totalPoints = 0
    entities.forEach((e) => { totalPoints += e.points.length })
    return {
      solvedEntities: entities,
      diagnostics: {
        status: 'under_defined',
        dof: totalPoints * 2,
        residual: 0,
        iterations: 0,
        converged: true,
      },
    }
  }

  // Deep clone entities to preserve immutability
  const cloned: SketchEntity[] = entities.map((ent) => ({
    ...ent,
    points: ent.points.map((p) => [p[0], p[1]] as [number, number]),
  }))

  // Map each unique point to state vector indices [x_0, y_0, x_1, y_1, ...]
  const pointMap: { entity: SketchEntity; ptIdx: number; xIdx: number; yIdx: number }[] = []
  let varCount = 0

  cloned.forEach((entity) => {
    entity.points.forEach((_, ptIdx) => {
      pointMap.push({
        entity,
        ptIdx,
        xIdx: varCount++,
        yIdx: varCount++,
      })
    })
  })

  // State vector x
  const x = new Float64Array(varCount)
  pointMap.forEach(({ entity, ptIdx, xIdx, yIdx }) => {
    x[xIdx] = entity.points[ptIdx][0]
    x[yIdx] = entity.points[ptIdx][1]
  })

  // Evaluates the constraint residual vector F(x)
  const evaluateResiduals = (state: Float64Array): number[] => {
    const residuals: number[] = []

    const readPt = (entityId: string, ptIndex: number): [number, number] => {
      const entry = pointMap.find((m) => m.entity.id === entityId && m.ptIdx === ptIndex)
      if (!entry) return [0, 0]
      return [state[entry.xIdx], state[entry.yIdx]]
    }

    for (const c of constraints) {
      if (c.type === 'horizontal') {
        const ent = cloned.find((e) => e.id === c.entityIds[0])
        if (ent && ent.points.length >= 2) {
          const p1 = readPt(ent.id, 0)
          const p2 = readPt(ent.id, 1)
          residuals.push(p2[1] - p1[1]) // y2 - y1 = 0
        }
      } else if (c.type === 'vertical') {
        const ent = cloned.find((e) => e.id === c.entityIds[0])
        if (ent && ent.points.length >= 2) {
          const p1 = readPt(ent.id, 0)
          const p2 = readPt(ent.id, 1)
          residuals.push(p2[0] - p1[0]) // x2 - x1 = 0
        }
      } else if (c.type === 'coincident') {
        if (c.entityIds.length >= 2) {
          const idxA = c.pointIndices ? c.pointIndices[0] : 0
          const idxB = c.pointIndices ? c.pointIndices[1] : 0
          const pA = readPt(c.entityIds[0], idxA)
          const pB = readPt(c.entityIds[1], idxB)
          residuals.push(pA[0] - pB[0]) // xA - xB = 0
          residuals.push(pA[1] - pB[1]) // yA - yB = 0
        }
      } else if (c.type === 'distance') {
        const targetDist = c.value ?? 10.0
        const idxA = c.pointIndices ? c.pointIndices[0] : 0
        const idxB = c.pointIndices ? c.pointIndices[1] : 1
        const entA = c.entityIds[0]
        const entB = c.entityIds[1] || entA
        const pA = readPt(entA, idxA)
        const pB = readPt(entB, idxB)
        const currentDist = Math.hypot(pA[0] - pB[0], pA[1] - pB[1])
        residuals.push(currentDist - targetDist)
      } else if (c.type === 'parallel') {
        if (c.entityIds.length >= 2) {
          const p1 = readPt(c.entityIds[0], 0)
          const p2 = readPt(c.entityIds[0], 1)
          const q1 = readPt(c.entityIds[1], 0)
          const q2 = readPt(c.entityIds[1], 1)
          const dx1 = p2[0] - p1[0], dy1 = p2[1] - p1[1]
          const dx2 = q2[0] - q1[0], dy2 = q2[1] - q1[1]
          // Cross product of 2D direction vectors = dx1*dy2 - dy1*dx2 = 0
          residuals.push(dx1 * dy2 - dy1 * dx2)
        }
      } else if (c.type === 'perpendicular') {
        if (c.entityIds.length >= 2) {
          const p1 = readPt(c.entityIds[0], 0)
          const p2 = readPt(c.entityIds[0], 1)
          const q1 = readPt(c.entityIds[1], 0)
          const q2 = readPt(c.entityIds[1], 1)
          const dx1 = p2[0] - p1[0], dy1 = p2[1] - p1[1]
          const dx2 = q2[0] - q1[0], dy2 = q2[1] - q1[1]
          // Dot product = dx1*dx2 + dy1*dy2 = 0
          residuals.push(dx1 * dx2 + dy1 * dy2)
        }
      } else if (c.type === 'equal_length') {
        if (c.entityIds.length >= 2) {
          const p1 = readPt(c.entityIds[0], 0)
          const p2 = readPt(c.entityIds[0], 1)
          const q1 = readPt(c.entityIds[1], 0)
          const q2 = readPt(c.entityIds[1], 1)
          const l1 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
          const l2 = Math.hypot(q2[0] - q1[0], q2[1] - q1[1])
          residuals.push(l1 - l2)
        }
      } else if (c.type === 'angle') {
        if (c.entityIds.length >= 2) {
          const p1 = readPt(c.entityIds[0], 0)
          const p2 = readPt(c.entityIds[0], 1)
          const q1 = readPt(c.entityIds[1], 0)
          const q2 = readPt(c.entityIds[1], 1)
          const dx1 = p2[0] - p1[0], dy1 = p2[1] - p1[1]
          const dx2 = q2[0] - q1[0], dy2 = q2[1] - q1[1]
          const currentAngle = Math.atan2(dx1 * dy2 - dy1 * dx2, dx1 * dx2 + dy1 * dy2)
          const targetAngle = ((c.value ?? 0) * Math.PI) / 180
          const difference = currentAngle - targetAngle
          residuals.push(Math.atan2(Math.sin(difference), Math.cos(difference)))
        }
      } else if (c.type === 'tangent') {
        // Line to Circle tangency: distance from circle center to line equals circle radius
        const lineId = c.entityIds[0]
        const circleId = c.entityIds[1]
        const p1 = readPt(lineId, 0)
        const p2 = readPt(lineId, 1)
        const center = readPt(circleId, 0)
        const circleEnt = cloned.find((e) => e.id === circleId)
        const radius = circleEnt?.radius ?? (circleEnt?.points[1] ? Math.hypot(circleEnt.points[1][0] - circleEnt.points[0][0], circleEnt.points[1][1] - circleEnt.points[0][1]) : 2.0)

        // Point-line distance formula
        const dx = p2[0] - p1[0], dy = p2[1] - p1[1]
        const len = Math.hypot(dx, dy) || 1
        const dist = Math.abs(dy * center[0] - dx * center[1] + p2[0] * p1[1] - p2[1] * p1[0]) / len
        residuals.push(dist - radius)
      } else if (c.type === 'fixed') {
        const pointIndex = c.pointIndices ? c.pointIndices[0] : 0
        const p = readPt(c.entityIds[0], pointIndex)
        const originalPoint = cloned.find((entity) => entity.id === c.entityIds[0])?.points[pointIndex] ?? [p[0], p[1]]
        residuals.push(p[0] - (c.value ?? originalPoint[0]))
        residuals.push(p[1] - originalPoint[1])
      }
    }

    return residuals
  }

  // Levenberg-Marquardt Non-Linear Optimization Loop
  let lambda = 1e-3
  let iter = 0
  let currentResiduals = evaluateResiduals(x)
  let currentCost = currentResiduals.reduce((sum, r) => sum + r * r, 0)

  const numEquations = currentResiduals.length

  while (iter < maxIterations && currentCost > tolerance * tolerance) {
    iter++

    // Compute Numerical Jacobian matrix J (M equations x N variables)
    const J: number[][] = Array.from({ length: numEquations }, () => new Array(varCount).fill(0))
    const h = 1e-6

    for (let j = 0; j < varCount; j++) {
      const orig = x[j]
      x[j] = orig + h
      const rPlus = evaluateResiduals(x)
      x[j] = orig - h
      const rMinus = evaluateResiduals(x)
      x[j] = orig // restore

      for (let i = 0; i < numEquations; i++) {
        J[i][j] = (rPlus[i] - rMinus[i]) / (2 * h)
      }
    }

    // Normal Equations: (J^T * J + lambda * I) * delta = -J^T * r
    const JtJ: number[][] = Array.from({ length: varCount }, () => new Array(varCount).fill(0))
    const JtR: number[] = new Array(varCount).fill(0)

    for (let i = 0; i < varCount; i++) {
      for (let j = 0; j < varCount; j++) {
        let sum = 0
        for (let k = 0; k < numEquations; k++) {
          sum += J[k][i] * J[k][j]
        }
        JtJ[i][j] = sum
      }
      // Damping on diagonal
      JtJ[i][i] += lambda * Math.max(1e-3, JtJ[i][i])

      let rSum = 0
      for (let k = 0; k < numEquations; k++) {
        rSum += J[k][i] * currentResiduals[k]
      }
      JtR[i] = -rSum
    }

    // Solve linear system: JtJ * delta = JtR
    const delta = solveLinearSystem(JtJ, JtR)
    if (!delta) {
      lambda *= 10
      continue
    }

    // Trial state
    const trialX = new Float64Array(varCount)
    for (let i = 0; i < varCount; i++) trialX[i] = x[i] + delta[i]

    const trialResiduals = evaluateResiduals(trialX)
    const trialCost = trialResiduals.reduce((sum, r) => sum + r * r, 0)

    if (trialCost < currentCost) {
      // Step accepted!
      x.set(trialX)
      currentResiduals = trialResiduals
      currentCost = trialCost
      lambda = Math.max(1e-7, lambda / 10)
    } else {
      // Step rejected, increase damping
      lambda *= 10
    }
  }

  // Write solved coordinates back to entities
  pointMap.forEach(({ entity, ptIdx, xIdx, yIdx }) => {
    entity.points[ptIdx][0] = Number(x[xIdx].toFixed(4))
    entity.points[ptIdx][1] = Number(x[yIdx].toFixed(4))
  })

  // Estimate independent constraints from the final Jacobian. Counting equations
  // alone overstates how many degrees of freedom have actually been removed when
  // constraints are redundant or geometrically dependent.
  const jacobian: number[][] = Array.from({ length: numEquations }, () => new Array(varCount).fill(0))
  const h = 1e-6
  for (let column = 0; column < varCount; column++) {
    const original = x[column]
    x[column] = original + h
    const plus = evaluateResiduals(x)
    x[column] = original - h
    const minus = evaluateResiduals(x)
    x[column] = original
    for (let row = 0; row < numEquations; row++) jacobian[row][column] = (plus[row] - minus[row]) / (2 * h)
  }
  const rank = matrixRank(jacobian)
  const dof = Math.max(0, varCount - rank)
  const residual = Math.sqrt(currentCost)

  let status: SolverDiagnostics['status']
  if (numEquations > rank) status = 'over_defined'
  else if (residual > tolerance) status = 'inconsistent'
  else status = dof === 0 ? 'fully_defined' : 'under_defined'

  return {
    solvedEntities: cloned,
    diagnostics: {
      status,
      dof,
      residual,
      iterations: iter,
      converged: residual <= tolerance,
    },
  }
}

function matrixRank(matrix: number[][], tolerance = 1e-7): number {
  if (!matrix.length || !matrix[0]?.length) return 0
  const rows = matrix.map((row) => {
    const rowScale = Math.max(...row.map((value) => Math.abs(value)))
    return rowScale > 0 ? row.map((value) => value / rowScale) : [...row]
  })
  const rowCount = rows.length
  const columnCount = rows[0].length
  let rank = 0
  const threshold = tolerance

  for (let column = 0; column < columnCount && rank < rowCount; column++) {
    let pivot = rank
    for (let row = rank + 1; row < rowCount; row++) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row
    }
    if (Math.abs(rows[pivot][column]) <= threshold) continue
    ;[rows[rank], rows[pivot]] = [rows[pivot], rows[rank]]
    const pivotValue = rows[rank][column]
    for (let nextColumn = column; nextColumn < columnCount; nextColumn++) rows[rank][nextColumn] /= pivotValue
    for (let row = 0; row < rowCount; row++) {
      if (row === rank) continue
      const factor = rows[row][column]
      if (Math.abs(factor) <= threshold) continue
      for (let nextColumn = column; nextColumn < columnCount; nextColumn++) rows[row][nextColumn] -= factor * rows[rank][nextColumn]
    }
    rank++
  }
  return rank
}

/**
 * Solves A * x = b using Gaussian Elimination with partial pivoting
 */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length
  // Augmented matrix
  const M = A.map((row, i) => [...row, b[i]])

  for (let i = 0; i < n; i++) {
    // Pivot selection
    let maxRow = i
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(M[k][i]) > Math.abs(M[maxRow][i])) maxRow = k
    }

    if (Math.abs(M[maxRow][i]) < 1e-12) return null // Singular matrix

    // Swap rows
    const tmp = M[i]
    M[i] = M[maxRow]
    M[maxRow] = tmp

    // Eliminate below
    for (let k = i + 1; k < n; k++) {
      const factor = M[k][i] / M[i][i]
      for (let j = i; j <= n; j++) {
        M[k][j] -= factor * M[i][j]
      }
    }
  }

  // Back substitution
  const result = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n]
    for (let j = i + 1; j < n; j++) {
      sum -= M[i][j] * result[j]
    }
    result[i] = sum / M[i][i]
  }

  return result
}
