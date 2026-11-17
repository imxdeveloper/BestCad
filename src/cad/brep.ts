import * as THREE from 'three'
import type { ArbitraryPlane, BRepBody, BRepEdge, BRepFace, BRepLoop, BRepVertex, Part } from './types'

/**
 * Builds an exact Boundary Representation (B-Rep) for a Box part.
 * Produces 8 vertices, 12 linear edges, 6 face loops, and 6 exact analytical planar faces.
 */
export function buildBoxBRep(part: Part): BRepBody {
  const [w, h, d] = part.size
  const [cx, cy, cz] = part.position
  const hw = w / 2
  const hh = h / 2
  const hd = d / 2

  // 8 Vertices
  const coords: [number, number, number][] = [
    [cx - hw, cy - hh, cz - hd], // 0: ---
    [cx + hw, cy - hh, cz - hd], // 1: +--
    [cx + hw, cy + hh, cz - hd], // 2: ++-
    [cx - hw, cy + hh, cz - hd], // 3: -+-
    [cx - hw, cy - hh, cz + hd], // 4: --+
    [cx + hw, cy - hh, cz + hd], // 5: +-+
    [cx + hw, cy + hh, cz + hd], // 6: +++
    [cx - hw, cy + hh, cz + hd], // 7: -++
  ]

  const vertices: BRepVertex[] = coords.map((pt, i) => ({
    id: `v_${part.id}_${i}`,
    point: pt,
  }))

  // 12 Linear Edges
  const edgeDefs: [number, number][] = [
    // Bottom
    [0, 1], [1, 5], [5, 4], [4, 0],
    // Top
    [3, 2], [2, 6], [6, 7], [7, 3],
    // Vertical
    [0, 3], [1, 2], [5, 6], [4, 7],
  ]

  const edges: BRepEdge[] = edgeDefs.map(([s, e], i) => ({
    id: `e_${part.id}_${i}`,
    startVertexId: vertices[s].id,
    endVertexId: vertices[e].id,
    curveType: 'line',
  }))

  // 6 Planar Faces with exact normals, origins, and u/v axes
  const faceDefs: {
    name: string
    normal: [number, number, number]
    uAxis: [number, number, number]
    vAxis: [number, number, number]
    origin: [number, number, number]
    edgeIndices: number[]
    boundary: [number, number, number][]
  }[] = [
    {
      name: 'Top (+Y)',
      normal: [0, 1, 0],
      uAxis: [1, 0, 0],
      vAxis: [0, 0, -1],
      origin: [cx, cy + hh, cz],
      edgeIndices: [4, 5, 6, 7],
      boundary: [coords[3], coords[2], coords[6], coords[7]],
    },
    {
      name: 'Bottom (-Y)',
      normal: [0, -1, 0],
      uAxis: [1, 0, 0],
      vAxis: [0, 0, 1],
      origin: [cx, cy - hh, cz],
      edgeIndices: [0, 1, 2, 3],
      boundary: [coords[0], coords[1], coords[5], coords[4]],
    },
    {
      name: 'Front (+Z)',
      normal: [0, 0, 1],
      uAxis: [1, 0, 0],
      vAxis: [0, 1, 0],
      origin: [cx, cy, cz + hd],
      edgeIndices: [2, 10, 6, 11],
      boundary: [coords[4], coords[5], coords[6], coords[7]],
    },
    {
      name: 'Back (-Z)',
      normal: [0, 0, -1],
      uAxis: [-1, 0, 0],
      vAxis: [0, 1, 0],
      origin: [cx, cy, cz - hd],
      edgeIndices: [0, 9, 4, 8],
      boundary: [coords[1], coords[0], coords[3], coords[2]],
    },
    {
      name: 'Right (+X)',
      normal: [1, 0, 0],
      uAxis: [0, 0, -1],
      vAxis: [0, 1, 0],
      origin: [cx + hw, cy, cz],
      edgeIndices: [1, 10, 5, 9],
      boundary: [coords[5], coords[1], coords[2], coords[6]],
    },
    {
      name: 'Left (-X)',
      normal: [-1, 0, 0],
      uAxis: [0, 0, 1],
      vAxis: [0, 1, 0],
      origin: [cx - hw, cy, cz],
      edgeIndices: [3, 8, 7, 11],
      boundary: [coords[0], coords[4], coords[7], coords[3]],
    },
  ]

  const loops: BRepLoop[] = []
  const faces: BRepFace[] = []

  faceDefs.forEach((fd, i) => {
    const loopId = `loop_${part.id}_${i}`
    loops.push({
      id: loopId,
      edgeIds: fd.edgeIndices.map((idx) => edges[idx].id),
      isOuter: true,
    })

    faces.push({
      id: `face_${part.id}_${i}`,
      surfaceType: 'plane',
      origin: fd.origin,
      normal: fd.normal,
      uAxis: fd.uAxis,
      vAxis: fd.vAxis,
      outerLoopId: loopId,
      innerLoopIds: [],
      boundaryPoints: fd.boundary,
      area: (fd.normal[0] !== 0 ? h * d : fd.normal[1] !== 0 ? w * d : w * h),
    })
  })

  return {
    id: `brep_${part.id}`,
    partId: part.id,
    vertices,
    edges,
    loops,
    faces,
  }
}

/**
 * Builds an exact B-Rep for a Cylinder part.
 * Consists of 2 exact circular planar end-cap faces and 1 cylindrical quadric surface.
 */
export function buildCylinderBRep(part: Part): BRepBody {
  const [w, h, d] = part.size
  const [cx, cy, cz] = part.position
  const radius = Math.min(w, d) / 2
  const hh = h / 2

  const topOrigin: [number, number, number] = [cx, cy + hh, cz]
  const botOrigin: [number, number, number] = [cx, cy - hh, cz]

  // Circular boundary edges
  const edges: BRepEdge[] = [
    {
      id: `e_${part.id}_top_circle`,
      startVertexId: `v_${part.id}_top`,
      endVertexId: `v_${part.id}_top`,
      curveType: 'circle',
      radius,
      center: topOrigin,
    },
    {
      id: `e_${part.id}_bot_circle`,
      startVertexId: `v_${part.id}_bot`,
      endVertexId: `v_${part.id}_bot`,
      curveType: 'circle',
      radius,
      center: botOrigin,
    },
  ]

  const loops: BRepLoop[] = [
    { id: `loop_${part.id}_top`, edgeIds: [edges[0].id], isOuter: true },
    { id: `loop_${part.id}_bot`, edgeIds: [edges[1].id], isOuter: true },
  ]

  const faces: BRepFace[] = [
    {
      id: `face_${part.id}_top`,
      surfaceType: 'plane',
      origin: topOrigin,
      normal: [0, 1, 0],
      uAxis: [1, 0, 0],
      vAxis: [0, 0, -1],
      radius,
      outerLoopId: loops[0].id,
      innerLoopIds: [],
      area: Math.PI * radius * radius,
    },
    {
      id: `face_${part.id}_bottom`,
      surfaceType: 'plane',
      origin: botOrigin,
      normal: [0, -1, 0],
      uAxis: [1, 0, 0],
      vAxis: [0, 0, 1],
      radius,
      outerLoopId: loops[1].id,
      innerLoopIds: [],
      area: Math.PI * radius * radius,
    },
    {
      id: `face_${part.id}_side`,
      surfaceType: 'cylinder',
      origin: [cx, cy, cz],
      normal: [1, 0, 0],
      uAxis: [0, 0, 1],
      vAxis: [0, 1, 0],
      radius,
      outerLoopId: loops[0].id,
      innerLoopIds: [],
      area: 2 * Math.PI * radius * h,
    },
  ]

  return {
    id: `brep_${part.id}`,
    partId: part.id,
    vertices: [
      { id: `v_${part.id}_top`, point: [cx + radius, cy + hh, cz] },
      { id: `v_${part.id}_bot`, point: [cx + radius, cy - hh, cz] },
    ],
    edges,
    loops,
    faces,
  }
}

/**
 * Builds an exact B-Rep for an Extrusion part.
 * Extracts the planar base, planar top, and ruled side faces.
 */
export function buildExtrusionBRep(part: Part): BRepBody {
  const plane = part.profilePlane || 'top'
  const profile = part.profile || []
  const depth = part.size[plane === 'top' ? 1 : plane === 'front' ? 2 : 0] || 4
  const [cx, cy, cz] = part.position

  const normal: [number, number, number] = plane === 'top' ? [0, 1, 0] : plane === 'front' ? [0, 0, 1] : [1, 0, 0]
  const uAxis: [number, number, number] = plane === 'top' ? [1, 0, 0] : plane === 'front' ? [1, 0, 0] : [0, 0, 1]
  const vAxis: [number, number, number] = plane === 'top' ? [0, 0, -1] : plane === 'front' ? [0, 1, 0] : [0, 1, 0]

  const topOrigin: [number, number, number] = [
    cx + normal[0] * depth,
    cy + normal[1] * depth,
    cz + normal[2] * depth,
  ]

  const topBoundary: [number, number, number][] = profile.map(([u, v]) => [
    topOrigin[0] + uAxis[0] * u + vAxis[0] * v,
    topOrigin[1] + uAxis[1] * u + vAxis[1] * v,
    topOrigin[2] + uAxis[2] * u + vAxis[2] * v,
  ])

  const botBoundary: [number, number, number][] = profile.map(([u, v]) => [
    cx + uAxis[0] * u + vAxis[0] * v,
    cy + uAxis[1] * u + vAxis[1] * v,
    cz + uAxis[2] * u + vAxis[2] * v,
  ])

  const faces: BRepFace[] = [
    {
      id: `face_${part.id}_top_cap`,
      surfaceType: 'plane',
      origin: topOrigin,
      normal,
      uAxis,
      vAxis,
      outerLoopId: `loop_${part.id}_top`,
      innerLoopIds: [],
      boundaryPoints: topBoundary,
    },
    {
      id: `face_${part.id}_bot_cap`,
      surfaceType: 'plane',
      origin: [cx, cy, cz],
      normal: [-normal[0], -normal[1], -normal[2]],
      uAxis,
      vAxis: [-vAxis[0], -vAxis[1], -vAxis[2]],
      outerLoopId: `loop_${part.id}_bot`,
      innerLoopIds: [],
      boundaryPoints: botBoundary,
    },
  ]

  // Add side faces for each profile segment
  for (let i = 0; i < profile.length; i++) {
    const p1 = profile[i]
    const p2 = profile[(i + 1) % profile.length]
    const du = p2[0] - p1[0]
    const dv = p2[1] - p1[1]
    const segLen = Math.hypot(du, dv) || 1
    const sideU: [number, number, number] = [
      (uAxis[0] * du + vAxis[0] * dv) / segLen,
      (uAxis[1] * du + vAxis[1] * dv) / segLen,
      (uAxis[2] * du + vAxis[2] * dv) / segLen,
    ]
    const sideNormal: [number, number, number] = [
      sideU[1] * normal[2] - sideU[2] * normal[1],
      sideU[2] * normal[0] - sideU[0] * normal[2],
      sideU[0] * normal[1] - sideU[1] * normal[0],
    ]
    const midPt: [number, number, number] = [
      (topBoundary[i][0] + botBoundary[(i + 1) % profile.length][0]) / 2,
      (topBoundary[i][1] + botBoundary[(i + 1) % profile.length][1]) / 2,
      (topBoundary[i][2] + botBoundary[(i + 1) % profile.length][2]) / 2,
    ]

    faces.push({
      id: `face_${part.id}_side_${i}`,
      surfaceType: 'plane',
      origin: midPt,
      normal: sideNormal,
      uAxis: sideU,
      vAxis: normal,
      outerLoopId: `loop_${part.id}_side_${i}`,
      innerLoopIds: [],
      boundaryPoints: [topBoundary[i], topBoundary[(i + 1) % profile.length], botBoundary[(i + 1) % profile.length], botBoundary[i]],
    })
  }

  return {
    id: `brep_${part.id}`,
    partId: part.id,
    vertices: [],
    edges: [],
    loops: [],
    faces,
  }
}

/**
 * Computes or retrieves the B-Rep body for any Part
 */
export function getPartBRep(part: Part): BRepBody {
  if (part.brep) return part.brep
  if (part.kind === 'cylinder') return buildCylinderBRep(part)
  if (part.kind === 'extrusion') return buildExtrusionBRep(part)
  return buildBoxBRep(part)
}

/**
 * Exact Analytical Planar Face Raycaster:
 * Given a 3D Ray (origin + direction), tests for intersection against all planar faces
 * of all parts. Returns the exact intersected face with its local ArbitraryPlane!
 */
export function raycastPlanarFace(
  ray: THREE.Ray,
  parts: Part[],
): {
  face: BRepFace
  part: Part
  hitPoint: [number, number, number]
  arbitraryPlane: ArbitraryPlane
} | null {
  let closestHit: {
    face: BRepFace
    part: Part
    hitPoint: [number, number, number]
    arbitraryPlane: ArbitraryPlane
    distance: number
  } | null = null

  const plane = new THREE.Plane()
  const hitVec = new THREE.Vector3()

  for (const part of parts) {
    if (!part.visible) continue
    const brep = getPartBRep(part)

    for (const face of brep.faces) {
      if (face.surfaceType !== 'plane') continue

      const norm = new THREE.Vector3(...face.normal)
      const orig = new THREE.Vector3(...face.origin)
      plane.setFromNormalAndCoplanarPoint(norm, orig)

      // Test ray-plane intersection
      const point = ray.intersectPlane(plane, hitVec)
      if (!point) continue

      // Ray must be facing the surface (front-facing)
      if (ray.direction.dot(norm) > 0.05) continue

      const dist = ray.origin.distanceTo(point)

      // Check if point is inside face boundary
      let isInside = false
      if (face.boundaryPoints && face.boundaryPoints.length >= 3) {
        // Project to 2D in face's local coordinate system
        const uAx = new THREE.Vector3(...face.uAxis)
        const vAx = new THREE.Vector3(...face.vAxis)
        const rel = point.clone().sub(orig)
        const hitU = rel.dot(uAx)
        const hitV = rel.dot(vAx)

        const poly2D = face.boundaryPoints.map((bp) => {
          const r = new THREE.Vector3(...bp).sub(orig)
          return [r.dot(uAx), r.dot(vAx)] as [number, number]
        })

        isInside = pointInPolygon([hitU, hitV], poly2D)
      } else if (face.radius) {
        // Circular face boundary test
        const rDist = point.distanceTo(orig)
        isInside = rDist <= face.radius + 1e-4
      } else {
        isInside = true
      }

      if (isInside && (!closestHit || dist < closestHit.distance)) {
        closestHit = {
          face,
          part,
          hitPoint: [point.x, point.y, point.z],
          arbitraryPlane: {
            id: `plane_${face.id}`,
            name: `${part.name} - Face ${face.id}`,
            origin: face.origin,
            normal: face.normal,
            uAxis: face.uAxis,
            vAxis: face.vAxis,
            sourceFaceId: face.id,
            sourcePartId: part.id,
          },
          distance: dist,
        }
      }
    }
  }

  return closestHit ? {
    face: closestHit.face,
    part: closestHit.part,
    hitPoint: closestHit.hitPoint,
    arbitraryPlane: closestHit.arbitraryPlane,
  } : null
}

/**
 * 2D Point-in-polygon test (Jordan Curve theorem / Ray-casting)
 */
function pointInPolygon(point: [number, number], polygon: [number, number][]): boolean {
  const [x, y] = point
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1]
    const xj = polygon[j][0], yj = polygon[j][1]
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

