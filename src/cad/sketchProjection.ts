import * as THREE from 'three'
import type { BRepBody, Part, SketchEntity, SketchFeature } from './types'
import { getPartBRep } from './brep'
import { solveCoupledConstraints } from './constraintSolver'

export type SketchProjectionFrame = {
  origin: [number, number, number]
  uAxis: [number, number, number]
  vAxis: [number, number, number]
}

export function getSketchProjectionFrame(sketch: Pick<SketchFeature, 'plane' | 'arbitraryPlane'>): SketchProjectionFrame {
  if (sketch.arbitraryPlane) return {
    origin: sketch.arbitraryPlane.origin,
    uAxis: sketch.arbitraryPlane.uAxis,
    vAxis: sketch.arbitraryPlane.vAxis,
  }
  if (sketch.plane === 'top') return { origin: [0, 0.6, 0], uAxis: [1, 0, 0], vAxis: [0, 0, -1] }
  if (sketch.plane === 'front') return { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0] }
  return { origin: [0, 0, 0], uAxis: [0, 0, 1], vAxis: [0, 1, 0] }
}

export function projectPartEdgeToSketch(
  part: Part,
  edgeId: string,
  frame: SketchProjectionFrame,
  sourceBrep?: BRepBody,
): Pick<SketchEntity, 'type' | 'points' | 'closed'> | null {
  const brep = sourceBrep ?? getPartBRep(part)
  const edge = brep.edges.find((item) => item.id === edgeId)
  if (!edge) return null
  const frameOrigin = new THREE.Vector3(...frame.origin)
  const uAxis = new THREE.Vector3(...frame.uAxis).normalize()
  const vAxis = new THREE.Vector3(...frame.vAxis).normalize()
  const toLocal = (point: [number, number, number]): [number, number] => {
    const relative = new THREE.Vector3(...point).sub(frameOrigin)
    return [Number(relative.dot(uAxis).toFixed(4)), Number(relative.dot(vAxis).toFixed(4))]
  }

  if (edge.curveType === 'line') {
    const start = brep.vertices.find((vertex) => vertex.id === edge.startVertexId)?.point
    const end = brep.vertices.find((vertex) => vertex.id === edge.endVertexId)?.point
    if (!start || !end) return null
    const points = [toLocal(start), toLocal(end)] as [[number, number], [number, number]]
    if (Math.hypot(points[0][0] - points[1][0], points[0][1] - points[1][1]) < 1e-4) return null
    return { type: 'line', points, closed: false }
  }

  if (edge.curveType !== 'circle' || !edge.center || !edge.radius || edge.radius <= 0) return null
  const edgeLoopIds = new Set(brep.loops.filter((loop) => loop.edgeIds.includes(edge.id)).map((loop) => loop.id))
  const planarFace = brep.faces.find((face) => face.surfaceType === 'plane' && (edgeLoopIds.has(face.outerLoopId) || face.innerLoopIds.some((id) => edgeLoopIds.has(id))))
  if (!planarFace) return null
  const normal = new THREE.Vector3(...planarFace.normal).normalize()
  const sourceU = new THREE.Vector3(...planarFace.uAxis)
  const axisU = sourceU.addScaledVector(normal, -sourceU.dot(normal)).normalize()
  if (axisU.lengthSq() < 1e-8) return null
  const axisV = new THREE.Vector3().crossVectors(normal, axisU).normalize()
  const center = new THREE.Vector3(...edge.center)
  return {
    type: 'ellipse',
    points: [
      toLocal(edge.center),
      toLocal(center.clone().addScaledVector(axisU, edge.radius).toArray() as [number, number, number]),
      toLocal(center.clone().addScaledVector(axisV, edge.radius).toArray() as [number, number, number]),
    ],
    closed: true,
  }
}

export function syncProjectedSketches(sketches: SketchFeature[], parts: Part[]): SketchFeature[] {
  return sketches.map((sketch) => {
    if (!sketch.entities.some((entity) => entity.isProjected)) return sketch
    const frame = getSketchProjectionFrame(sketch)
    const brepCache = new Map<string, BRepBody | null>()
    let changed = false
    const entities = sketch.entities.map((entity) => {
      if (!entity.isProjected || !entity.sourcePartId || !entity.sourceEdgeId) return entity
      const part = parts.find((item) => item.id === entity.sourcePartId)
      let projected: ReturnType<typeof projectPartEdgeToSketch> = null
      try {
        if (part) {
          if (!brepCache.has(part.id)) brepCache.set(part.id, getPartBRep(part))
          const brep = brepCache.get(part.id)
          projected = brep ? projectPartEdgeToSketch(part, entity.sourceEdgeId, frame, brep) : null
        }
      } catch { projected = null }
      if (!projected) {
        if (entity.isBrokenProjection) return entity
        changed = true
        return { ...entity, isBrokenProjection: true }
      }
      const geometryChanged = entity.type !== projected.type || entity.closed !== projected.closed || entity.points.length !== projected.points.length || projected.points.some((point, index) =>
        Math.hypot(point[0] - entity.points[index][0], point[1] - entity.points[index][1]) > 1e-5,
      )
      if (!geometryChanged && !entity.isBrokenProjection) return entity
      changed = true
      return { ...entity, ...projected, isBrokenProjection: false }
    })
    if (!changed) return sketch
    const solved = sketch.constraints?.length ? solveCoupledConstraints(entities, sketch.constraints) : null
    return { ...sketch, entities: solved?.diagnostics.converged ? solved.solvedEntities : entities }
  })
}
