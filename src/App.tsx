import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  Box,
  Camera,
  ChevronDown,
  Circle,
  CirclePlus,
  Code2,
  Copy,
  Cpu,
  Cuboid,
  Download,
  Eye,
  EyeOff,
  FileText,
  Flame,
  FolderOpen,
  Grid2X2,
  Layers3,
  Move3D,
  PanelLeftClose,
  PanelRightClose,
  Play,
  Plus,
  Printer,
  Redo2,
  Rotate3D,
  Ruler,
  Save,
  Scissors,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Wrench,
  X,
} from 'lucide-react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import './App.css'

import type {
  ArbitraryPlane,
  AssemblyJoint,
  CAMSetup,
  EdgeTreatment,
  MaterialPresetId,
  MeshData,
  ModelSnapshot,
  Part,
  Primitive,
  SectionAnalysisState,
  SimulationSetup,
  SketchEntity,
  SketchConstraint,
  SketchFeature,
  SketchPlane,
  SketchProfile,
  SketchStage,
  SketchTool,
  SolidCommand,
  VersionSnapshot,
  Viewer,
  WorkspaceId,
} from './cad/types'
import { MATERIAL_PRESETS, getMaterial } from './cad/materials'
import { computeGeometryMetrics } from './cad/inspection'
import { solveAssemblyJoints, generateBOM, exportBOMtoCSV } from './cad/assembly'
import { solveStaticStressFEA } from './cad/simulation'
import { generateCAMToolpaths } from './cad/cam'
import { generateEngineeringDrawingSVG } from './cad/drawing'
import { exportToSTEP } from './cad/stepExporter'
import { SCRIPT_TEMPLATES, executeCADScript } from './cad/automate'
import { buildMeshBRep, getPartBRep, raycastPlanarFace } from './cad/brep'
import { getSketchProjectionFrame, projectPartEdgeToSketch, syncProjectedSketches } from './cad/sketchProjection'
import { solveCoupledConstraints } from './cad/constraintSolver'
import { offsetOpenPath, offsetPolygon } from './cad/sketcher'
import { createLoftMesh } from './cad/loft'
import { createSweepMesh } from './cad/sweep'
import { applyPartTransform, createPartGeometry } from './cad/partGeometry'

const SKETCH_PLANE_Y = 0.6

function sketchPlaneAxes(plane: SketchPlane) {
  if (plane === 'top') return { uAxis: 0, vAxis: 2, normalAxis: 1 }
  if (plane === 'front') return { uAxis: 0, vAxis: 1, normalAxis: 2 }
  return { uAxis: 2, vAxis: 1, normalAxis: 0 }
}

function sketchPlaneFrame(plane: SketchPlane, arbitraryPlane?: ArbitraryPlane) {
  if (arbitraryPlane) return {
    origin: new THREE.Vector3(...arbitraryPlane.origin),
    uAxis: new THREE.Vector3(...arbitraryPlane.uAxis).normalize(),
    vAxis: new THREE.Vector3(...arbitraryPlane.vAxis).normalize(),
    normal: new THREE.Vector3(...arbitraryPlane.normal).normalize(),
  }
  if (plane === 'top') return { origin: new THREE.Vector3(0, SKETCH_PLANE_Y, 0), uAxis: new THREE.Vector3(1, 0, 0), vAxis: new THREE.Vector3(0, 0, -1), normal: new THREE.Vector3(0, 1, 0) }
  if (plane === 'front') return { origin: new THREE.Vector3(0, 0, 0), uAxis: new THREE.Vector3(1, 0, 0), vAxis: new THREE.Vector3(0, 1, 0), normal: new THREE.Vector3(0, 0, 1) }
  return { origin: new THREE.Vector3(0, 0, 0), uAxis: new THREE.Vector3(0, 0, 1), vAxis: new THREE.Vector3(0, 1, 0), normal: new THREE.Vector3(-1, 0, 0) }
}

function arcPoints(center: [number, number], start: [number, number], end: [number, number]): [number, number][] {
  const radius = Math.hypot(start[0] - center[0], start[1] - center[1])
  let startAngle = Math.atan2(start[1] - center[1], start[0] - center[0])
  let endAngle = Math.atan2(end[1] - center[1], end[0] - center[0])
  // A three-click arc should follow the shorter sweep between its start and end.
  while (endAngle - startAngle > Math.PI) endAngle -= Math.PI * 2
  while (endAngle - startAngle < -Math.PI) endAngle += Math.PI * 2
  return Array.from({ length: 33 }, (_, index): [number, number] => {
    const angle = startAngle + ((endAngle - startAngle) * index) / 32
    return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius]
  })
}

function sketchEntityPoints(entity: SketchEntity): [number, number][] {
  if (entity.type === 'spline' && entity.points.length >= 3) {
    const curve = new THREE.SplineCurve(entity.points.map(([x, y]) => new THREE.Vector2(x, y)))
    return curve.getPoints(Math.max(48, entity.points.length * 16)).map((point): [number, number] => [point.x, point.y])
  }
  if (entity.type === 'rectangle' && entity.points.length >= 2) {
    const [first, second] = entity.points
    return [first, [second[0], first[1]], second, [first[0], second[1]], first]
  }
  if (entity.type === 'circle' && entity.points.length >= 2) {
    const [center, edge] = entity.points
    const radius = Math.hypot(edge[0] - center[0], edge[1] - center[1])
    return Array.from({ length: 49 }, (_, index): [number, number] => {
      const angle = (index * Math.PI * 2) / 48
      return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius]
    })
  }
  if (entity.type === 'ellipse' && entity.points.length >= 3) {
    const [center, xEdge, yEdge] = entity.points
    const xAxis: [number, number] = [xEdge[0] - center[0], xEdge[1] - center[1]]
    const yAxis: [number, number] = [yEdge[0] - center[0], yEdge[1] - center[1]]
    return Array.from({ length: 65 }, (_, index): [number, number] => {
      const angle = index * Math.PI * 2 / 64
      return [center[0] + xAxis[0] * Math.cos(angle) + yAxis[0] * Math.sin(angle), center[1] + xAxis[1] * Math.cos(angle) + yAxis[1] * Math.sin(angle)]
    })
  }
  if (entity.type === 'polygon' && entity.points.length >= 2) {
    const [center, edge] = entity.points
    const radius = Math.hypot(edge[0] - center[0], edge[1] - center[1])
    const startAngle = Math.atan2(edge[1] - center[1], edge[0] - center[0])
    const sides = Math.max(3, Math.min(64, entity.sides ?? 6))
    return Array.from({ length: sides }, (_, index): [number, number] => {
      const angle = startAngle + index * Math.PI * 2 / sides
      return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius]
    })
  }
  if (entity.type === 'slot' && entity.points.length >= 3) {
    const [start, end, radiusPoint] = entity.points
    const dx = end[0] - start[0]
    const dy = end[1] - start[1]
    const length = Math.hypot(dx, dy) || 1
    const radius = Math.hypot(radiusPoint[0] - start[0], radiusPoint[1] - start[1])
    const nx = -dy / length
    const ny = dx / length
    const sideA: [number, number] = [start[0] + nx * radius, start[1] + ny * radius]
    const sideB: [number, number] = [end[0] + nx * radius, end[1] + ny * radius]
    const points: [number, number][] = [sideA, sideB]
    const angle = Math.atan2(ny, nx)
    for (let index = 1; index <= 16; index++) {
      const theta = angle - Math.PI * index / 16
      points.push([end[0] + Math.cos(theta) * radius, end[1] + Math.sin(theta) * radius])
    }
    points.push([start[0] - nx * radius, start[1] - ny * radius])
    for (let index = 1; index <= 16; index++) {
      const theta = angle + Math.PI - Math.PI * index / 16
      points.push([start[0] + Math.cos(theta) * radius, start[1] + Math.sin(theta) * radius])
    }
    points.push(points[0])
    return points
  }
  if (entity.type === 'arc' && entity.points.length >= 3) {
    return arcPoints(entity.points[0], entity.points[1], entity.points[2])
  }
  return entity.closed && entity.points.length > 2 ? [...entity.points, entity.points[0]] : entity.points
}

function sketchProfileBounds(points: [number, number][]) {
  const xs = points.map(([u]) => u)
  const ys = points.map(([, v]) => v)
  return {
    minU: Math.min(...xs),
    maxU: Math.max(...xs),
    minV: Math.min(...ys),
    maxV: Math.max(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }
}

function closedProfilePoints(entity: SketchEntity): [number, number][] {
  const points = sketchEntityPoints(entity)
  if (
    points.length > 1 &&
    Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]) <= 1e-9
  ) {
    points.pop()
  }
  return points
}

function buildLoftPart(firstSketch: SketchFeature, secondSketch: SketchFeature, entityIds: [string, string], existing?: Part): Part {
  const sections = [firstSketch, secondSketch].map((sketch, index) => {
    const entity = sketch.entities.find((item) => item.id === entityIds[index])
    if (!entity || !entity.closed || entity.isConstruction || entity.isProjected || entity.type === 'arc') {
      throw new RangeError(`Sketch ${sketch.name} needs its closed loft profile`)
    }
    const profile = closedProfilePoints(entity)
    if (profile.length < 3 || polygonArea(profile) <= 1e-9 || polygonHasSelfIntersection(profile)) {
      throw new RangeError(`Sketch ${sketch.name} has an invalid loft profile`)
    }
    const frame = sketchPlaneFrame(sketch.plane, sketch.arbitraryPlane)
    return profile.map(([u, v]) => frame.origin.clone().addScaledVector(frame.uAxis, u).addScaledVector(frame.vAxis, v))
  })
  const loft = createLoftMesh(sections[0], sections[1])
  const part: Part = {
    id: existing?.id ?? createFeatureId('loft'), name: existing?.name ?? 'Loft',
    kind: 'custom', size: loft.size, position: loft.position, meshData: loft.meshData,
    color: existing?.color ?? '#78a9dc', materialId: existing?.materialId ?? 'aluminum', visible: existing?.visible ?? true,
    loftSketchIds: [firstSketch.id, secondSketch.id], loftSketchEntityIds: entityIds,
    operation: `Loft · ${firstSketch.name} to ${secondSketch.name}`,
  }
  part.brep = buildMeshBRep(part)
  return part
}

function buildSweepPart(profileSketch: SketchFeature, pathSketch: SketchFeature, entityIds: [string, string], existing?: Part): Part {
  const profileEntity = profileSketch.entities.find((entity) => entity.id === entityIds[0])
  const pathEntity = pathSketch.entities.find((entity) => entity.id === entityIds[1])
  if (!profileEntity || !profileEntity.closed || profileEntity.isConstruction || profileEntity.isProjected || profileEntity.type === 'arc') {
    throw new RangeError(`Sketch ${profileSketch.name} needs its closed sweep profile`)
  }
  if (!pathEntity || pathEntity.closed || pathEntity.isConstruction || pathEntity.isProjected || !['line', 'spline'].includes(pathEntity.type)) {
    throw new RangeError(`Sketch ${pathSketch.name} needs an open line or spline sweep path`)
  }
  const profile = closedProfilePoints(profileEntity)
  if (profile.length < 3 || polygonArea(profile) <= 1e-9 || polygonHasSelfIntersection(profile)) {
    throw new RangeError(`Sketch ${profileSketch.name} has an invalid sweep profile`)
  }
  const profileFrame = sketchPlaneFrame(profileSketch.plane, profileSketch.arbitraryPlane)
  const pathFrame = sketchPlaneFrame(pathSketch.plane, pathSketch.arbitraryPlane)
  const profileWorld = profile.map(([u, v]) => profileFrame.origin.clone().addScaledVector(profileFrame.uAxis, u).addScaledVector(profileFrame.vAxis, v))
  const pathWorld = sketchEntityPoints(pathEntity).map(([u, v]) => pathFrame.origin.clone().addScaledVector(pathFrame.uAxis, u).addScaledVector(pathFrame.vAxis, v))
  const profileCenter = profileWorld.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / profileWorld.length)
  if (profileCenter.distanceTo(pathWorld[0]) > 0.5) throw new RangeError('Sweep path must start at the center of the profile')
  const sweep = createSweepMesh(profileWorld, pathWorld)
  const part: Part = {
    id: existing?.id ?? createFeatureId('sweep'), name: existing?.name ?? 'Sweep',
    kind: 'custom', size: sweep.size, position: sweep.position, meshData: sweep.meshData,
    color: existing?.color ?? '#78a9dc', materialId: existing?.materialId ?? 'aluminum', visible: existing?.visible ?? true,
    sweepSketchIds: [profileSketch.id, pathSketch.id], sweepSketchEntityIds: entityIds,
    operation: `Sweep · ${profileSketch.name} along ${pathSketch.name}`,
  }
  part.brep = buildMeshBRep(part)
  return part
}

function polygonArea(points: [number, number][]): number {
  return (
    Math.abs(
      points.reduce((area, [x, y], index) => {
        const [nextX, nextY] = points[(index + 1) % points.length]
        return area + x * nextY - nextX * y
      }, 0),
    ) / 2
  )
}

function polygonHasSelfIntersection(points: [number, number][]): boolean {
  const cross = (a: [number, number], b: [number, number], c: [number, number]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const onSegment = (a: [number, number], b: [number, number], point: [number, number]) =>
    Math.min(a[0], b[0]) - 1e-9 <= point[0] &&
    point[0] <= Math.max(a[0], b[0]) + 1e-9 &&
    Math.min(a[1], b[1]) - 1e-9 <= point[1] &&
    point[1] <= Math.max(a[1], b[1]) + 1e-9
  const intersects = (
    a: [number, number],
    b: [number, number],
    c: [number, number],
    d: [number, number],
  ) => {
    const abC = cross(a, b, c)
    const abD = cross(a, b, d)
    const cdA = cross(c, d, a)
    const cdB = cross(c, d, b)
    if (((abC > 1e-9 && abD < -1e-9) || (abC < -1e-9 && abD > 1e-9)) && ((cdA > 1e-9 && cdB < -1e-9) || (cdA < -1e-9 && cdB > 1e-9)))
      return true
    return (
      (Math.abs(abC) <= 1e-9 && onSegment(a, b, c)) ||
      (Math.abs(abD) <= 1e-9 && onSegment(a, b, d)) ||
      (Math.abs(cdA) <= 1e-9 && onSegment(c, d, a)) ||
      (Math.abs(cdB) <= 1e-9 && onSegment(c, d, b))
    )
  }

  for (let first = 0; first < points.length; first += 1) {
    const a = points[first]
    const b = points[(first + 1) % points.length]
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-9) return true
    for (let second = first + 1; second < points.length; second += 1) {
      if (second === first + 1 || (first === 0 && second === points.length - 1)) continue
      if (intersects(a, b, points[second], points[(second + 1) % points.length])) return true
    }
  }
  return false
}

function sketchEntityDistance(entity: SketchEntity, point: [number, number]): number {
  const points = sketchEntityPoints(entity)
  let nearest = Infinity
  for (let index = 0; index < points.length - 1; index++) {
    const [ax, ay] = points[index]
    const [bx, by] = points[index + 1]
    const dx = bx - ax
    const dy = by - ay
    const lengthSquared = dx * dx + dy * dy
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - ax) * dx + (point[1] - ay) * dy) / lengthSquared))
    nearest = Math.min(nearest, Math.hypot(point[0] - (ax + t * dx), point[1] - (ay + t * dy)))
  }
  return nearest
}

function segmentIntersection(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): [number, number] | null {
  const rx = b[0] - a[0], ry = b[1] - a[1]
  const sx = d[0] - c[0], sy = d[1] - c[1]
  const denominator = rx * sy - ry * sx
  if (Math.abs(denominator) < 1e-10) return null
  const qx = c[0] - a[0], qy = c[1] - a[1]
  const t = (qx * sy - qy * sx) / denominator
  const u = (qx * ry - qy * rx) / denominator
  if (t < 1e-7 || t > 1 - 1e-7 || u < 1e-7 || u > 1 - 1e-7) return null
  return [a[0] + t * rx, a[1] + t * ry]
}

const initialParts: Part[] = [
  { id: 'base', name: 'Base plate', kind: 'box', size: [8, 0.6, 5], position: [0, 0.3, 0], color: '#b7c1d0', materialId: 'steel', visible: true },
  { id: 'column', name: 'Support column', kind: 'box', size: [1.25, 4.2, 1.25], position: [0, 2.7, 0], color: '#cbd3df', materialId: 'steel', visible: true },
  { id: 'jaw', name: 'Fixed jaw', kind: 'box', size: [3.7, 0.85, 2.2], position: [1.35, 4.9, 0], color: '#8fa1ba', materialId: 'aluminum', visible: true },
  { id: 'screw', name: 'Lead screw', kind: 'cylinder', size: [0.42, 2.1, 0.42], position: [1.35, 3.35, 0], color: '#e5a84b', materialId: 'brass', visible: true },
  { id: 'handle', name: 'Cross handle', kind: 'cylinder', size: [0.24, 2.8, 0.24], position: [1.35, 2.7, 0], color: '#d3a762', materialId: 'brass', visible: true },
  { id: 'pad', name: 'Pressure pad', kind: 'cylinder', size: [0.72, 0.32, 0.72], position: [1.35, 2.12, 0], color: '#7487a1', materialId: 'aluminum', visible: true },
]

const initialJoints: AssemblyJoint[] = [
  { id: 'j-column', name: 'Fixed to Base', type: 'rigid', basePartId: 'base', targetPartId: 'column', axis: 'y', currentValue: 0, minLimit: 0, maxLimit: 0 },
  { id: 'j-jaw', name: 'Jaw Mated to Column', type: 'rigid', basePartId: 'column', targetPartId: 'jaw', axis: 'y', currentValue: 0, minLimit: 0, maxLimit: 0 },
  { id: 'j-screw', name: 'Screw Revolute/Lead', type: 'revolute', basePartId: 'jaw', targetPartId: 'screw', axis: 'y', currentValue: 0, minLimit: -360, maxLimit: 360 },
  { id: 'j-pad', name: 'Pad Linear Clamp', type: 'slider', basePartId: 'screw', targetPartId: 'pad', axis: 'y', currentValue: 0, minLimit: -1.2, maxLimit: 1.0 },
]

const workspaceCatalog = [
  { id: 'design', label: 'Design', icon: Cuboid, description: 'Sketches, editable solid features, and mesh modeling', categories: ['Sketch', 'Extrude', 'Boolean', 'Inspect'], status: 'Prototype' },
  { id: 'assemble', label: 'Assemble', icon: Layers3, description: 'Kinematic joints, exploded views, and live BOM', categories: ['Joints', 'Exploded View', 'Bill of Materials'], status: 'Prototype' },
  { id: 'drawings', label: 'Drawings', icon: Grid2X2, description: '2D engineering sheets and SVG export', categories: ['Multi-View', 'Dimensions', 'SVG Export'], status: 'Prototype' },
  { id: 'manufacture', label: 'Manufacture', icon: Move3D, description: '2.5D CAM toolpaths and G-code preview', categories: ['Setup', 'Toolpaths', 'G-Code'], status: 'Prototype' },
  { id: 'simulation', label: 'Simulation', icon: SlidersHorizontal, description: 'Approximate static stress and factor of safety', categories: ['Static Stress', 'Loads', 'Factor of Safety'], status: 'Prototype' },
  { id: 'electronics', label: 'Electronics', icon: Cpu, description: 'PCB enclosure layout helpers', categories: ['Enclosure', 'Standoffs', 'Keepout'], status: 'Prototype' },
  { id: 'visualize', label: 'Visualize', icon: Sparkles, description: 'Materials, lighting, and snapshots', categories: ['Materials', 'Lighting', 'Snapshot'], status: 'Prototype' },
  { id: 'manage', label: 'Manage', icon: ShieldCheck, description: 'Local versions and CAD exports', categories: ['Versions', 'STEP Export', 'STL / OBJ'], status: 'Prototype' },
  { id: 'automate', label: 'Automate', icon: Code2, description: 'Script templates and parametric generators', categories: ['Script Editor', 'Templates', 'Run'], status: 'Prototype' },
] as const

function createPartMesh(part: Part, selected: boolean, customGeo?: THREE.BufferGeometry) {
  const geometry = customGeo ?? createPartGeometry(part)

  const matData = getMaterial(part.materialId)
  const hasVertexColors = Boolean(geometry.getAttribute('color'))

  const material = new THREE.MeshStandardMaterial({
    color: hasVertexColors ? '#ffffff' : part.color,
    vertexColors: hasVertexColors,
    roughness: matData.roughness,
    metalness: matData.metalness,
    emissive: selected ? '#633c14' : '#000000',
    emissiveIntensity: selected ? 0.2 : 0,
  })

  const mesh = new THREE.Mesh(geometry, material)
  applyPartTransform(mesh, part)
  mesh.visible = part.visible
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.userData.partId = part.id
  return mesh
}

async function createCsgResult(first: Part, second: Part, operation: 'add' | 'subtract' | 'intersect', cylinderAxis?: 'x' | 'y' | 'z') {
  const { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } = await import('three-bvh-csg')
  const createBrush = (part: Part, axis?: 'x' | 'y' | 'z') => {
    const mesh = createPartMesh(part, false)
    mesh.updateMatrixWorld(true)
    const brush = new Brush(mesh.geometry, mesh.material)
    brush.position.copy(mesh.position)
    brush.quaternion.copy(mesh.quaternion)
    brush.scale.copy(mesh.scale)
    if (axis === 'x') brush.rotation.z = Math.PI / 2
    else if (axis === 'z') brush.rotation.x = Math.PI / 2
    brush.updateMatrixWorld(true)
    brush.prepareGeometry()
    return brush
  }
  const firstBrush = createBrush(first)
  const secondBrush = createBrush(second, cylinderAxis)
  const targetBrush = new Brush()
  let localGeometry: THREE.BufferGeometry | null = null
  let worldGeometry: THREE.BufferGeometry | null = null
  const disposeMaterials = (material: THREE.Material | THREE.Material[]) => {
    if (Array.isArray(material)) material.forEach((item) => item.dispose())
    else material.dispose()
  }
  try {
    const evaluator = new Evaluator()
    evaluator.useGroups = false
    evaluator.attributes = ['position', 'normal']
    const csgOperation = operation === 'add' ? ADDITION : operation === 'subtract' ? SUBTRACTION : INTERSECTION
    const result = evaluator.evaluate(firstBrush, secondBrush, csgOperation, targetBrush)
    result.updateMatrixWorld(true)
    worldGeometry = result.geometry.clone().applyMatrix4(result.matrixWorld)
    worldGeometry.computeBoundingBox()
    localGeometry = result.geometry.clone()
    localGeometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(), result.quaternion, result.scale))
    localGeometry.computeVertexNormals()
    const position = localGeometry.getAttribute('position')
    const index = localGeometry.getIndex()
    if (!position || position.count < 3 || !worldGeometry.boundingBox) {
      throw new Error('The solid operation produced an empty result')
    }
    const indices = index ? Array.from(index.array) : Array.from({ length: position.count }, (_, item) => item)
    const meshData: MeshData = { positions: Array.from(position.array), indices }
    const bounds = worldGeometry.boundingBox
    const size: Part['size'] = [bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z]
    const resultPosition: Part['position'] = [result.position.x, result.position.y, result.position.z]
    return { meshData, size, position: resultPosition }
  } finally {
    firstBrush.disposeCacheData()
    secondBrush.disposeCacheData()
    firstBrush.geometry.dispose()
    secondBrush.geometry.dispose()
    disposeMaterials(firstBrush.material)
    disposeMaterials(secondBrush.material)
    targetBrush.geometry.dispose()
    disposeMaterials(targetBrush.material)
    localGeometry?.dispose()
    worldGeometry?.dispose()
  }
}

function createFeatureId(prefix: string): string {
  return `${prefix}-${Date.now()}`
}

function App() {
  const viewportRef = useRef<HTMLDivElement>(null)
  const workspaceSwitcherRef = useRef<HTMLDivElement>(null)
  const documentInputRef = useRef<HTMLInputElement>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const editingSketchRef = useRef<SketchFeature | null>(null)
  const sketchReturnProjectionRef = useRef<'perspective' | 'orthographic'>('perspective')

  const [parts, setParts] = useState<Part[]>(() => {
    try {
      const saved = localStorage.getItem('bestcad-document') ?? localStorage.getItem('clonecad-document')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed.parts) && parsed.parts.length > 0) return parsed.parts
      }
    } catch {}
    return initialParts
  })

  const [sketches, setSketches] = useState<SketchFeature[]>(() => {
    try {
      const saved = localStorage.getItem('bestcad-document') ?? localStorage.getItem('clonecad-document')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed.sketches)) return syncProjectedSketches(parsed.sketches, Array.isArray(parsed.parts) ? parsed.parts : initialParts)
      }
    } catch {}
    return []
  })

  const [joints, setJoints] = useState<AssemblyJoint[]>(() => {
    try {
      const saved = localStorage.getItem('bestcad-document') ?? localStorage.getItem('clonecad-document')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed.joints)) return parsed.joints
      }
    } catch {}
    return initialJoints
  })

  const [selectedId, setSelectedId] = useState<string | null>('jaw')
  const [selectedSketchId, setSelectedSketchId] = useState<string | null>(null)
  const [loftTargetSketchId, setLoftTargetSketchId] = useState<string>('')
  const [sweepTargetSketchId, setSweepTargetSketchId] = useState<string>('')
  const [past, setPast] = useState<ModelSnapshot[]>([])
  const [future, setFuture] = useState<ModelSnapshot[]>([])
  const [sketchEntities, setSketchEntities] = useState<SketchEntity[]>([])
  const [selectedSketchEntityId, setSelectedSketchEntityId] = useState<string | null>(null)
  const [relatedSketchEntityId, setRelatedSketchEntityId] = useState<string | null>(null)
  const [sketchConstraints, setSketchConstraints] = useState<SketchConstraint[]>([])
  const [dimensionPointRefs, setDimensionPointRefs] = useState<{ entityId: string; pointIndex: number }[]>([])
  const [dimensionValue, setDimensionValue] = useState(0)
  const [dimensionMode, setDimensionMode] = useState<'distance' | 'angle' | 'width' | 'height'>('distance')
  const [constraintMessage, setConstraintMessage] = useState('')
  const [pendingSketchPoints, setPendingSketchPoints] = useState<[number, number][]>([])
  const [sketchCursorPoint, setSketchCursorPoint] = useState<[number, number] | null>(null)
  const [sketchSnapEnabled, setSketchSnapEnabled] = useState(true)
  const [constructionMode, setConstructionMode] = useState(false)
  const [polygonSides, setPolygonSides] = useState(6)
  const [offsetDistance, setOffsetDistance] = useState(1)
  const [sketchPatternCount, setSketchPatternCount] = useState(4)
  const [sketchPatternSpacing, setSketchPatternSpacing] = useState(2)
  const [sketchType, setSketchType] = useState<SketchTool>('rectangle')
  const [sketchPlane, setSketchPlane] = useState<SketchPlane>('top')
  const [sketchStage, setSketchStage] = useState<SketchStage>('idle')
  const [extrudeDistance, setExtrudeDistance] = useState(4)
  const [extrudeMode, setExtrudeMode] = useState<'new' | 'symmetric'>('new')
  const [showExtrudeDialog, setShowExtrudeDialog] = useState(false)
  const [solidCommand, setSolidCommand] = useState<SolidCommand | null>(null)
  const [operationValue, setOperationValue] = useState(1)
  const [operationSpacing, setOperationSpacing] = useState(2)
  const [operationAxis, setOperationAxis] = useState<'x' | 'y' | 'z'>('y')
  const [operationToolId, setOperationToolId] = useState('')
  const [combineMode, setCombineMode] = useState<'join' | 'cut' | 'intersect'>('join')
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceId>('design')
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [treeOpen, setTreeOpen] = useState(true)
  const [propertiesOpen, setPropertiesOpen] = useState(true)
  const [search, setSearch] = useState('')
  const [toast, setToast] = useState('')
  const [documentName, setDocumentName] = useState(() => {
    try {
      const saved = localStorage.getItem('bestcad-document') ?? localStorage.getItem('clonecad-document')
      const parsed = saved ? JSON.parse(saved) : null
      return typeof parsed?.documentName === 'string' ? parsed.documentName : 'Desk clamp'
    } catch { return 'Desk clamp' }
  })
  const [renaming, setRenaming] = useState(false)
  const [savedAt, setSavedAt] = useState('All changes saved')
  const [exportDropdownOpen, setExportDropdownOpen] = useState(false)

  // Advanced CAD Workspaces State
  const [cameraProjection, setCameraProjection] = useState<'perspective' | 'orthographic'>('perspective')
  const [explodedRatio, setExplodedRatio] = useState(0)
  const [sectionAnalysis, setSectionAnalysis] = useState<SectionAnalysisState>({ enabled: false, plane: 'y', offset: 2.5, invert: false })
  const [inspectionActive, setInspectionActive] = useState(false)

  // Simulation FEA State
  const [simulationSetup, setSimulationSetup] = useState<SimulationSetup>({
    fixedPartIds: ['base'],
    loadPartId: 'jaw',
    loadForceN: 1500,
    loadDirection: '-y',
    status: 'idle',
    maxStressMpa: 0,
    minStressMpa: 0,
    factorOfSafety: 0,
    yieldStrengthMpa: 276,
  })

  // CAM State
  const [camSetup, setCAMSetup] = useState<CAMSetup>({
    stockOffsetMm: 2.0,
    toolDiameterMm: 6.0,
    spindleRpm: 14000,
    feedRateMmMin: 1200,
    selectedStrategy: 'facing',
    gcode: '',
    isSimulating: false,
    simulationProgress: 0,
  })

  // Automate / FeatureScript State
  const [activeScript, setActiveScript] = useState(SCRIPT_TEMPLATES[0].code)
  const [scriptLog, setScriptLog] = useState('BestCad FeatureScript Engine Ready.')

  // Manage / Version Snapshots State
  const [versions, setVersions] = useState<VersionSnapshot[]>(() => {
    try {
      const saved = localStorage.getItem('bestcad-document') ?? localStorage.getItem('clonecad-document')
      const parsed = saved ? JSON.parse(saved) : null
      if (Array.isArray(parsed?.versions)) return parsed.versions
    } catch {}
    return [{ id: 'v1', label: 'V1.0 - Baseline clamp assembly', timestamp: '12:00:00', description: 'Initial geometry setup with 6 parts', parts: initialParts, sketches: [] }]
  })

  // ── B-Rep Face Picking & Arbitrary Sketch Plane State ──────────────────────
  const [hoveredFacePlane, setHoveredFacePlane] = useState<ArbitraryPlane | null>(null)
  const [activeArbitraryPlane, setActiveArbitraryPlane] = useState<ArbitraryPlane | null>(null)
  const facePickOverlayRef = useRef<THREE.Mesh | null>(null)

  const selectedPart = parts.find((part) => part.id === selectedId) ?? null
  const selectedSketch = sketches.find((sketch) => sketch.id === selectedSketchId) ?? null
  const sketchDiagnostics = useMemo(() => sketchStage === 'drawing' && sketchEntities.length
    ? solveCoupledConstraints(sketchEntities, sketchConstraints).diagnostics
    : null, [sketchConstraints, sketchEntities, sketchStage])
  const profileEntities = sketchStage === 'drawing' ? sketchEntities : selectedSketch?.entities ?? sketchEntities
  const activeProfilePlane = sketchStage === 'drawing' ? sketchPlane : selectedSketch?.plane ?? sketchPlane

  const notify = useCallback((message: string) => {
    setToast(message)
  }, [])

  const commitModel = useCallback((next: ModelSnapshot) => {
    setPast((items) => [...items.slice(-29), { parts, sketches, joints }])
    setFuture([])
    setParts(next.parts)
    setSketches(syncProjectedSketches(next.sketches, next.parts))
    if (next.joints) setJoints(next.joints)
    setSavedAt('Unsaved changes')
  }, [joints, parts, sketches, setJoints])

  const commitParts = useCallback((next: Part[]) => {
    commitModel({ parts: next, sketches, joints })
  }, [commitModel, joints, sketches])

  const saveDocument = useCallback(() => {
    try {
      const serialized = JSON.stringify({ documentName, parts, sketches, selectedId, joints, versions })
      localStorage.setItem('bestcad-document', serialized)
      localStorage.setItem('clonecad-document', serialized)
      setSavedAt('Saved just now')
      notify('Document saved to this browser')
    } catch {
      notify('Could not save this document')
    }
  }, [documentName, joints, notify, parts, selectedId, sketches, versions])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const serialized = JSON.stringify({ documentName, parts, sketches, selectedId, joints, versions })
        localStorage.setItem('bestcad-document', serialized)
        localStorage.setItem('clonecad-document', serialized)
        setSavedAt('Saved automatically')
      } catch {
        setSavedAt('Could not auto-save')
      }
    }, 700)
    return () => window.clearTimeout(timeout)
  }, [documentName, joints, parts, selectedId, sketches, versions])

  const exportDocumentFile = useCallback(() => {
    const document = { documentName, parts, sketches, selectedId, joints, versions }
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = window.document.createElement('a')
    link.href = url
    link.download = `${documentName.replace(/[^a-z0-9_-]/gi, '_')}.bestcad.json`
    link.click()
    URL.revokeObjectURL(url)
    setSavedAt('Exported just now')
    notify('BestCad document exported')
  }, [documentName, joints, notify, parts, selectedId, sketches, versions])

  const importDocumentFile = useCallback(async (file?: File) => {
    if (!file) return
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid document')
      const candidate = parsed as Partial<ModelSnapshot & { documentName: string; selectedId: string | null; versions: VersionSnapshot[] }>
      if (!Array.isArray(candidate.parts) || !Array.isArray(candidate.sketches ?? [])) {
        throw new Error('Document must include parts and sketches')
      }
      if (candidate.joints !== undefined && !Array.isArray(candidate.joints)) throw new Error('Document contains invalid assembly joints')
      if (candidate.versions !== undefined && !Array.isArray(candidate.versions)) throw new Error('Document contains invalid versions')
      if (!candidate.parts.every((part) => part && typeof part.id === 'string' && Array.isArray(part.size) && part.size.length === 3 && part.size.every(Number.isFinite) && Array.isArray(part.position) && part.position.length === 3 && part.position.every(Number.isFinite))) {
        throw new Error('Document contains an invalid part')
      }
      if (!(candidate.sketches ?? []).every((sketch) => sketch && typeof sketch.id === 'string' && Array.isArray(sketch.entities))) {
        throw new Error('Document contains an invalid sketch')
      }
      setParts(candidate.parts)
      setSketches(syncProjectedSketches(candidate.sketches ?? [], candidate.parts))
      setJoints(candidate.joints ?? [])
      setVersions(candidate.versions ?? [])
      setDocumentName(typeof candidate.documentName === 'string' && candidate.documentName.trim() ? candidate.documentName : file.name.replace(/\.bestcad\.json$/i, ''))
      setSelectedId(candidate.selectedId && candidate.parts.some((part) => part.id === candidate.selectedId) ? candidate.selectedId : null)
      setSelectedSketchId(null)
      setSelectedSketchEntityId(null)
      setPast([])
      setFuture([])
      setSketchConstraints([])
      setDimensionPointRefs([])
      setSketchStage('idle')
      setSavedAt('Opened from file')
      notify('BestCad document opened')
    } catch (error) {
      notify(error instanceof Error ? `Could not open document: ${error.message}` : 'Could not open document')
    }
  }, [notify, setDimensionPointRefs, setDocumentName, setFuture, setJoints, setParts, setPast, setSavedAt, setSelectedId, setSelectedSketchEntityId, setSelectedSketchId, setSketchConstraints, setSketchStage, setSketches, setVersions])

  const undo = useCallback(() => {
    if (past.length === 0) return
    const previous = past[past.length - 1]
    setFuture((items) => [{ parts, sketches, joints }, ...items])
    setParts(previous.parts)
    setSketches(syncProjectedSketches(previous.sketches, previous.parts))
    if (previous.joints) setJoints(previous.joints)
    if (selectedId && !previous.parts.some((part) => part.id === selectedId)) setSelectedId(null)
    if (selectedSketchId && !previous.sketches.some((sketch) => sketch.id === selectedSketchId)) setSelectedSketchId(null)
    setPast((items) => items.slice(0, -1))
    setSavedAt('Unsaved changes')
  }, [joints, past, parts, selectedId, selectedSketchId, sketches, setFuture, setJoints, setParts, setPast, setSavedAt, setSelectedId, setSelectedSketchId])

  const redo = useCallback(() => {
    if (future.length === 0) return
    const next = future[0]
    setPast((items) => [...items, { parts, sketches, joints }])
    setParts(next.parts)
    setSketches(syncProjectedSketches(next.sketches, next.parts))
    if (next.joints) setJoints(next.joints)
    if (selectedId && !next.parts.some((part) => part.id === selectedId)) setSelectedId(null)
    if (selectedSketchId && !next.sketches.some((sketch) => sketch.id === selectedSketchId)) setSelectedSketchId(null)
    setFuture((items) => items.slice(1))
    setSavedAt('Unsaved changes')
  }, [future, joints, parts, selectedId, selectedSketchId, sketches, setJoints, setParts, setPast, setSavedAt, setSelectedId, setSelectedSketchId, setFuture])

  const appendSketchEntity = useCallback((entity: SketchEntity) => {
    const relations: SketchConstraint[] = []
    entity.points.forEach((point, pointIndex) => {
      let nearest: { entity: SketchEntity; pointIndex: number; distance: number } | null = null
      for (const other of sketchEntities) {
        for (let otherPointIndex = 0; otherPointIndex < other.points.length; otherPointIndex++) {
          const candidate = other.points[otherPointIndex]
          const distance = Math.hypot(point[0] - candidate[0], point[1] - candidate[1])
          if (distance < 0.24 && (!nearest || distance < nearest.distance)) nearest = { entity: other, pointIndex: otherPointIndex, distance }
        }
      }
      if (nearest) relations.push({ id: createFeatureId('constraint'), type: 'coincident', entityIds: [entity.id, nearest.entity.id], pointIndices: [pointIndex, nearest.pointIndex] })
    })
    setSketchEntities((items) => [...items, entity])
    if (relations.length) setSketchConstraints((items) => [...items, ...relations])
  }, [sketchEntities])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      const editingText = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      if (editingText) return
      const command = event.ctrlKey || event.metaKey
      if (sketchStage === 'drawing' && event.key === 'Escape' && pendingSketchPoints.length) {
        event.preventDefault()
        setPendingSketchPoints([])
      } else if (sketchStage === 'drawing' && event.key === 'Enter' && (sketchType === 'polyline' || sketchType === 'spline')) {
        event.preventDefault()
        const minimumPoints = sketchType === 'spline' ? 3 : 2
        if (pendingSketchPoints.length >= minimumPoints) {
          appendSketchEntity({ id: createFeatureId('entity'), type: sketchType === 'spline' ? 'spline' : 'line', points: pendingSketchPoints, closed: false, isConstruction: constructionMode })
          setPendingSketchPoints([])
        }
      } else if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (command && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
      } else if (command && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (event.shiftKey) exportDocumentFile()
        else saveDocument()
      } else if (command && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        documentInputRef.current?.click()
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && sketchStage === 'drawing' && selectedSketchEntityId) {
        event.preventDefault()
        const deletedId = selectedSketchEntityId
        setSketchEntities((entities) => entities.filter((entity) => entity.id !== deletedId))
        setSketchConstraints((constraints) => constraints.filter((constraint) => !constraint.entityIds.includes(deletedId)))
        setSelectedSketchEntityId(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [appendSketchEntity, constructionMode, exportDocumentFile, pendingSketchPoints, redo, saveDocument, selectedSketchEntityId, setSketchConstraints, setSketchEntities, setSelectedSketchEntityId, sketchStage, sketchType, undo])

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    commitParts(parts.filter((part) => part.id !== selectedId))
    setSelectedId(null)
    notify('Part deleted')
  }, [commitParts, notify, parts, selectedId])

  const createExtrusion = useCallback(() => {
    if (!Number.isFinite(extrudeDistance) || extrudeDistance <= 0) {
      notify(`Choose a valid ${sketchType} profile and a positive extrusion distance`)
      return
    }
    const closedProfiles = profileEntities.filter((entity) => entity.closed && entity.type !== 'arc' && !entity.isConstruction)
    if (!closedProfiles.length) {
      notify('Add at least one closed profile to the sketch before extruding')
      return
    }
    const profiles = closedProfiles.map((entity) => ({ entity, points: closedProfilePoints(entity) }))
    if (profiles.some(({ points }) => points.length < 3 || polygonArea(points) <= 1e-9 || polygonHasSelfIntersection(points))) {
      notify('Each extruded profile must be closed and non-self-intersecting')
      return
    }
    const plane = activeProfilePlane
    const arbitraryPlane = sketchStage === 'drawing' ? activeArbitraryPlane : selectedSketch?.arbitraryPlane ?? null
    const axes = sketchPlaneAxes(plane)
    const firstFeatureId = `extrude-${Date.now()}`
    const newParts = profiles.map(({ entity, points }, index): Part => {
      const bounds = sketchProfileBounds(points)
      const size: Part['size'] = arbitraryPlane ? [bounds.width, bounds.height, extrudeDistance] : [0, 0, 0]
      if (!arbitraryPlane) {
        size[axes.uAxis] = bounds.width
        size[axes.vAxis] = bounds.height
        size[axes.normalAxis] = extrudeDistance
      }
      const profileType: SketchProfile = entity.type === 'circle' ? 'circle' : entity.type === 'rectangle' ? 'rectangle' : 'polygon'
      const count = parts.filter((part) => part.kind === 'extrusion').length + index + 1
      return {
        id: `${firstFeatureId}-${index + 1}`,
        name: `${profileType === 'circle' ? 'Circular extrude' : 'Extrude'} ${count}`,
        kind: 'extrusion',
        profile: points,
        profileType,
        profilePlane: plane,
        arbitraryPlane: arbitraryPlane ?? undefined,
        extrudeMode,
        sketchId: selectedSketchId ?? selectedSketch?.id,
        sketchEntityId: entity.id,
        size,
        position: arbitraryPlane ? [...arbitraryPlane.origin] : plane === 'top' ? [0, SKETCH_PLANE_Y, 0] : [0, 0, 0],
        color: '#78a9dc',
        materialId: 'aluminum',
        visible: true,
      }
    })
    commitParts([...parts, ...newParts])
    setSelectedId(newParts[0].id)
    setSelectedSketchId(null)
    setSketchEntities([])
    setSketchStage('idle')
    setShowExtrudeDialog(false)
    notify(`Created ${newParts.length} extruded ${newParts.length === 1 ? 'profile' : 'profiles'}`)
  }, [activeArbitraryPlane, activeProfilePlane, commitParts, extrudeDistance, extrudeMode, notify, parts, profileEntities, selectedSketch, selectedSketchId, setShowExtrudeDialog, sketchStage, sketchType])

  function deleteSelectedSketch(sketchId: string) {
    const dependentParts = parts.filter((part) => part.sketchId === sketchId || part.loftSketchIds?.includes(sketchId) || part.sweepSketchIds?.includes(sketchId))
    commitModel({
      parts: dependentParts.length ? parts.filter((part) => part.sketchId !== sketchId && !part.loftSketchIds?.includes(sketchId) && !part.sweepSketchIds?.includes(sketchId)) : parts,
      sketches: sketches.filter((sketch) => sketch.id !== sketchId),
      joints,
    })
    if (dependentParts.some((part) => part.id === selectedId)) setSelectedId(null)
    if (selectedSketchId === sketchId) setSelectedSketchId(null)
    notify(dependentParts.length ? `Sketch and ${dependentParts.length} dependent feature${dependentParts.length === 1 ? '' : 's'} deleted` : 'Sketch deleted')
  }

  function startSketch(profileType: SketchTool = 'rectangle') {
    editingSketchRef.current = null
    sketchReturnProjectionRef.current = cameraProjection
    setSelectedSketchId(null)
    setSketchEntities([])
    setSketchConstraints([])
    setSelectedSketchEntityId(null)
    setDimensionPointRefs([])
    setConstraintMessage('')
    setPendingSketchPoints([])
    setSketchType(profileType)
    setShowExtrudeDialog(false)
    setSolidCommand(null)
    setActiveArbitraryPlane(null)
    setHoveredFacePlane(null)
    setSketchPlane('top')
    setSketchStage('plane-selection')
    notify('Choose a sketch plane or click a flat face in the viewport')
  }

  function pickStandardPlane(plane: 'top' | 'front' | 'right') {
    setActiveArbitraryPlane(null)
    setHoveredFacePlane(null)
    setSketchPlane(plane)
    setCameraProjection('orthographic')
    setSketchStage('drawing')
    notify(`Sketching on ${plane} plane · choose a tool, then click to draw`)
  }

  function finishSketch() {
    if (!sketchEntities.length) { notify('Draw a profile before finishing the sketch'); return }
    const previous = editingSketchRef.current
    const feature: SketchFeature = {
      id: previous?.id ?? createFeatureId('sketch'),
      name: previous?.name ?? `Sketch ${sketches.length + 1}`,
      plane: sketchPlane,
      arbitraryPlane: activeArbitraryPlane ?? undefined,
      entities: sketchEntities,
      constraints: sketchConstraints,
      visible: previous?.visible ?? true,
    }
    const nextSketches = previous ? sketches.map((item) => item.id === previous.id ? feature : item) : [...sketches, feature]
    let nextParts = parts
    if (previous) {
      const regenerated = new Map<string, Part>()
      for (const part of parts.filter((item) => item.sketchId === previous.id && item.sketchEntityId)) {
        const source = feature.entities.find((entity) => entity.id === part.sketchEntityId)
        if (!source || !source.closed || source.type === 'arc' || source.isConstruction) {
          notify(`Cannot finish: ${part.name} needs its closed source profile`)
          return
        }
        const profile = closedProfilePoints(source)
        if (profile.length < 3 || polygonArea(profile) <= 1e-9 || polygonHasSelfIntersection(profile)) {
          notify(`Cannot finish: ${part.name} source profile is invalid`)
          return
        }
        const bounds = sketchProfileBounds(profile)
        const size: Part['size'] = [...part.size]
        if (part.kind === 'revolution') {
          const maxRadius = Math.max(...profile.map(([radius]) => Math.abs(radius)))
          const minHeight = Math.min(...profile.map(([, height]) => height))
          const maxHeight = Math.max(...profile.map(([, height]) => height))
          size[0] = maxRadius * 2
          size[1] = maxHeight - minHeight
          size[2] = maxRadius * 2
        } else {
          const depthAxis = part.arbitraryPlane ? 2 : sketchPlaneAxes(feature.plane).normalAxis
          const depth = part.size[depthAxis]
          if (part.arbitraryPlane) {
            size[0] = bounds.width
            size[1] = bounds.height
            size[2] = depth
          } else {
            const axes = sketchPlaneAxes(feature.plane)
            size[axes.uAxis] = bounds.width
            size[axes.vAxis] = bounds.height
            size[axes.normalAxis] = depth
          }
        }
        regenerated.set(part.id, {
          ...part,
          profile,
          profileType: source.type === 'circle' ? 'circle' : source.type === 'rectangle' ? 'rectangle' : 'polygon',
          profilePlane: feature.plane,
          arbitraryPlane: feature.arbitraryPlane,
          position: part.kind === 'revolution' ? [...part.position] : feature.arbitraryPlane ? [...feature.arbitraryPlane.origin] : feature.plane === 'top' ? [0, SKETCH_PLANE_Y, 0] : [0, 0, 0],
          size,
        })
      }
      for (const part of parts.filter((item) => item.loftSketchIds?.includes(previous.id))) {
        const firstSketch = nextSketches.find((sketch) => sketch.id === part.loftSketchIds?.[0])
        const secondSketch = nextSketches.find((sketch) => sketch.id === part.loftSketchIds?.[1])
        if (!firstSketch || !secondSketch || !part.loftSketchEntityIds) {
          notify(`Cannot finish: ${part.name} is missing a loft section`)
          return
        }
        try {
          regenerated.set(part.id, buildLoftPart(firstSketch, secondSketch, part.loftSketchEntityIds, part))
        } catch (error) {
          notify(`Cannot finish: ${error instanceof Error ? error.message : `${part.name} could not regenerate`}`)
          return
        }
      }
      for (const part of parts.filter((item) => item.sweepSketchIds?.includes(previous.id))) {
        const profileSketch = nextSketches.find((sketch) => sketch.id === part.sweepSketchIds?.[0])
        const pathSketch = nextSketches.find((sketch) => sketch.id === part.sweepSketchIds?.[1])
        if (!profileSketch || !pathSketch || !part.sweepSketchEntityIds) {
          notify(`Cannot finish: ${part.name} is missing a sweep section`)
          return
        }
        try {
          regenerated.set(part.id, buildSweepPart(profileSketch, pathSketch, part.sweepSketchEntityIds, part))
        } catch (error) {
          notify(`Cannot finish: ${error instanceof Error ? error.message : `${part.name} could not regenerate`}`)
          return
        }
      }
      if (regenerated.size) nextParts = parts.map((part) => regenerated.get(part.id) ?? part)
    }
    commitModel({ parts: nextParts, sketches: nextSketches, joints })
    setSelectedSketchId(feature.id)
    setSelectedId(null)
    editingSketchRef.current = null
    setPendingSketchPoints([])
    setSketchEntities([])
    setSketchConstraints([])
    setSelectedSketchEntityId(null)
    setDimensionPointRefs([])
    setActiveArbitraryPlane(null)
    setConstraintMessage('')
    setSketchStage('idle')
    setCameraProjection(sketchReturnProjectionRef.current)
    notify(`${feature.name} saved · ready for 3D features`)
  }

  function cancelSketch() {
    const returnProjection = sketchReturnProjectionRef.current
    editingSketchRef.current = null
    setPendingSketchPoints([])
    setSketchEntities([])
    setSketchConstraints([])
    setSelectedSketchEntityId(null)
    setDimensionPointRefs([])
    setActiveArbitraryPlane(null)
    setHoveredFacePlane(null)
    setConstraintMessage('')
    setSketchStage('idle')
    setCameraProjection(returnProjection)
  }

  function editSketch(sketch: SketchFeature) {
    sketchReturnProjectionRef.current = cameraProjection
    editingSketchRef.current = sketch
    setSketchPlane(sketch.plane)
    setActiveArbitraryPlane(sketch.arbitraryPlane ?? null)
    setSketchEntities(sketch.entities)
    setSelectedSketchEntityId(null)
    setSketchConstraints(sketch.constraints ?? [])
    setDimensionPointRefs([])
    setConstraintMessage(sketch.constraints?.length ? `${sketch.constraints.length} saved constraint(s)` : '')
    setPendingSketchPoints([])
    setSelectedSketchId(sketch.id)
    setSelectedId(null)
    setCameraProjection('orthographic')
    setSketchStage('drawing')
  }

  function chooseSketchTool(tool: SketchTool) {
    setSketchType(tool)
    setPendingSketchPoints([])
    setSketchCursorPoint(null)
    setRelatedSketchEntityId(null)
    setDimensionPointRefs([])
  }

  const addSketchPoint = useCallback((point: [number, number]) => {
    if (sketchType === 'select' || sketchType === 'trim' || sketchType === 'offset' || sketchType === 'dimension') return
    if (sketchType === 'polyline') {
      if (pendingSketchPoints.length >= 3 && Math.hypot(pendingSketchPoints[0][0] - point[0], pendingSketchPoints[0][1] - point[1]) <= 0.35) {
        appendSketchEntity({ id: createFeatureId('entity'), type: 'line', points: pendingSketchPoints, closed: true, isConstruction: constructionMode })
        setPendingSketchPoints([])
        return
      }
      setPendingSketchPoints((points) => [...points, point])
      return
    }
    if (sketchType === 'spline') {
      setPendingSketchPoints((points) => [...points, point])
      return
    }
    const required = ['arc', 'ellipse', 'slot'].includes(sketchType) ? 3 : 2
    const next = [...pendingSketchPoints, point]
    if (next.length < required) { setPendingSketchPoints(next); return }
    const type = sketchType === 'line' ? 'line' : sketchType === 'circle' ? 'circle' : sketchType === 'arc' ? 'arc' : sketchType === 'ellipse' ? 'ellipse' : sketchType === 'polygon' ? 'polygon' : sketchType === 'slot' ? 'slot' : 'rectangle'
    const closed = ['circle', 'ellipse', 'polygon', 'slot', 'rectangle'].includes(type)
    const entity: SketchEntity = { id: createFeatureId('entity'), type, points: next, closed, isConstruction: constructionMode, ...(type === 'polygon' ? { sides: polygonSides } : {}) }
    if (type === 'line') {
      const [first, second] = next
      const dx = second[0] - first[0], dy = second[1] - first[1]
      const relation = Math.abs(dy) <= Math.abs(dx) * 0.025 ? 'horizontal' : Math.abs(dx) <= Math.abs(dy) * 0.025 ? 'vertical' : null
      if (relation === 'horizontal') entity.points[1] = [second[0], first[1]]
      if (relation === 'vertical') entity.points[1] = [first[0], second[1]]
      appendSketchEntity(entity)
      if (relation && !constructionMode) {
        setSketchConstraints((items) => [...items, { id: createFeatureId('constraint'), type: relation, entityIds: [entity.id] }])
        setConstraintMessage(`Automatic ${relation} relation added`)
      }
    } else appendSketchEntity(entity)
    setPendingSketchPoints([])
  }, [appendSketchEntity, constructionMode, pendingSketchPoints, polygonSides, sketchType])

  const snapSketchPoint = useCallback((point: [number, number], bypass: boolean): [number, number] => {
    if (bypass || !sketchSnapEnabled) return point
    let snapped: [number, number] = [Math.round(point[0] * 2) / 2, Math.round(point[1] * 2) / 2]
    let nearestDistance = 0.24
    for (const entity of sketchEntities) {
      const candidates = entity.type === 'rectangle' && entity.points.length >= 2
        ? [entity.points[0], entity.points[1], [entity.points[0][0], entity.points[1][1]] as [number, number], [entity.points[1][0], entity.points[0][1]] as [number, number]]
        : entity.points
      for (const candidate of candidates) {
        const distance = Math.hypot(candidate[0] - point[0], candidate[1] - point[1])
        if (distance < nearestDistance) { snapped = candidate; nearestDistance = distance }
      }
    }
    return snapped
  }, [sketchEntities, sketchSnapEnabled])

  const addDimensionPoint = useCallback((point: [number, number]) => {
    if (dimensionMode === 'width' || dimensionMode === 'height') {
      const rectangle = sketchEntities
        .filter((entity) => entity.type === 'rectangle' && !entity.isProjected)
        .map((entity) => ({ entity, distance: sketchEntityDistance(entity, point) }))
        .filter((item) => item.distance <= 0.35)
        .sort((a, b) => a.distance - b.distance)[0]?.entity
      if (!rectangle) { notify(`${dimensionMode === 'width' ? 'Width' : 'Height'} dimensions require clicking a rectangle edge`); return }
      setDimensionPointRefs([{ entityId: rectangle.id, pointIndex: 0 }])
      setDimensionValue(Number(Math.abs(rectangle.points[1][dimensionMode === 'width' ? 0 : 1] - rectangle.points[0][dimensionMode === 'width' ? 0 : 1]).toFixed(2)))
      notify(`Enter the rectangle ${dimensionMode} and apply the dimension`)
      return
    }
    const nearestCurve = sketchEntities
      .filter((entity) => ['line', 'circle', 'arc'].includes(entity.type))
      .map((entity) => ({ entity, distance: sketchEntityDistance(entity, point) }))
      .filter((item) => item.distance <= 0.28)
      .sort((a, b) => a.distance - b.distance)[0]
    if (dimensionMode === 'angle') {
      const line = nearestCurve?.entity
      if (!line || line.type !== 'line' || line.points.length !== 2) { notify('Angle dimensions require selecting two straight lines'); return }
      if (!dimensionPointRefs.length) {
        setDimensionPointRefs([{ entityId: line.id, pointIndex: 0 }])
        notify('Select the second line for the angle')
        return
      }
      const firstRef = dimensionPointRefs[0]
      if (firstRef.entityId === line.id) { notify('Choose a different second line'); return }
      const firstLine = sketchEntities.find((entity) => entity.id === firstRef.entityId)
      if (!firstLine || firstLine.type !== 'line' || firstLine.points.length !== 2) { setDimensionPointRefs([{ entityId: line.id, pointIndex: 0 }]); return }
      const [a0, a1] = firstLine.points, [b0, b1] = line.points
      const ax = a1[0] - a0[0], ay = a1[1] - a0[1], bx = b1[0] - b0[0], by = b1[1] - b0[1]
      const angle = Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * 180 / Math.PI
      setDimensionPointRefs([firstRef, { entityId: line.id, pointIndex: 0 }])
      setDimensionValue(Number(angle.toFixed(2)))
      notify('Enter a target angle and apply the dimension')
      return
    }
    if (nearestCurve) {
      const { entity } = nearestCurve
      let firstIndex = 0, secondIndex = 1
      if (entity.type === 'line') {
        let segmentDistance = Infinity
        const path = sketchEntityPoints(entity)
        for (let index = 0; index < path.length - 1; index++) {
          const a = path[index], b = path[index + 1]
          const dx = b[0] - a[0], dy = b[1] - a[1]
          const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
          const distance = Math.hypot(point[0] - a[0] - dx * t, point[1] - a[1] - dy * t)
          if (distance < segmentDistance) { segmentDistance = distance; firstIndex = index; secondIndex = (index + 1) % entity.points.length }
        }
      }
      const first = entity.points[firstIndex], second = entity.points[secondIndex]
      if (first && second) {
        setDimensionPointRefs([{ entityId: entity.id, pointIndex: firstIndex }, { entityId: entity.id, pointIndex: secondIndex }])
        setDimensionValue(Number(Math.hypot(first[0] - second[0], first[1] - second[1]).toFixed(2)))
        notify(entity.type === 'circle' || entity.type === 'arc' ? 'Radius selected · enter a value and apply' : 'Line length selected · enter a value and apply')
        return
      }
    }
    let nearest: { entityId: string; pointIndex: number; distance: number; coordinate: [number, number] } | null = null
    for (const entity of sketchEntities) {
      for (let pointIndex = 0; pointIndex < entity.points.length; pointIndex++) {
        const coordinate = entity.points[pointIndex]
        const distance = Math.hypot(coordinate[0] - point[0], coordinate[1] - point[1])
        if (!nearest || distance < nearest.distance) nearest = { entityId: entity.id, pointIndex, distance, coordinate }
      }
    }
    if (!nearest || nearest.distance > 0.6) {
      notify('Click a line or circle/arc edge, or click two sketch points')
      return
    }
    const ref = { entityId: nearest.entityId, pointIndex: nearest.pointIndex }
    if (!dimensionPointRefs.length) {
      setDimensionPointRefs([ref])
      notify('Choose the second point for the dimension')
      return
    }
    const firstRef = dimensionPointRefs[0]
    if (firstRef.entityId === ref.entityId && firstRef.pointIndex === ref.pointIndex) {
      notify('Choose a different second point')
      return
    }
    const first = sketchEntities.find((entity) => entity.id === firstRef.entityId)?.points[firstRef.pointIndex]
    if (!first) {
      setDimensionPointRefs([ref])
      return
    }
    setDimensionPointRefs([firstRef, ref])
    setDimensionValue(Number(Math.hypot(first[0] - nearest.coordinate[0], first[1] - nearest.coordinate[1]).toFixed(2)))
    notify('Enter a target length and apply the dimension')
  }, [dimensionMode, dimensionPointRefs, notify, sketchEntities])

  function applySketchDimension() {
    const validValue = dimensionMode === 'angle'
      ? Number.isFinite(dimensionValue) && Math.abs(dimensionValue) <= 180
      : Number.isFinite(dimensionValue) && dimensionValue > 0
    const requiredRefs = dimensionMode === 'width' || dimensionMode === 'height' ? 1 : 2
    if (dimensionPointRefs.length !== requiredRefs || !validValue) {
      notify(dimensionMode === 'angle' ? 'Choose two lines and enter an angle from -180° to 180°' : 'Choose two sketch points and enter a positive dimension')
      return
    }
    const entityIds = dimensionMode === 'width' || dimensionMode === 'height'
      ? [dimensionPointRefs[0].entityId]
      : dimensionPointRefs.map((ref) => ref.entityId)
    const constraint: SketchConstraint = {
      id: createFeatureId('constraint'),
      type: dimensionMode,
      entityIds,
      value: dimensionValue,
      ...(dimensionMode === 'distance' ? { pointIndices: dimensionPointRefs.map((ref) => ref.pointIndex) as [number, number] } : {}),
    }
    const nextConstraints = [...sketchConstraints, constraint]
    const result = solveCoupledConstraints(sketchEntities, nextConstraints)
    if (!result.diagnostics.converged) {
      notify(`Dimension did not solve (${result.diagnostics.residual.toExponential(2)} residual)`)
      return
    }
    setSketchEntities(result.solvedEntities)
    setSketchConstraints(nextConstraints)
    setConstraintMessage(`${result.diagnostics.status.replace('_', ' ')} · ${result.diagnostics.dof} DOF`)
    setDimensionPointRefs([])
    notify(`Dimension set to ${dimensionValue.toFixed(2)} ${dimensionMode === 'angle' ? '°' : 'mm'}`)
  }

  function deleteSelectedSketchEntity() {
    if (!selectedSketchEntityId) return
    const deletedId = selectedSketchEntityId
    setSketchEntities((entities) => entities.filter((entity) => entity.id !== deletedId))
    setSketchConstraints((constraints) => constraints.filter((constraint) => !constraint.entityIds.includes(deletedId)))
    setSelectedSketchEntityId(null)
    setConstraintMessage('Selected sketch entity deleted')
  }

  function toggleSelectedConstruction() {
    if (selectedSketchEntityId) {
      if (sketchEntities.find((entity) => entity.id === selectedSketchEntityId)?.isProjected) {
        notify('Projected references stay construction geometry; trace them to make editable profile geometry')
        return
      }
      setSketchEntities((entities) => entities.map((entity) => entity.id === selectedSketchEntityId ? { ...entity, isConstruction: !entity.isConstruction } : entity))
    } else {
      setConstructionMode((enabled) => !enabled)
    }
  }

  function projectVisibleSketchEdges() {
    const frame = getSketchProjectionFrame({ plane: sketchPlane, arbitraryPlane: activeArbitraryPlane ?? undefined })
    const existingSources = new Set(sketchEntities.filter((entity) => entity.isProjected).map((entity) => `${entity.sourcePartId}:${entity.sourceEdgeId}`))
    const projected: SketchEntity[] = []
    for (const part of parts.filter((item) => item.visible)) {
      let brep
      try { brep = getPartBRep(part) }
      catch { continue }
      for (const edge of brep.edges) {
        const edgeId = edge.id
        const sourceKey = `${part.id}:${edgeId}`
        if (existingSources.has(sourceKey)) continue
        let geometry: ReturnType<typeof projectPartEdgeToSketch> = null
        try { geometry = projectPartEdgeToSketch(part, edgeId, frame, brep) } catch { continue }
        if (!geometry) continue
        projected.push({ ...geometry, id: createFeatureId('projection'), isConstruction: true, isProjected: true, sourcePartId: part.id, sourceEdgeId: edgeId })
        existingSources.add(sourceKey)
      }
    }
    if (!projected.length) { notify('No new projectable solid edges were found'); return }
    setSketchEntities((entities) => [...entities, ...projected])
    setSelectedSketchEntityId(projected[0].id)
    notify(`Projected ${projected.length} solid edge reference(s)`)
  }

  function toggleSelectedLineRelation(type: 'horizontal' | 'vertical') {
    const entity = sketchEntities.find((item) => item.id === selectedSketchEntityId)
    if (!entity || entity.type !== 'line' || entity.points.length !== 2) return
    const existing = sketchConstraints.find((constraint) => constraint.type === type && constraint.entityIds[0] === entity.id)
    const nextConstraints = existing
      ? sketchConstraints.filter((constraint) => constraint.id !== existing.id)
      : [...sketchConstraints, { id: createFeatureId('constraint'), type, entityIds: [entity.id] }]
    const result = solveCoupledConstraints(sketchEntities, nextConstraints)
    if (!result.diagnostics.converged) { notify(`Could not apply ${type} relation to this line`); return }
    setSketchEntities(result.solvedEntities)
    setSketchConstraints(nextConstraints)
    setConstraintMessage(`${type} relation ${existing ? 'removed' : 'applied'}`)
  }

  function toggleSelectedPairRelation(type: 'parallel' | 'perpendicular' | 'equal_length' | 'point_on_line' | 'concentric') {
    const first = sketchEntities.find((item) => item.id === selectedSketchEntityId)
    const second = sketchEntities.find((item) => item.id === relatedSketchEntityId)
    if (!first || !second || first.id === second.id) return
    const linePair = first.type === 'line' && second.type === 'line'
    const centerEntity = (entity: SketchEntity) => ['circle', 'arc', 'ellipse'].includes(entity.type)
    if ((['parallel', 'perpendicular', 'equal_length', 'point_on_line'].includes(type) && !linePair) || (type === 'concentric' && (!centerEntity(first) || !centerEntity(second)))) return
    if (type === 'point_on_line' && first.isProjected) { notify('Projected geometry is reference-only'); return }
    if (type === 'concentric' && (first.isProjected || second.isProjected)) { notify('Projected geometry is reference-only'); return }
    if (type === 'point_on_line' && Math.hypot(second.points[1][0] - second.points[0][0], second.points[1][1] - second.points[0][1]) < 1e-9) { notify('The target line has zero length'); return }
    const existing = sketchConstraints.find((constraint) => constraint.type === type && constraint.entityIds[0] === first.id && constraint.entityIds[1] === second.id)
    const nextConstraints = existing
      ? sketchConstraints.filter((constraint) => constraint.id !== existing.id)
      : [...sketchConstraints, { id: createFeatureId('constraint'), type, entityIds: [first.id, second.id], ...(type === 'point_on_line' ? { pointIndices: [0, 0] as [number, number] } : {}) }]
    const result = solveCoupledConstraints(sketchEntities, nextConstraints)
    if (!result.diagnostics.converged) { notify(`Could not apply ${type.replace('_', ' ')} relation`); return }
    setSketchEntities(result.solvedEntities)
    setSketchConstraints(nextConstraints)
    setConstraintMessage(`${type.replace('_', ' ')} relation ${existing ? 'removed' : 'applied'}`)
  }

  function toggleSelectedFix() {
    const entity = sketchEntities.find((item) => item.id === selectedSketchEntityId)
    if (!entity) return
    if (entity.isProjected) { notify('Projected geometry is reference-only'); return }
    const existing = sketchConstraints.filter((constraint) => constraint.type === 'fixed' && constraint.entityIds[0] === entity.id)
    const nextConstraints = existing.length
      ? sketchConstraints.filter((constraint) => !(constraint.type === 'fixed' && constraint.entityIds[0] === entity.id))
      : [...sketchConstraints, ...entity.points.map((point, pointIndex): SketchConstraint => ({ id: createFeatureId('constraint'), type: 'fixed', entityIds: [entity.id], pointIndices: [pointIndex, 0], value: point[0] }))]
    const result = solveCoupledConstraints(sketchEntities, nextConstraints)
    if (!result.diagnostics.converged) { notify('Could not fix this geometry while preserving its other constraints'); return }
    setSketchEntities(result.solvedEntities)
    setSketchConstraints(nextConstraints)
    setConstraintMessage(existing.length ? 'Geometry unfixed' : 'Geometry fixed')
  }

  function mirrorSelectedSketch(axis: 'x' | 'y') {
    const entity = sketchEntities.find((item) => item.id === selectedSketchEntityId)
    if (!entity) return
    const mirrored: SketchEntity = {
      ...entity,
      id: createFeatureId('entity'),
      points: entity.points.map(([x, y]): [number, number] => axis === 'x' ? [x, -y] : [-x, y]),
    }
    setSketchEntities((items) => [...items, mirrored])
    setSelectedSketchEntityId(mirrored.id)
    notify(`Mirrored geometry about the ${axis.toUpperCase()} axis`)
  }

  function patternSelectedSketch(axis: 'x' | 'y') {
    const entity = sketchEntities.find((item) => item.id === selectedSketchEntityId)
    const count = Math.max(2, Math.min(50, Math.floor(sketchPatternCount)))
    if (!entity || !Number.isFinite(sketchPatternSpacing) || sketchPatternSpacing <= 0) {
      notify('Select geometry and enter a positive pattern spacing')
      return
    }
    const copies = Array.from({ length: count - 1 }, (_, index): SketchEntity => ({
      ...entity,
      id: createFeatureId('entity'),
      points: entity.points.map(([x, y]): [number, number] => axis === 'x'
        ? [x + sketchPatternSpacing * (index + 1), y]
        : [x, y + sketchPatternSpacing * (index + 1)]),
    }))
    setSketchEntities((items) => [...items, ...copies])
    notify(`Created ${count}-instance ${axis.toUpperCase()} sketch pattern`)
  }

  function applySketchOffset() {
    const entity = sketchEntities.find((item) => item.id === selectedSketchEntityId)
    if (!entity || !Number.isFinite(offsetDistance) || offsetDistance === 0) {
      notify('Select sketch geometry and enter a non-zero offset distance')
      return
    }
    let offsetEntity: SketchEntity
    if (entity.type === 'circle') {
      const [center, edge] = entity.points
      const radius = Math.hypot(edge[0] - center[0], edge[1] - center[1]) + offsetDistance
      if (radius <= 0) { notify('Offset would collapse the circle'); return }
      const scale = radius / Math.hypot(edge[0] - center[0], edge[1] - center[1])
      offsetEntity = { ...entity, id: createFeatureId('entity'), points: [center, [center[0] + (edge[0] - center[0]) * scale, center[1] + (edge[1] - center[1]) * scale]], isConstruction: false }
    } else if (entity.type === 'ellipse') {
      const [center, xEdge, yEdge] = entity.points
      const xRadius = Math.hypot(xEdge[0] - center[0], xEdge[1] - center[1]) + offsetDistance
      const yRadius = Math.hypot(yEdge[0] - center[0], yEdge[1] - center[1]) + offsetDistance
      if (Math.min(xRadius, yRadius) <= 0) { notify('Offset would collapse the ellipse'); return }
      const scalePoint = (point: [number, number], radius: number, oldRadius: number): [number, number] => [center[0] + (point[0] - center[0]) * radius / oldRadius, center[1] + (point[1] - center[1]) * radius / oldRadius]
      offsetEntity = { ...entity, id: createFeatureId('entity'), points: [center, scalePoint(xEdge, xRadius, xRadius - offsetDistance), scalePoint(yEdge, yRadius, yRadius - offsetDistance)], isConstruction: false }
    } else if (entity.closed) {
      const points = closedProfilePoints(entity)
      const offset = offsetPolygon(points, offsetDistance)
      if (offset.some((point) => !Number.isFinite(point[0]) || !Number.isFinite(point[1])) || polygonHasSelfIntersection(offset)) {
        notify('That offset creates invalid or self-intersecting geometry')
        return
      }
      offsetEntity = { id: createFeatureId('entity'), type: 'line', points: offset, closed: true, isConstruction: false }
    } else if (entity.type === 'line') {
      offsetEntity = { id: createFeatureId('entity'), type: 'line', points: offsetOpenPath(entity.points, offsetDistance), closed: false, isConstruction: false }
    } else {
      notify('Offset supports circles, ellipses, closed profiles, and open polylines')
      return
    }
    setSketchEntities((items) => [...items, offsetEntity])
    setSelectedSketchEntityId(offsetEntity.id)
    notify(`Created offset at ${offsetDistance.toFixed(2)} mm`)
  }

  const trimSketchAt = useCallback((point: [number, number]) => {
    const target = sketchEntities
      .filter((entity) => entity.type === 'line' && !entity.closed)
      .map((entity) => ({ entity, distance: sketchEntityDistance(entity, point) }))
      .filter((item) => item.distance < 0.35)
      .sort((a, b) => a.distance - b.distance)[0]?.entity
    if (!target) { notify('Trim currently works on open line and polyline segments'); return }
    let segmentIndex = 0, clickT = 0, nearest = Infinity
    for (let index = 0; index < target.points.length - 1; index++) {
      const a = target.points[index], b = target.points[index + 1]
      const dx = b[0] - a[0], dy = b[1] - a[1]
      const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
      const distance = Math.hypot(point[0] - a[0] - dx * t, point[1] - a[1] - dy * t)
      if (distance < nearest) { nearest = distance; segmentIndex = index; clickT = t }
    }
    const a = target.points[segmentIndex], b = target.points[segmentIndex + 1]
    const intersections: { point: [number, number]; t: number }[] = []
    for (const other of sketchEntities) {
      if (other.id === target.id) continue
      const path = sketchEntityPoints(other)
      for (let index = 0; index < path.length - 1; index++) {
        const hit = segmentIntersection(a, b, path[index], path[index + 1])
        if (!hit) continue
        const dx = b[0] - a[0], dy = b[1] - a[1]
        intersections.push({ point: hit, t: ((hit[0] - a[0]) * dx + (hit[1] - a[1]) * dy) / (dx * dx + dy * dy || 1) })
      }
    }
    const cut = intersections.sort((x, y) => Math.abs(x.t - clickT) - Math.abs(y.t - clickT))[0]
    const pieces: [number, number][][] = []
    if (cut && cut.t < clickT) pieces.push([...target.points.slice(0, segmentIndex + 1), cut.point])
    else if (cut) pieces.push([cut.point, ...target.points.slice(segmentIndex + 1)])
    else {
      pieces.push(target.points.slice(0, segmentIndex + 1), target.points.slice(segmentIndex + 1))
    }
    const replacements = pieces.filter((piece) => piece.length >= 2).map((points): SketchEntity => ({ ...target, id: createFeatureId('entity'), points, closed: false }))
    setSketchEntities((entities) => [...entities.filter((entity) => entity.id !== target.id), ...replacements])
    setSketchConstraints((constraints) => constraints.filter((constraint) => !constraint.entityIds.includes(target.id)))
    setSelectedSketchEntityId(null)
    notify(cut ? 'Trimmed line to the nearest intersection' : 'Removed the selected line segment')
  }, [notify, sketchEntities])

  function addPart(kind: Primitive, options?: { name: string; size: [number, number, number]; position: [number, number, number]; color: string }) {
    const count = parts.filter((p) => p.kind === kind).length + 1
    const size: Part['size'] = options?.size ?? (kind === 'cylinder' ? [1.4, 1.5, 1.4] : kind === 'sphere' ? [1.5, 1.5, 1.5] : [1.8, 1.5, 1.8])
    const maxY = Math.max(0.3, ...parts.filter((p) => p.visible).map((p) => p.position[1] + p.size[1] / 2))
    const part: Part = {
      id: createFeatureId(kind),
      name: options?.name ?? `${kind[0].toUpperCase()}${kind.slice(1)} ${count}`,
      kind,
      size,
      position: options?.position ?? [0, maxY + size[1] / 2, 0],
      color: options?.color ?? (kind === 'cylinder' ? '#d9a85d' : kind === 'sphere' ? '#72a9a0' : '#8aa3c1'),
      materialId: kind === 'cylinder' ? 'brass' : 'aluminum',
      visible: true,
    }
    commitParts([...parts, part])
    setSelectedId(part.id)
    notify(`${part.name} added`)
  }

  function duplicateSelected() {
    if (!selectedPart) return
    const copy: Part = {
      ...selectedPart,
      id: `${selectedPart.kind}-${Date.now()}`,
      name: `${selectedPart.name} copy`,
      position: [selectedPart.position[0] + 1.4, selectedPart.position[1], selectedPart.position[2] + 1.4],
    }
    commitParts([...parts, copy])
    setSelectedId(copy.id)
    notify('Part duplicated')
  }

  function createVersionSnapshot() {
    const version: VersionSnapshot = {
      id: createFeatureId('version'),
      label: `V${versions.length + 1} · ${documentName}`,
      timestamp: new Date().toISOString(),
      description: `${parts.length} part(s), ${sketches.length} sketch(es)`,
      parts: structuredClone(parts),
      sketches: structuredClone(sketches),
      joints: structuredClone(joints),
    }
    setVersions((current) => [...current, version])
    setSavedAt('Unsaved changes')
    notify(`${version.label} snapshot created`)
  }

  function restoreVersion(version: VersionSnapshot) {
    commitModel({ parts: structuredClone(version.parts), sketches: structuredClone(version.sketches), joints: structuredClone(version.joints ?? joints) })
    setSelectedId(null)
    setSelectedSketchId(null)
    notify(`${version.label} restored · use Undo to return to the previous model`)
  }

  function updateSelectedPartSize(axis: 0 | 1 | 2, value: number) {
    if (!selectedPart || !Number.isFinite(value) || value <= 0) return
    const updatedSize: Part['size'] = [...selectedPart.size]
    updatedSize[axis] = value
    let updatedProfile = selectedPart.profile
    let nextSketches = sketches
    if (selectedPart.profile && ['extrusion', 'revolution'].includes(selectedPart.kind)) {
      let profileAxis: number
      let center: number
      let oldDimension: number
      if (selectedPart.kind === 'revolution') {
        profileAxis = axis === 1 ? 1 : 0
        if (profileAxis === 0) {
          center = 0
          oldDimension = selectedPart.size[0]
          updatedSize[0] = value
          updatedSize[2] = value
        } else {
          const heights = selectedPart.profile.map((point) => point[1])
          center = (Math.min(...heights) + Math.max(...heights)) / 2
          oldDimension = Math.max(...heights) - Math.min(...heights)
        }
      } else {
        const axes = sketchPlaneAxes(selectedPart.profilePlane ?? 'top')
        profileAxis = axis === axes.uAxis ? 0 : axis === axes.vAxis ? 1 : -1
        const vals = profileAxis < 0 ? [] : selectedPart.profile.map((point) => point[profileAxis])
        center = vals.length ? (Math.min(...vals) + Math.max(...vals)) / 2 : 0
        oldDimension = vals.length ? Math.max(...vals) - Math.min(...vals) : 0
      }
      if (profileAxis >= 0) {
        if (oldDimension <= 1e-9) return
        const factor = value / oldDimension
        updatedProfile = selectedPart.profile.map((point): [number, number] => {
          const scaled: [number, number] = [...point]
          scaled[profileAxis] = center + (point[profileAxis] - center) * factor
          return scaled
        })
        if (selectedPart.sketchId && selectedPart.sketchEntityId) {
          nextSketches = sketches.map((sketch) => sketch.id === selectedPart.sketchId ? {
            ...sketch,
            entities: sketch.entities.map((entity) => entity.id === selectedPart.sketchEntityId ? {
              ...entity,
              points: entity.points.map((point): [number, number] => {
                const scaled: [number, number] = [...point]
                scaled[profileAxis] = center + (point[profileAxis] - center) * factor
                return scaled
              }),
            } : entity),
          } : sketch)
        }
      }
    }
    const updatedParts = parts.map((part) => part.id === selectedPart.id ? { ...part, size: updatedSize, profile: updatedProfile } : part)
    commitModel({ parts: updatedParts, sketches: nextSketches, joints })
  }

  function openSolidCommand(command: SolidCommand) {
    if (command === 'loft') {
      if (!selectedSketch) {
        notify('Select a finished sketch to use as the first loft section')
        return
      }
      const target = sketches.find((sketch) => sketch.id !== selectedSketch.id && sketch.visible)
      if (!target) {
        notify('Create a second visible sketch for the loft end section')
        return
      }
      setLoftTargetSketchId(target.id)
      setSolidCommand('loft')
      return
    }
    if (command === 'sweep') {
      if (!selectedSketch) {
        notify('Select a finished sketch with a closed profile to use as the sweep section')
        return
      }
      const target = sketches.find((sketch) => sketch.id !== selectedSketch.id && sketch.visible)
      if (!target) {
        notify('Create a second sketch containing an open line or spline path')
        return
      }
      setSweepTargetSketchId(target.id)
      setSolidCommand('sweep')
      return
    }
    if (command === 'revolve') {
      if (!selectedSketch) {
        notify('Finish and select a sketch before creating a revolve')
        return
      }
      if (selectedSketch.plane !== 'front' || selectedSketch.arbitraryPlane) {
        notify('Revolve currently uses a sketch on the Front (XY) plane')
        return
      }
      setOperationValue(360)
      setSolidCommand('revolve')
      return
    } else if (command === 'combine') {
      if (!selectedPart || parts.filter((p) => p.id !== selectedPart.id).length === 0) {
        notify('Select a target body and create another body to combine')
        return
      }
      setOperationToolId(parts.find((p) => p.id !== selectedPart.id)?.id ?? '')
    } else if (!selectedPart) {
      notify(`Select a body before using ${command}`)
      return
    }
    setOperationValue(command === 'pattern' || command === 'circular-pattern' ? 4 : 0.5)
    setOperationSpacing(2)
    setOperationAxis('y')
    setSolidCommand(command)
  }

  function runCircularPattern() {
    if (!selectedPart || !Number.isFinite(operationValue) || !Number.isFinite(operationSpacing) || operationValue < 2 || operationSpacing <= 0) {
      notify('Choose at least two instances and a positive pattern radius')
      return
    }
    const count = Math.min(24, Math.floor(operationValue))
    const radius = operationSpacing
    const axisIndex = operationAxis === 'x' ? 0 : operationAxis === 'y' ? 1 : 2
    const radialAxes = [0, 1, 2].filter((axis) => axis !== axisIndex)
    const copies: Part[] = []

    for (let i = 1; i < count; i++) {
      const angle = (i * Math.PI * 2) / count
      const newPos: Part['position'] = [...selectedPart.position]
      newPos[radialAxes[0]] += Math.cos(angle) * radius
      newPos[radialAxes[1]] += Math.sin(angle) * radius
      copies.push({
        ...selectedPart,
        id: `${selectedPart.id}-circ-${Date.now()}-${i}`,
        name: `${selectedPart.name} circ ${i + 1}`,
        position: newPos,
        operation: `Circular Pattern (${count}x)`,
      })
    }
    commitParts([...parts, ...copies])
    setSolidCommand(null)
      notify(`Created circular pattern with ${count} instances about ${operationAxis.toUpperCase()} axis`)
  }

  async function runSolidCommand() {
    if (!solidCommand) return
    if (solidCommand === 'sweep') {
      const profileSketch = selectedSketch
      const pathSketch = sketches.find((sketch) => sketch.id === sweepTargetSketchId)
      if (!profileSketch || !pathSketch || profileSketch.id === pathSketch.id) {
        notify('Choose separate profile and path sketches for the sweep')
        return
      }
      const profileEntity = profileSketch.entities.find((entity) => entity.closed && !entity.isConstruction && !entity.isProjected && entity.type !== 'arc')
      const pathEntity = pathSketch.entities.find((entity) => !entity.closed && !entity.isConstruction && !entity.isProjected && ['line', 'spline'].includes(entity.type))
      if (!profileEntity || !pathEntity) {
        notify('Choose a closed profile sketch and a path sketch with an open line or spline')
        return
      }
      try {
        const part = buildSweepPart(profileSketch, pathSketch, [profileEntity.id, pathEntity.id])
        part.name = `Sweep ${parts.filter((item) => item.operation?.startsWith('Sweep')).length + 1}`
        commitParts([...parts, part])
        setSelectedId(part.id)
        setSolidCommand(null)
        notify('Sweep solid created with faceted B-rep geometry')
      } catch (error) {
        notify(error instanceof Error ? error.message : 'Sweep generation failed; check the profile and path')
      }
      return
    }
    if (solidCommand === 'loft') {
      const firstSketch = selectedSketch
      const secondSketch = sketches.find((sketch) => sketch.id === loftTargetSketchId)
      if (!firstSketch || !secondSketch || firstSketch.id === secondSketch.id) {
        notify('Choose two different finished sketches for the loft sections')
        return
      }
      const firstEntity = firstSketch.entities.find((entity) => entity.closed && !entity.isConstruction && !entity.isProjected && entity.type !== 'arc')
      const secondEntity = secondSketch.entities.find((entity) => entity.closed && !entity.isConstruction && !entity.isProjected && entity.type !== 'arc')
      if (!firstEntity || !secondEntity) {
        notify('Each loft sketch needs a closed, non-construction profile')
        return
      }
      try {
        const part = buildLoftPart(firstSketch, secondSketch, [firstEntity.id, secondEntity.id])
        part.name = `Loft ${parts.filter((item) => item.operation?.startsWith('Loft')).length + 1}`
        commitParts([...parts, part])
        setSelectedId(part.id)
        setSolidCommand(null)
        notify('Loft solid created with faceted B-rep geometry')
      } catch (error) {
        notify(error instanceof Error ? error.message : 'Loft generation failed; check the section profiles')
      }
      return
    }
    if (solidCommand === 'revolve') {
      if (!selectedSketch || selectedSketch.plane !== 'front' || selectedSketch.arbitraryPlane) {
        notify('Select a sketch on the Front (XY) plane before revolving')
        return
      }
      if (!Number.isFinite(operationValue) || operationValue <= 0 || operationValue > 360) {
        notify('Revolve angle must be greater than 0 and no more than 360 degrees')
        return
      }
      const profiles = selectedSketch.entities.filter((entity) => entity.closed && entity.type !== 'arc' && !entity.isConstruction)
      if (!profiles.length) {
        notify('The selected sketch needs a closed profile')
        return
      }
      const revolutions: Part[] = []
      for (const [index, entity] of profiles.entries()) {
        const profile = closedProfilePoints(entity)
        if (profile.length < 3 || polygonArea(profile) <= 1e-9 || polygonHasSelfIntersection(profile)) {
          notify('Each revolve profile must be closed and non-self-intersecting')
          return
        }
        const radii = profile.map(([radius]) => radius)
        if (Math.min(...radii) < -0.05 && Math.max(...radii) > 0.05) {
          notify('Revolve profile cannot cross the vertical axis')
          return
        }
        if (Math.max(...radii.map(Math.abs)) < 0.05) {
          notify('Revolve profile must have a non-zero radius')
          return
        }
        const maxRadius = Math.max(...profile.map(([radius]) => Math.abs(radius)))
        const minY = Math.min(...profile.map(([, height]) => height))
        const maxY = Math.max(...profile.map(([, height]) => height))
        revolutions.push({
          id: createFeatureId('revolve'),
          name: `Revolve ${parts.filter((part) => part.kind === 'revolution').length + index + 1}`,
          kind: 'revolution',
          profile,
          profilePlane: 'front',
          revolveAxis: 'vertical',
          revolveAngle: operationValue,
          sketchId: selectedSketch.id,
          sketchEntityId: entity.id,
          size: [maxRadius * 2, maxY - minY, maxRadius * 2],
          position: [0, 0, 0],
          color: '#78a9dc',
          materialId: 'aluminum',
          visible: true,
          operation: `Revolve ${operationValue}°`,
        })
      }
      commitParts([...parts, ...revolutions])
      setSelectedId(revolutions[0].id)
      setSolidCommand(null)
      notify(`Created ${revolutions.length} revolved profile${revolutions.length === 1 ? '' : 's'}`)
      return
    }
    if (solidCommand === 'circular-pattern') {
      runCircularPattern()
      return
    }
    if (solidCommand === 'pattern') {
      if (!selectedPart || !Number.isFinite(operationValue) || !Number.isFinite(operationSpacing) || operationValue < 2 || operationSpacing <= 0) {
        notify('Choose at least two instances and a positive spacing')
        return
      }
      const count = Math.min(20, Math.floor(operationValue))
      const axis = operationAxis === 'x' ? 0 : operationAxis === 'y' ? 1 : 2
      const copies = Array.from({ length: count - 1 }, (_, index): Part => ({
        ...selectedPart,
        id: `${selectedPart.id}-pattern-${Date.now()}-${index}`,
        name: `${selectedPart.name} pattern ${index + 2}`,
        position: selectedPart.position.map((c, i) => (i === axis ? c + operationSpacing * (index + 1) : c)) as Part['position'],
        operation: `Pattern ${count} × ${operationSpacing} mm`,
      }))
      commitParts([...parts, ...copies])
      setSolidCommand(null)
      notify(`Created ${copies.length} patterned copies`)
      return
    }
    if (solidCommand === 'fillet' || solidCommand === 'chamfer') {
      if (!selectedPart) return
      const treatment: EdgeTreatment = { type: solidCommand, size: operationValue }
      commitParts(parts.map((p) => (p.id === selectedPart.id ? { ...p, edgeTreatment: treatment, operation: `${solidCommand} ${operationValue} mm` } : p)))
      setSolidCommand(null)
      notify(`${solidCommand === 'fillet' ? 'Fillet' : 'Chamfer'} applied`)
      return
    }
    if (solidCommand === 'hole' || solidCommand === 'shell') {
      if (!selectedPart || !Number.isFinite(operationValue) || operationValue <= 0) return
      let tool: Part
      if (solidCommand === 'hole') {
        const diameter = operationValue
        const span = Math.max(...selectedPart.size) * 3
        tool = {
          id: `hole-tool-${Date.now()}`, name: 'Hole tool', kind: 'cylinder',
          size: [diameter, span, diameter], position: [...selectedPart.position],
          color: '#ffffff', visible: true,
        }
      } else {
        if (!['box', 'cylinder', 'sphere'].includes(selectedPart.kind)) {
          notify('Shell currently supports box, cylinder, and sphere bodies')
          return
        }
        const wall = operationValue
        const innerSize: Part['size'] = selectedPart.kind === 'sphere'
          ? [selectedPart.size[0] - wall * 2, selectedPart.size[1] - wall * 2, selectedPart.size[2] - wall * 2]
          : selectedPart.kind === 'cylinder'
            ? [selectedPart.size[0] - wall * 2, selectedPart.size[1] - wall, selectedPart.size[2] - wall * 2]
            : [selectedPart.size[0] - wall * 2, selectedPart.size[1] - wall * 2, selectedPart.size[2] - wall * 2]
        if (innerSize.some((dimension) => dimension <= 0)) {
          notify('Wall thickness is too large for this body')
          return
        }
        tool = { ...selectedPart, id: `shell-tool-${Date.now()}`, name: 'Shell cavity', size: innerSize, color: '#ffffff' }
      }
      try {
        const result = await createCsgResult(selectedPart, tool, 'subtract', solidCommand === 'hole' ? operationAxis : undefined)
        const updated: Part = {
          ...selectedPart,
          name: solidCommand === 'hole' ? `${selectedPart.name} · hole` : `${selectedPart.name} · shell`,
          kind: 'custom',
          meshData: result.meshData,
          size: result.size,
          position: result.position,
          operation: solidCommand === 'hole' ? `Hole Ø${operationValue} mm` : `Shell ${operationValue} mm`,
        }
        commitParts(parts.map((part) => part.id === selectedPart.id ? updated : part))
        setSolidCommand(null)
        notify(`${solidCommand === 'hole' ? 'Hole' : 'Shell'} feature applied`)
      } catch {
        notify(`${solidCommand === 'hole' ? 'Hole' : 'Shell'} failed; check the body and feature dimensions`)
      }
      return
    }
    if (solidCommand === 'combine') {
      const tool = parts.find((p) => p.id === operationToolId)
      if (!selectedPart || !tool) return
      const op = combineMode === 'join' ? 'add' : combineMode === 'cut' ? 'subtract' : 'intersect'
      let result: Awaited<ReturnType<typeof createCsgResult>>
      try {
        result = await createCsgResult(selectedPart, tool, op)
      } catch {
        notify('Combine failed; check that the bodies overlap and form valid solids')
        return
      }
      const combined: Part = {
        ...selectedPart,
        name: `${selectedPart.name} · ${combineMode}`,
        kind: 'custom',
        position: result.position,
        size: result.size,
        meshData: result.meshData,
        operation: `Combine · ${combineMode}`,
      }
      commitParts(parts.filter((p) => p.id !== tool.id).map((p) => (p.id === selectedPart.id ? combined : p)))
      setSolidCommand(null)
      notify(`Combine ${combineMode} completed`)
      return
    }
  }

  function exportBinarySTL() {
    const group = new THREE.Group()
    parts.filter((p) => p.visible).forEach((p) => group.add(createPartMesh(p, false)))
    const data = new STLExporter().parse(group, { binary: true })
    const blob = new Blob([data], { type: 'model/stl' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${documentName.replace(/[^a-z0-9_-]/gi, '_')}.stl`
    link.click()
    URL.revokeObjectURL(url)
    setExportDropdownOpen(false)
    notify('Binary STL exported')
  }

  function exportOBJ() {
    const group = new THREE.Group()
    parts.filter((p) => p.visible).forEach((p) => group.add(createPartMesh(p, false)))
    const result = new OBJExporter().parse(group)
    const blob = new Blob([result], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${documentName.replace(/[^a-z0-9_-]/gi, '_')}.obj`
    link.click()
    URL.revokeObjectURL(url)
    setExportDropdownOpen(false)
    notify('Wavefront OBJ exported')
  }

  function exportGLTF() {
    const group = new THREE.Group()
    parts.filter((p) => p.visible).forEach((p) => group.add(createPartMesh(p, false)))
    new GLTFExporter().parse(
      group,
      (gltf) => {
        const output = JSON.stringify(gltf, null, 2)
        const blob = new Blob([output], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = `${documentName.replace(/[^a-z0-9_-]/gi, '_')}.gltf`
        link.click()
        URL.revokeObjectURL(url)
        setExportDropdownOpen(false)
        notify('GLTF 2.0 exported')
      },
      (error) => {
        console.error('GLTF Export Error', error)
        notify('Could not export GLTF')
      },
    )
  }

  function exportSTEPFile() {
    try {
      exportToSTEP(parts, documentName)
      setExportDropdownOpen(false)
      notify('AP214 faceted STEP exported · curved surfaces are tessellated')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'STEP export failed; check that each visible body is a closed solid')
    }
  }

  function exportDrawingSVG() {
    const svg = generateEngineeringDrawingSVG(parts, documentName)
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${documentName.replace(/[^a-z0-9_-]/gi, '_')}_Drawing.svg`
    link.click()
    URL.revokeObjectURL(url)
    setExportDropdownOpen(false)
    notify('Engineering Drawing SVG exported')
  }

  function exportAssemblyBOM() {
    const bom = generateBOM(parts)
    exportBOMtoCSV(bom, documentName)
    setExportDropdownOpen(false)
    notify('Bill of Materials CSV exported')
  }

  function runFEASimulation() {
    const targetPart = parts.find((p) => p.id === simulationSetup.loadPartId) || parts[0]
    if (!targetPart) {
      notify('Select a component to run simulation')
      return
    }
    const mesh = createPartMesh(targetPart, false)
    const result = solveStaticStressFEA(targetPart, mesh.geometry, simulationSetup)

    setSimulationSetup((prev) => ({
      ...prev,
      status: 'solved',
      maxStressMpa: result.maxStressMpa,
      minStressMpa: result.minStressMpa,
      factorOfSafety: result.factorOfSafety,
      yieldStrengthMpa: result.yieldStrengthMpa,
    }))

    const updatedParts = parts.map((p) => {
      if (p.id === targetPart.id) {
        return {
          ...p,
          meshData: {
            positions: Array.from(result.meshWithStressColors.getAttribute('position').array),
            indices: Array.from(result.meshWithStressColors.getIndex()?.array || []),
            normals: Array.from(result.meshWithStressColors.getAttribute('color')?.array || []),
          },
        }
      }
      return p
    })
    setParts(updatedParts)
    notify(`FEA Solved: Max Stress ${result.maxStressMpa} MPa · FOS: ${result.factorOfSafety}`)
  }

  function calculateCAM() {
    if (!parts.some((part) => part.visible)) {
      setCAMSetup((prev) => ({ ...prev, gcode: '', isSimulating: false }))
      notify('Show at least one part before generating CAM toolpaths')
      return
    }
    if (!Number.isFinite(camSetup.toolDiameterMm) || camSetup.toolDiameterMm <= 0 || !Number.isFinite(camSetup.feedRateMmMin) || camSetup.feedRateMmMin <= 0 || !Number.isFinite(camSetup.spindleRpm) || camSetup.spindleRpm <= 0 || !Number.isFinite(camSetup.stockOffsetMm) || camSetup.stockOffsetMm < 0) {
      setCAMSetup((prev) => ({ ...prev, gcode: '', isSimulating: false }))
      notify('Enter a positive tool diameter, spindle speed, and feed rate, plus a non-negative stock offset')
      return
    }
    let res: ReturnType<typeof generateCAMToolpaths>
    try {
      res = generateCAMToolpaths(parts, camSetup)
    } catch (error) {
      setCAMSetup((prev) => ({ ...prev, gcode: '', isSimulating: false }))
      notify(error instanceof Error ? `Cannot generate CAM: ${error.message}` : 'Cannot generate CAM toolpaths')
      return
    }
    setCAMSetup((prev) => ({ ...prev, gcode: res.gcode, isSimulating: false }))
    notify(`CAM Generated: ${res.segments.length} passes · Est. Time: ${res.totalTimeMinutes} min`)
  }

  function runAutomationScript() {
    const res = executeCADScript(activeScript, (kind, options) => {
      addPart(kind, options)
    })
    setScriptLog(res.log)
    if (res.success) {
      notify(`Script executed: ${res.partsCreated} parts generated`)
    } else {
      notify('Script error! See console below')
    }
  }

  function captureRenderSnapshot() {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.renderer.render(viewer.scene, viewer.camera)
    const dataUrl = viewer.renderer.domElement.toDataURL('image/png')
    const link = document.createElement('a')
    link.href = dataUrl
    link.download = `${documentName.replace(/[^a-z0-9_-]/gi, '_')}_Render.png`
    link.click()
    notify('High-resolution render saved')
  }

  function toggleCameraProjection() {
    const viewer = viewerRef.current
    if (!viewer) return
    const nextProj = cameraProjection === 'perspective' ? 'orthographic' : 'perspective'
    setCameraProjection(nextProj)

    const target = viewer.controls.target.clone()
    const pos = viewer.camera.position.clone()

    if (nextProj === 'orthographic') {
      viewer.orthoCamera.position.copy(pos)
      viewer.orthoCamera.lookAt(target)
      viewer.camera = viewer.orthoCamera
      viewer.controls.object = viewer.orthoCamera
    } else {
      viewer.perspCamera.position.copy(pos)
      viewer.perspCamera.lookAt(target)
      viewer.camera = viewer.perspCamera
      viewer.controls.object = viewer.perspCamera
    }
    viewer.controls.update()
    notify(`Camera: ${nextProj.toUpperCase()}`)
  }

  useEffect(() => {
    const host = viewportRef.current
    if (!host) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#1b2028')
    scene.fog = new THREE.Fog('#1b2028', 35, 75)

    const perspCamera = new THREE.PerspectiveCamera(42, 1, 0.1, 140)
    perspCamera.position.set(11, 10, 13)
    perspCamera.lookAt(0, 2.25, 0)

    const aspect = host.clientWidth / (host.clientHeight || 1)
    const frustumSize = 18
    const orthoCamera = new THREE.OrthographicCamera(
      (-frustumSize * aspect) / 2,
      (frustumSize * aspect) / 2,
      frustumSize / 2,
      -frustumSize / 2,
      0.1,
      200,
    )
    orthoCamera.position.set(11, 10, 13)
    orthoCamera.lookAt(0, 2.25, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.15
    renderer.localClippingEnabled = true
    host.appendChild(renderer.domElement)

    scene.add(new THREE.HemisphereLight('#dce8ff', '#58616c', 2.2))
    const keyLight = new THREE.DirectionalLight('#fff1d2', 3.4)
    keyLight.position.set(-5, 12, 8)
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(2048, 2048)
    scene.add(keyLight)
    const fillLight = new THREE.DirectionalLight('#8bb5ff', 1.4)
    fillLight.position.set(8, 6, -8)
    scene.add(fillLight)

    const grid = new THREE.GridHelper(30, 30, '#647184', '#424b58')
    grid.position.y = -0.02
    grid.userData.isGrid = true
    scene.add(grid)

    const axes = new THREE.AxesHelper(3)
    axes.position.set(-0.02, 0.02, -0.02)
    axes.userData.isAxisHelper = true
    scene.add(axes)

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: 0.22 }))
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.04
    ground.receiveShadow = true
    ground.userData.isGround = true
    scene.add(ground)

    const partGroup = new THREE.Group()
    scene.add(partGroup)
    const sketchGroup = new THREE.Group()
    scene.add(sketchGroup)
    const planes = new THREE.Group()
    scene.add(planes)
    const toolpathGroup = new THREE.Group()
    scene.add(toolpathGroup)
    const simulationGroup = new THREE.Group()
    scene.add(simulationGroup)

    const sectionClippingPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 2.5)

    const activeCam = cameraProjection === 'perspective' ? perspCamera : orthoCamera
    const controls = new OrbitControls(activeCam, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.075
    controls.target.set(0, 2.25, 0)
    controls.minDistance = 2
    controls.maxDistance = 60

    const resize = () => {
      const { width, height } = host.getBoundingClientRect()
      if (!width || !height) return
      const currentAspect = width / height
      perspCamera.aspect = currentAspect
      perspCamera.updateProjectionMatrix()

      orthoCamera.left = (-frustumSize * currentAspect) / 2
      orthoCamera.right = (frustumSize * currentAspect) / 2
      orthoCamera.top = frustumSize / 2
      orthoCamera.bottom = -frustumSize / 2
      orthoCamera.updateProjectionMatrix()

      renderer.setSize(width, height)
    }

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(host)
    resize()

    const currentViewer: Viewer = {
      scene,
      camera: activeCam,
      perspCamera,
      orthoCamera,
      renderer,
      controls,
      parts: partGroup,
      sketch: sketchGroup,
      planes,
      toolpathGroup,
      simulationGroup,
      sectionClippingPlane,
      resizeObserver,
      frame: 0,
    }
    viewerRef.current = currentViewer

    const render = () => {
      controls.update()
      renderer.render(scene, currentViewer.camera)
      currentViewer.frame = window.requestAnimationFrame(render)
    }
    render()

    return () => {
      resizeObserver.disconnect()
      window.cancelAnimationFrame(currentViewer.frame)
      controls.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      viewerRef.current = null
    }
  }, [cameraProjection])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    if (sketchStage !== 'drawing') { viewer.controls.enabled = true; return }
    const frame = sketchPlaneFrame(sketchPlane, activeArbitraryPlane ?? undefined)
    const target = frame.origin
    viewer.controls.enabled = false
    viewer.controls.target.copy(target)
    viewer.camera.position.copy(target).addScaledVector(frame.normal, 18)
    viewer.camera.up.copy(frame.vAxis)
    viewer.camera.lookAt(target)
    viewer.controls.update()
  }, [activeArbitraryPlane, cameraProjection, sketchPlane, sketchStage])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.sketch.clear()
    const active = sketchStage === 'drawing'
      ? [{ plane: sketchPlane, arbitraryPlane: activeArbitraryPlane ?? undefined, entities: sketchEntities, visible: true }]
      : sketches.filter((item) => item.visible && (item.id === selectedSketchId || parts.some((part) => part.sketchId === item.id)))
    if (sketchStage === 'drawing') {
      const frame = sketchPlaneFrame(sketchPlane, activeArbitraryPlane ?? undefined)
      const grid = new THREE.GridHelper(24, 24, '#58705f', '#34443a')
      grid.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), frame.normal)
      grid.position.copy(frame.origin).addScaledVector(frame.normal, -0.015)
      viewer.sketch.add(grid)
      if (sketchCursorPoint && sketchType !== 'select' && sketchType !== 'dimension') {
        const previewPoints = [...pendingSketchPoints, sketchCursorPoint]
        let preview: [number, number][] = []
        if (sketchType === 'line' && previewPoints.length >= 2) preview = previewPoints.slice(-2)
        else if (sketchType === 'polyline' && previewPoints.length >= 2) {
          preview = [...previewPoints]
          if (preview.length >= 4 && Math.hypot(preview[0][0] - sketchCursorPoint[0], preview[0][1] - sketchCursorPoint[1]) <= 0.35) preview.push(preview[0])
        }
        else if (sketchType === 'spline' && previewPoints.length >= 3) preview = sketchEntityPoints({ id: 'preview', type: 'spline', points: previewPoints, closed: false })
        else if (sketchType === 'rectangle' && previewPoints.length >= 2) {
          const [a, b] = previewPoints.slice(-2)
          preview = [a, [b[0], a[1]], b, [a[0], b[1]], a]
        } else if (sketchType === 'circle' && previewPoints.length >= 2) {
          const [center, edge] = previewPoints.slice(-2)
          const radius = Math.hypot(edge[0] - center[0], edge[1] - center[1])
          preview = Array.from({ length: 49 }, (_, index): [number, number] => [center[0] + Math.cos(index * Math.PI / 24) * radius, center[1] + Math.sin(index * Math.PI / 24) * radius])
        } else if (sketchType === 'polygon' && previewPoints.length >= 2) preview = sketchEntityPoints({ id: 'preview', type: 'polygon', points: previewPoints.slice(-2), closed: true, sides: polygonSides })
        else if (sketchType === 'ellipse' && previewPoints.length >= 3) preview = sketchEntityPoints({ id: 'preview', type: 'ellipse', points: previewPoints.slice(-3), closed: true })
        else if (sketchType === 'slot' && previewPoints.length >= 3) preview = sketchEntityPoints({ id: 'preview', type: 'slot', points: previewPoints.slice(-3), closed: true })
        else if (sketchType === 'arc' && previewPoints.length >= 3) preview = arcPoints(previewPoints[0], previewPoints[1], previewPoints[2])
        else if (previewPoints.length) preview = [previewPoints[previewPoints.length - 1], sketchCursorPoint]
        if (preview.length >= 2) {
          const positions: number[] = []
          preview.forEach(([u, v]) => {
            const world = frame.origin.clone().addScaledVector(frame.uAxis, u).addScaledVector(frame.vAxis, v).addScaledVector(frame.normal, 0.025)
            positions.push(world.x, world.y, world.z)
          })
          const geometry = new THREE.BufferGeometry()
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
          const previewMaterial = constructionMode
            ? new THREE.LineDashedMaterial({ color: '#ffbd63', dashSize: 0.18, gapSize: 0.1, depthTest: false })
            : new THREE.LineBasicMaterial({ color: '#ffbd63', depthTest: false })
          const line = new THREE.Line(geometry, previewMaterial)
          if (constructionMode) line.computeLineDistances()
          line.renderOrder = 12
          viewer.sketch.add(line)
        }
        const cursor = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), new THREE.MeshBasicMaterial({ color: '#ffbd63', depthTest: false }))
        cursor.position.copy(frame.origin).addScaledVector(frame.uAxis, sketchCursorPoint[0]).addScaledVector(frame.vAxis, sketchCursorPoint[1]).addScaledVector(frame.normal, 0.03)
        cursor.renderOrder = 13
        viewer.sketch.add(cursor)
      }
      pendingSketchPoints.forEach(([u, v]) => {
        const marker = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshBasicMaterial({ color: '#ffbd63', depthTest: false }))
        marker.position.copy(frame.origin).addScaledVector(frame.uAxis, u).addScaledVector(frame.vAxis, v).addScaledVector(frame.normal, 0.025)
        marker.renderOrder = 11
        viewer.sketch.add(marker)
      })
    }
    active.forEach((sketch) => {
      const frame = sketchPlaneFrame(sketch.plane, sketch.arbitraryPlane)
      sketch.entities.forEach((entity) => {
        const points = sketchEntityPoints(entity)
        if (points.length < 2) return
        const positions: number[] = []
        points.forEach(([u, v]) => {
          const world = frame.origin.clone().addScaledVector(frame.uAxis, u).addScaledVector(frame.vAxis, v).addScaledVector(frame.normal, 0.01)
          positions.push(world.x, world.y, world.z)
        })
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        const color = entity.isBrokenProjection ? '#ff6573' : entity.isProjected ? '#c790ff' : entity.isConstruction ? '#f5a84e' : sketchStage === 'drawing' ? (entity.id === selectedSketchEntityId ? '#ffc46a' : '#76e7a5') : '#ffad48'
        const material = entity.isConstruction
          ? new THREE.LineDashedMaterial({ color, dashSize: 0.18, gapSize: 0.1, depthTest: false })
          : new THREE.LineBasicMaterial({ color, depthTest: false })
        const line = new THREE.Line(geometry, material)
        if (entity.isConstruction) line.computeLineDistances()
        line.renderOrder = 10
        viewer.sketch.add(line)
      })
    })
    if (sketchStage === 'drawing' && sketchConstraints.length) {
      const frame = sketchPlaneFrame(sketchPlane, activeArbitraryPlane ?? undefined)
      for (const constraint of sketchConstraints.filter((item) => (item.type === 'distance' || item.type === 'angle' || item.type === 'width' || item.type === 'height') && item.entityIds.length)) {
        const entityA = sketchEntities.find((entity) => entity.id === constraint.entityIds[0])
        const entityB = sketchEntities.find((entity) => entity.id === (constraint.entityIds[1] ?? constraint.entityIds[0]))
        if (!entityA || !entityB) continue
        if (constraint.type === 'angle') {
          if (entityA.type !== 'line' || entityB.type !== 'line' || entityA.points.length !== 2 || entityB.points.length !== 2) continue
          const centerA: [number, number] = [(entityA.points[0][0] + entityA.points[1][0]) / 2, (entityA.points[0][1] + entityA.points[1][1]) / 2]
          const centerB: [number, number] = [(entityB.points[0][0] + entityB.points[1][0]) / 2, (entityB.points[0][1] + entityB.points[1][1]) / 2]
          const canvas = document.createElement('canvas')
          canvas.width = 256; canvas.height = 64
          const context = canvas.getContext('2d')
          if (context) {
            context.fillStyle = 'rgba(14, 26, 36, 0.92)'; context.beginPath(); context.roundRect(4, 4, 248, 56, 12); context.fill()
            context.fillStyle = '#a9eaff'; context.font = 'bold 30px Segoe UI, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'
            context.fillText(`${(constraint.value ?? 0).toFixed(2)}°`, 128, 32)
            const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false }))
            label.position.copy(frame.origin).addScaledVector(frame.uAxis, (centerA[0] + centerB[0]) / 2).addScaledVector(frame.vAxis, (centerA[1] + centerB[1]) / 2).addScaledVector(frame.normal, 0.055)
            label.scale.set(1.1, 0.25, 1); label.renderOrder = 15; viewer.sketch.add(label)
          }
          continue
        }
        let first = entityA.points[constraint.pointIndices?.[0] ?? 0]
        let second = entityB.points[constraint.pointIndices?.[1] ?? 1]
        if ((constraint.type === 'width' || constraint.type === 'height') && entityA.type === 'rectangle' && entityA.points.length >= 2) {
          const [cornerA, cornerB] = entityA.points
          if (constraint.type === 'width') second = [cornerB[0], cornerA[1]]
          else second = [cornerA[0], cornerB[1]]
        }
        if (!first || !second) continue
        const dx = second[0] - first[0], dy = second[1] - first[1]
        const length = Math.hypot(dx, dy)
        if (length < 1e-6) continue
        const nx = constraint.type === 'width' ? 0 : constraint.type === 'height' ? -0.28 : -dy / length * 0.28
        const ny = constraint.type === 'width' ? -0.28 : constraint.type === 'height' ? 0 : dx / length * 0.28
        const a = [first[0] + nx, first[1] + ny] as [number, number]
        const b = [second[0] + nx, second[1] + ny] as [number, number]
        const lineGeometry = new THREE.BufferGeometry()
        const linePositions: number[] = []
        for (const point of [first, a, second, b, a, b]) {
          const world = frame.origin.clone().addScaledVector(frame.uAxis, point[0]).addScaledVector(frame.vAxis, point[1]).addScaledVector(frame.normal, 0.045)
          linePositions.push(world.x, world.y, world.z)
        }
        lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3))
        const dimensionLine = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ color: '#7ddcff', depthTest: false }))
        dimensionLine.renderOrder = 14
        viewer.sketch.add(dimensionLine)

        const canvas = document.createElement('canvas')
        canvas.width = 256; canvas.height = 64
        const context = canvas.getContext('2d')
        if (context) {
          context.fillStyle = 'rgba(14, 26, 36, 0.92)'
          context.beginPath(); context.roundRect(4, 4, 248, 56, 12); context.fill()
          context.fillStyle = '#a9eaff'; context.font = 'bold 30px Segoe UI, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'
          context.fillText(`${(constraint.value ?? length).toFixed(2)} mm`, 128, 32)
          const texture = new THREE.CanvasTexture(canvas)
          const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }))
          const midpoint = frame.origin.clone().addScaledVector(frame.uAxis, (a[0] + b[0]) / 2).addScaledVector(frame.vAxis, (a[1] + b[1]) / 2).addScaledVector(frame.normal, 0.055)
          label.position.copy(midpoint)
          label.scale.set(Math.max(0.85, Math.min(2.3, length * 0.65)), 0.22, 1)
          label.renderOrder = 15
          viewer.sketch.add(label)
        }
      }
    }
    return () => {
      viewer.sketch.traverse((object) => {
        if (object instanceof THREE.Line || object instanceof THREE.Mesh) {
          object.geometry.dispose()
          const material = object.material
          if (Array.isArray(material)) material.forEach((item) => item.dispose())
          else material.dispose()
        } else if (object instanceof THREE.Sprite) {
          object.material.map?.dispose()
          object.material.dispose()
        }
      })
      viewer.sketch.clear()
    }
  }, [activeArbitraryPlane, constructionMode, parts, pendingSketchPoints, polygonSides, selectedSketchEntityId, selectedSketchId, sketchConstraints, sketchCursorPoint, sketchEntities, sketchPlane, sketchStage, sketchType, sketches])

  useEffect(() => {
    if (sketchStage !== 'drawing') return
    const host = viewportRef.current
    const viewer = viewerRef.current
    if (!host || !viewer) return
    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()
    const frame = sketchPlaneFrame(sketchPlane, activeArbitraryPlane ?? undefined)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(frame.normal, frame.origin)
    const getLocalPoint = (event: PointerEvent): [number, number] | null => {
      const rect = host.getBoundingClientRect()
      mouse.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(mouse, viewer.camera)
      const world = raycaster.ray.intersectPlane(plane, new THREE.Vector3())
      return world ? [Number(world.clone().sub(frame.origin).dot(frame.uAxis).toFixed(3)), Number(world.clone().sub(frame.origin).dot(frame.vAxis).toFixed(3))] : null
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      const localPoint = getLocalPoint(event)
      if (!localPoint) return
      event.preventDefault()
      const snappedPoint = snapSketchPoint(localPoint, event.shiftKey)
      if (sketchType === 'dimension') addDimensionPoint(localPoint)
      else if (sketchType === 'trim') trimSketchAt(localPoint)
      else if (sketchType === 'offset') {
        const candidate = sketchEntities.map((entity) => ({ entity, distance: sketchEntityDistance(entity, localPoint) })).filter((item) => item.distance <= 0.35).sort((a, b) => a.distance - b.distance)[0]?.entity
        setSelectedSketchEntityId(candidate?.id ?? null)
        if (!candidate) notify('Click a sketch entity to select it for offset')
      }
      else if (sketchType === 'select') {
        const candidate = sketchEntities
          .map((entity) => ({ entity, distance: sketchEntityDistance(entity, localPoint) }))
          .filter((item) => item.distance <= 0.35)
          .sort((a, b) => a.distance - b.distance)[0]?.entity
        if (event.shiftKey && selectedSketchEntityId && candidate && candidate.id !== selectedSketchEntityId) {
          setRelatedSketchEntityId(candidate.id)
          return
        }
        setSelectedSketchEntityId(candidate?.id ?? null)
        setRelatedSketchEntityId(null)
        if (!candidate) return
        const start = localPoint
        const pointerId = event.pointerId
        const handlePointerUp = (upEvent: PointerEvent) => {
          if (upEvent.pointerId !== pointerId) return
          window.removeEventListener('pointerup', handlePointerUp)
          const end = getLocalPoint(upEvent)
          if (!end) return
          const delta: [number, number] = [end[0] - start[0], end[1] - start[1]]
          if (Math.hypot(...delta) < 0.02) return
          const moved = sketchEntities.map((entity) => entity.id === candidate.id ? {
            ...entity,
            points: entity.points.map(([x, y]): [number, number] => [x + delta[0], y + delta[1]]),
          } : entity)
          if (sketchConstraints.length) {
            const result = solveCoupledConstraints(moved, sketchConstraints)
            if (result.diagnostics.converged) setSketchEntities(result.solvedEntities)
            else notify('Move blocked: existing sketch dimensions could not be satisfied')
          } else setSketchEntities(moved)
        }
        window.addEventListener('pointerup', handlePointerUp)
      }
      else addSketchPoint(snappedPoint)
    }
    const handlePointerMove = (event: PointerEvent) => {
      const point = getLocalPoint(event)
      setSketchCursorPoint(point ? snapSketchPoint(point, event.shiftKey) : null)
    }
    host.addEventListener('pointerdown', handlePointerDown)
    host.addEventListener('pointermove', handlePointerMove)
    return () => {
      host.removeEventListener('pointerdown', handlePointerDown)
      host.removeEventListener('pointermove', handlePointerMove)
    }
  }, [activeArbitraryPlane, addDimensionPoint, addSketchPoint, dimensionPointRefs, notify, pendingSketchPoints, selectedSketchEntityId, sketchConstraints, sketchEntities, sketchPlane, sketchSnapEnabled, sketchStage, sketchType, snapSketchPoint, trimSketchAt])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return

    while (viewer.parts.children.length > 0) {
      const child = viewer.parts.children[0]
      viewer.parts.remove(child)
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose()
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose())
        else child.material.dispose()
      }
    }

    const kinematicPos = solveAssemblyJoints(parts, joints, explodedRatio)

    parts.forEach((p) => {
      const k = kinematicPos.get(p.id)
      const partToRender: Part = k ? { ...p, position: k.position, rotation: k.rotation } : p
      const mesh = createPartMesh(partToRender, p.id === selectedId)

      if (sectionAnalysis.enabled) {
        const norm = sectionAnalysis.plane === 'x' ? new THREE.Vector3(1, 0, 0) : sectionAnalysis.plane === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
        if (sectionAnalysis.invert) norm.negate()
        viewer.sectionClippingPlane.set(norm, sectionAnalysis.offset)
        if (mesh.material instanceof THREE.Material) {
          mesh.material.clippingPlanes = [viewer.sectionClippingPlane]
          mesh.material.clipShadows = true
        }
      } else {
        if (mesh.material instanceof THREE.Material) {
          mesh.material.clippingPlanes = []
        }
      }

      viewer.parts.add(mesh)
    })
  }, [explodedRatio, joints, parts, sectionAnalysis, selectedId])

  // ── B-Rep Face-Picking: pointer events on the 3D viewport ──────────────────
  useEffect(() => {
    const host = viewportRef.current
    const viewer = viewerRef.current
    if (!host || !viewer) return
    if (sketchStage !== 'plane-selection') return

    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()

    const toNDC = (e: PointerEvent) => {
      const rect = host.getBoundingClientRect()
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    }

    const handleMove = (e: PointerEvent) => {
      toNDC(e)
      raycaster.setFromCamera(mouse, viewer.camera)
      const hit = raycastPlanarFace(raycaster.ray, parts)

      // Update hover overlay
      if (facePickOverlayRef.current) {
        viewer.scene.remove(facePickOverlayRef.current)
        facePickOverlayRef.current.geometry.dispose()
        ;(facePickOverlayRef.current.material as THREE.Material).dispose()
        facePickOverlayRef.current = null
      }

      if (hit) {
        setHoveredFacePlane(hit.arbitraryPlane)
        // Build a translucent quad at the face
        const bp = hit.face.boundaryPoints
        if (bp && bp.length >= 3) {
          const verts: number[] = []
          const uAx = new THREE.Vector3(...hit.face.uAxis)
          const vAx = new THREE.Vector3(...hit.face.vAxis)
          const orig = new THREE.Vector3(...hit.face.origin)
          const pts2d = bp.map((p) => {
            const r = new THREE.Vector3(...p).sub(orig)
            return [r.dot(uAx), r.dot(vAx)] as [number, number]
          })
          // Triangulate as fan
          for (let i = 1; i < pts2d.length - 1; i++) {
            const a = new THREE.Vector3(...orig.toArray()).addScaledVector(uAx, pts2d[0][0]).addScaledVector(vAx, pts2d[0][1])
            const b = new THREE.Vector3(...orig.toArray()).addScaledVector(uAx, pts2d[i][0]).addScaledVector(vAx, pts2d[i][1])
            const c = new THREE.Vector3(...orig.toArray()).addScaledVector(uAx, pts2d[i + 1][0]).addScaledVector(vAx, pts2d[i + 1][1])
            verts.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
          }
          const geo = new THREE.BufferGeometry()
          geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
          const mat = new THREE.MeshBasicMaterial({ color: '#4fc3f7', transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false })
          const overlay = new THREE.Mesh(geo, mat)
          overlay.position.addScaledVector(new THREE.Vector3(...hit.face.normal), 0.003)
          viewer.scene.add(overlay)
          facePickOverlayRef.current = overlay
        }
      } else {
        setHoveredFacePlane(null)
      }
    }

    const handleClick = (e: PointerEvent) => {
      toNDC(e)
      raycaster.setFromCamera(mouse, viewer.camera)
      const hit = raycastPlanarFace(raycaster.ray, parts)
      if (hit) {
        setActiveArbitraryPlane(hit.arbitraryPlane)
        setHoveredFacePlane(null)
        // Remove hover overlay
        if (facePickOverlayRef.current) {
          viewer.scene.remove(facePickOverlayRef.current)
          facePickOverlayRef.current.geometry.dispose()
          ;(facePickOverlayRef.current.material as THREE.Material).dispose()
          facePickOverlayRef.current = null
        }
        setSketchStage('drawing')
        notify(`📐 Sketch plane locked to: ${hit.arbitraryPlane.name}`)
      }
    }

    host.addEventListener('pointermove', handleMove)
    host.addEventListener('pointerup', handleClick)
    return () => {
      host.removeEventListener('pointermove', handleMove)
      host.removeEventListener('pointerup', handleClick)
      // Clean up overlay on unmount
      if (facePickOverlayRef.current) {
        viewer.scene.remove(facePickOverlayRef.current)
        facePickOverlayRef.current.geometry.dispose()
        ;(facePickOverlayRef.current.material as THREE.Material).dispose()
        facePickOverlayRef.current = null
      }
    }
  }, [notify, parts, sketchStage])

  const activeMetrics = useMemo(() => {
    if (!selectedPart) return null
    const dummy = createPartMesh(selectedPart, false)
    const metrics = computeGeometryMetrics(dummy.geometry, getMaterial(selectedPart.materialId).density)
    dummy.geometry.dispose()
    return metrics
  }, [selectedPart])

  const currentWorkspace = workspaceCatalog.find(({ id }) => id === activeWorkspace) ?? workspaceCatalog[0]

  return (
    <main className="cad-app">
      {/* Top Application Bar */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Cuboid size={20} strokeWidth={2.2} />
          </div>
          <span>
            Best<span className="brand-accent">Cad</span>
          </span>
          <span className="brand-separator" />
          <button className="workspace-picker">
            <span className="workspace-dot" /> Personal Engineering Hub <ChevronDown size={13} />
          </button>
        </div>

        <div className="doc-heading">
          {renaming ? (
            <input
              autoFocus
              value={documentName}
              onChange={(e) => setDocumentName(e.target.value)}
              onBlur={() => setRenaming(false)}
              onKeyDown={(e) => e.key === 'Enter' && setRenaming(false)}
            />
          ) : (
            <button className="document-title" onClick={() => setRenaming(true)}>
              {documentName} <ChevronDown size={13} />
            </button>
          )}
          <span className="save-status">
            <span className={`status-dot ${savedAt === 'Unsaved changes' ? 'unsaved' : ''}`} />
            {savedAt}
          </span>
        </div>

        <div className="top-actions">
          <input
            ref={documentInputRef}
            type="file"
            accept=".json,.bestcad.json,application/json"
            hidden
            onChange={(event) => {
              void importDocumentFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <button
            className="subtle-button"
            title="Toggle Perspective / Orthographic View"
            onClick={toggleCameraProjection}
          >
            <Camera size={15} /> {cameraProjection === 'perspective' ? 'Persp' : 'Ortho'}
          </button>

          <button
            className={`subtle-button ${sectionAnalysis.enabled ? 'active' : ''}`}
            title="Section Clipping Plane"
            onClick={() => setSectionAnalysis((s) => ({ ...s, enabled: !s.enabled }))}
          >
            <Scissors size={15} /> Section
          </button>

          <button
            className={`subtle-button ${inspectionActive ? 'active' : ''}`}
            title="Inspect & Measure Distance / Mass"
            onClick={() => setInspectionActive((v) => !v)}
          >
            <Ruler size={15} /> Measure
          </button>

          <span className="action-divider" />
          <button className="icon-button" title="Undo (Ctrl+Z)" disabled={!past.length} onClick={undo}>
            <Undo2 size={16} />
          </button>
          <button className="icon-button" title="Redo" disabled={!future.length} onClick={redo}>
            <Redo2 size={16} />
          </button>
          <span className="action-divider" />

          <button className="subtle-button" onClick={saveDocument}>
            <Save size={15} /> Save
          </button>
          <button className="subtle-button" title="Open a BestCad JSON document (Ctrl+O)" onClick={() => documentInputRef.current?.click()}>
            <FolderOpen size={15} /> Open
          </button>
          <button className="subtle-button" title="Download a portable BestCad document (Ctrl+Shift+S)" onClick={exportDocumentFile}>
            <Download size={15} /> Save file
          </button>

          <div style={{ position: 'relative' }}>
            <button className="primary-button" onClick={() => setExportDropdownOpen((o) => !o)}>
              <ArrowDownToLine size={15} /> Export <ChevronDown size={12} />
            </button>
            {exportDropdownOpen && (
              <div className="export-dropdown">
                <button className="export-item-btn" onClick={exportSTEPFile}>
                  <span>STEP AP214 (faceted)</span>
                  <span>.stp</span>
                </button>
                <button className="export-item-btn" onClick={exportBinarySTL}>
                  <span>Binary STL (3D Print)</span>
                  <span>.stl</span>
                </button>
                <button className="export-item-btn" onClick={exportOBJ}>
                  <span>Wavefront OBJ</span>
                  <span>.obj</span>
                </button>
                <button className="export-item-btn" onClick={exportGLTF}>
                  <span>glTF 2.0 Scene</span>
                  <span>.gltf</span>
                </button>
                <button className="export-item-btn" onClick={exportDrawingSVG}>
                  <span>Engineering 2D Drawing</span>
                  <span>.svg</span>
                </button>
                <button className="export-item-btn" onClick={exportAssemblyBOM}>
                  <span>Bill of Materials (BOM)</span>
                  <span>.csv</span>
                </button>
              </div>
            )}
          </div>
          <button className="avatar" title="User">SK</button>
        </div>
      </header>

      {/* Workspace Ribbon Switcher */}
      <div className="commandbar">
        <div className="fusion-workspaces">
          <div className="workspace-switcher" ref={workspaceSwitcherRef}>
            <button
              className="fusion-workspace-label"
              aria-expanded={workspaceMenuOpen}
              onClick={() => setWorkspaceMenuOpen((o) => !o)}
            >
              <currentWorkspace.icon size={14} /> {currentWorkspace.label} <ChevronDown size={12} />
            </button>
            {workspaceMenuOpen && (
              <div className="workspace-menu">
                {workspaceCatalog.map(({ id, label, icon: Icon, description, status }) => (
                  <button
                    key={id}
                    className={`workspace-menu-item ${activeWorkspace === id ? 'selected' : ''}`}
                    onClick={() => {
                      setActiveWorkspace(id)
                      setWorkspaceMenuOpen(false)
                    }}
                  >
                    <Icon size={16} />
                    <span className="workspace-menu-copy">
                      <strong>{label}</strong>
                      <small>{description}</small>
                    </span>
                    <span className="workspace-status">{status}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="fusion-workspace-divider" />
          <div className="workspace-categories">
            {currentWorkspace.categories.map((cat, i) => (
              <span key={cat} className={`workspace-category ${i === 0 ? 'active' : ''}`}>
                {cat}
              </span>
            ))}
          </div>
        </div>

        <div className="command-actions">
          <button className="command-button" onClick={() => startSketch('rectangle')}>
            <Grid2X2 size={14} /> Create sketch
          </button>
          <button className="command-button" onClick={() => addPart('box')}>
            <Plus size={14} /> Add Part
          </button>
        </div>
      </div>

      {/* Solid Modeling Ribbon Toolbar */}
      {activeWorkspace === 'design' && sketchStage === 'idle' && (
        <div className="solid-ribbon">
          <div className="solid-ribbon-tab">
            <Cuboid size={14} />
            <strong>Solid</strong>
          </div>
          <span className="solid-ribbon-divider" />
          <div className="solid-ribbon-tools">
            <button onClick={() => setShowExtrudeDialog(true)}>
              <Move3D size={16} />
              <span>Extrude</span>
            </button>
            <button onClick={() => openSolidCommand('revolve')}>
              <Rotate3D size={16} />
              <span>Revolve</span>
            </button>
            <button onClick={() => openSolidCommand('loft')} disabled={!selectedSketch} title="Create a solid between two finished sketch profiles">
              <Layers3 size={16} />
              <span>Loft</span>
            </button>
            <button onClick={() => openSolidCommand('sweep')} disabled={!selectedSketch} title="Sweep a closed sketch profile along an open line or spline">
              <Move3D size={16} />
              <span>Sweep</span>
            </button>
            <span className="solid-ribbon-divider" />
            <button onClick={() => openSolidCommand('fillet')}>
              <Circle size={16} />
              <span>Fillet</span>
            </button>
            <button onClick={() => openSolidCommand('chamfer')}>
              <Square size={16} />
              <span>Chamfer</span>
            </button>
            <button onClick={() => openSolidCommand('shell')}>
              <Box size={16} />
              <span>Shell</span>
            </button>
            <button onClick={() => openSolidCommand('hole')}>
              <CirclePlus size={16} />
              <span>Hole</span>
            </button>
            <span className="solid-ribbon-divider" />
            <button onClick={() => openSolidCommand('pattern')}>
              <Grid2X2 size={16} />
              <span>Linear Pattern</span>
            </button>
            <button onClick={() => openSolidCommand('circular-pattern')}>
              <Rotate3D size={16} />
              <span>Circular Pattern</span>
            </button>
            <button onClick={() => openSolidCommand('combine')}>
              <Cuboid size={16} />
              <span>Combine</span>
            </button>
          </div>
        </div>
      )}

      {/* ── Plane Selection HUD ─────────────────────────────────────────── */}
      {activeWorkspace === 'design' && sketchStage === 'plane-selection' && (
        <div className="solid-ribbon" style={{ background: '#1a2535', borderBottom: '1px solid #2d6fa8' }}>
          <div className="solid-ribbon-tab" style={{ color: '#4fc3f7', borderColor: '#4fc3f7' }}>
            <SlidersHorizontal size={14} />
            <strong>Select Sketch Plane</strong>
          </div>
          <span className="solid-ribbon-divider" />
          <div className="solid-ribbon-tools">
            <button onClick={() => pickStandardPlane('top')} style={{ color: '#a5d6fb' }}>
              <Layers3 size={15} /><span>Top (XZ)</span>
            </button>
            <button onClick={() => pickStandardPlane('front')} style={{ color: '#a5d6fb' }}>
              <Layers3 size={15} /><span>Front (XY)</span>
            </button>
            <button onClick={() => pickStandardPlane('right')} style={{ color: '#a5d6fb' }}>
              <Layers3 size={15} /><span>Right (YZ)</span>
            </button>
            <span className="solid-ribbon-divider" />
            <span style={{ fontSize: 11, color: hoveredFacePlane ? '#4fc3f7' : '#6b7a8d', padding: '0 8px' }}>
              {hoveredFacePlane ? `🎯 ${hoveredFacePlane.name}` : '⬆ Hover a part face to pick an arbitrary plane'}
            </span>
          </div>
          <div className="solid-ribbon-selection">
            {activeArbitraryPlane ? `✅ ${activeArbitraryPlane.name}` : 'No plane selected'}
          </div>
          <button
            className="subtle-button"
            style={{ marginLeft: 'auto', fontSize: 11 }}
            onClick={() => { setSketchStage('idle'); setActiveArbitraryPlane(null); setHoveredFacePlane(null) }}
          >
            <X size={13} /> Cancel
          </button>
        </div>
      )}

      {/* Sketch editing tools */}
      {activeWorkspace === 'design' && sketchStage === 'drawing' && (
        <div className="solid-ribbon" style={{ background: '#1b2a1b', borderBottom: '1px solid #3a7a3a' }}>
          <div className="solid-ribbon-tab" style={{ color: '#7ec87e', borderColor: '#5aad5a' }}>
            <Ruler size={14} />
            <strong>Sketch</strong>
          </div>
          <span className="solid-ribbon-divider" />

          <div className="solid-ribbon-tools">
            <span style={{ fontSize: 10, color: '#9ab99a' }}>DRAW:</span>
            {(['select', 'line', 'polyline', 'spline', 'rectangle', 'circle', 'ellipse', 'polygon', 'slot', 'arc', 'trim', 'offset', 'dimension'] as SketchTool[]).map((tool) => (
              <button key={tool} onClick={() => chooseSketchTool(tool)} style={{ color: sketchType === tool ? '#8be2a5' : '#c1cad5', borderBottom: sketchType === tool ? '2px solid #70c887' : '2px solid transparent' }}>
                {tool === 'rectangle' || tool === 'polygon' || tool === 'slot' ? <Square size={14} /> : tool === 'circle' || tool === 'ellipse' ? <Circle size={14} /> : tool === 'line' || tool === 'polyline' || tool === 'spline' ? <Ruler size={14} /> : tool === 'arc' ? <Rotate3D size={14} /> : tool === 'trim' ? <Scissors size={14} /> : tool === 'offset' ? <Copy size={14} /> : tool === 'select' ? <Move3D size={14} /> : <Search size={14} />}
                <span>{tool[0].toUpperCase() + tool.slice(1)}</span>
              </button>
            ))}
            {sketchType === 'polygon' && <label style={{ fontSize: 10 }}>Sides <input aria-label="Polygon side count" type="number" min="3" max="64" step="1" value={polygonSides} onChange={(event) => setPolygonSides(Math.max(3, Math.min(64, Math.floor(Number(event.target.value) || 3))))} style={{ width: 46 }} /></label>}
            {sketchType === 'offset' && <><input aria-label="Offset distance in millimeters" type="number" step="0.1" value={offsetDistance} onChange={(event) => setOffsetDistance(Number(event.target.value))} style={{ width: 70 }} /><button className="subtle-button" onClick={applySketchOffset} disabled={!selectedSketchEntityId}>Apply offset</button></>}
            {sketchType === 'select' && selectedSketchEntityId && <>
              <button className="subtle-button" onClick={() => mirrorSelectedSketch('x')}>Mirror X</button>
              <button className="subtle-button" onClick={() => mirrorSelectedSketch('y')}>Mirror Y</button>
              <input aria-label="Sketch pattern instance count" type="number" min="2" max="50" value={sketchPatternCount} onChange={(event) => setSketchPatternCount(Math.max(2, Math.min(50, Math.floor(Number(event.target.value) || 2))))} style={{ width: 48 }} />
              <input aria-label="Sketch pattern spacing in millimeters" type="number" min="0.01" step="0.1" value={sketchPatternSpacing} onChange={(event) => setSketchPatternSpacing(Number(event.target.value))} style={{ width: 62 }} />
              <button className="subtle-button" onClick={() => patternSelectedSketch('x')}>Pattern X</button>
              <button className="subtle-button" onClick={() => patternSelectedSketch('y')}>Pattern Y</button>
            </>}
            <button className="subtle-button" onClick={toggleSelectedConstruction} disabled={Boolean(selectedSketchEntityId && sketchEntities.find((entity) => entity.id === selectedSketchEntityId)?.isProjected)} title={selectedSketchEntityId ? 'Toggle construction on the selected entity' : 'Draw new entities as construction geometry'}>
              {selectedSketchEntityId ? (sketchEntities.find((entity) => entity.id === selectedSketchEntityId)?.isProjected ? 'Projected ref' : sketchEntities.find((entity) => entity.id === selectedSketchEntityId)?.isConstruction ? 'Make profile' : 'Make construction') : `Construction: ${constructionMode ? 'on' : 'off'}`}
            </button>
            <button className="subtle-button" onClick={projectVisibleSketchEdges} title="Project straight edges from visible solids as reference geometry">Project edges</button>
            {selectedSketchEntityId && sketchEntities.find((entity) => entity.id === selectedSketchEntityId)?.type === 'line' && <>
              <button className="subtle-button" onClick={() => toggleSelectedLineRelation('horizontal')}>Horizontal</button>
              <button className="subtle-button" onClick={() => toggleSelectedLineRelation('vertical')}>Vertical</button>
            </>}
            {relatedSketchEntityId && <>
              <span style={{ fontSize: 10, color: '#9ab99a' }}>2 entities selected</span>
              {selectedSketchEntityId && sketchEntities.find((entity) => entity.id === selectedSketchEntityId)?.type === 'line' && sketchEntities.find((entity) => entity.id === relatedSketchEntityId)?.type === 'line' && <>
                <button className="subtle-button" onClick={() => toggleSelectedPairRelation('parallel')}>Parallel</button>
                <button className="subtle-button" onClick={() => toggleSelectedPairRelation('perpendicular')}>Perpendicular</button>
                <button className="subtle-button" onClick={() => toggleSelectedPairRelation('equal_length')}>Equal</button>
                <button className="subtle-button" onClick={() => toggleSelectedPairRelation('point_on_line')}>Endpoint on line</button>
              </>}
              {selectedSketchEntityId && ['circle', 'arc', 'ellipse'].includes(sketchEntities.find((entity) => entity.id === selectedSketchEntityId)?.type ?? '') && ['circle', 'arc', 'ellipse'].includes(sketchEntities.find((entity) => entity.id === relatedSketchEntityId)?.type ?? '') && <button className="subtle-button" onClick={() => toggleSelectedPairRelation('concentric')}>Concentric</button>}
              <button className="subtle-button" onClick={() => setRelatedSketchEntityId(null)}>Clear pair</button>
            </>}
            {selectedSketchEntityId && <button className="subtle-button" onClick={toggleSelectedFix}>{sketchConstraints.some((constraint) => constraint.type === 'fixed' && constraint.entityIds[0] === selectedSketchEntityId) ? 'Unfix' : 'Fix'}</button>}
            <button className="subtle-button" onClick={() => setSketchSnapEnabled((enabled) => !enabled)} title="Snap to 0.5 mm grid and nearby sketch points">
              {sketchSnapEnabled ? 'Snap 0.5 mm: on' : 'Snap: off'}
            </button>
            <span style={{ fontSize: 10, color: '#8b9b8b', padding: '0 6px' }}>{sketchType === 'select' ? 'Click to select/drag · Shift-click a second line for relations' : sketchType === 'line' ? 'Click two endpoints' : sketchType === 'polyline' ? 'Click points · click start to close · Enter to finish' : sketchType === 'spline' ? 'Click control points · Enter to finish (3+ points)' : sketchType === 'arc' ? 'Click center, start, end' : sketchType === 'circle' ? 'Click center, then radius' : sketchType === 'ellipse' ? 'Click center, major axis, minor axis' : sketchType === 'polygon' ? 'Click center, then radius' : sketchType === 'slot' ? 'Click end centers, then slot radius' : sketchType === 'trim' ? 'Click an open line segment to trim at intersection' : sketchType === 'offset' ? 'Select a curve, set distance, apply' : sketchType === 'dimension' ? 'Click rectangle edges for width/height, or click lines and circles for dimensions' : 'Click two corners'}{!['select', 'dimension', 'trim', 'offset'].includes(sketchType) ? ' · Shift bypasses snap' : ''}</span>
            {sketchType === 'select' && selectedSketchEntityId && <button className="subtle-button" onClick={deleteSelectedSketchEntity}><Trash2 size={13} /> Delete entity</button>}
            {sketchType === 'dimension' && <>
                <select aria-label="Sketch dimension type" value={dimensionMode} onChange={(event) => { setDimensionMode(event.target.value as typeof dimensionMode); setDimensionPointRefs([]) }}>
                  <option value="distance">Length / radius</option>
                  <option value="angle">Angle</option>
                  <option value="width">Rectangle width</option>
                  <option value="height">Rectangle height</option>
                </select>
                {dimensionPointRefs.length === (dimensionMode === 'width' || dimensionMode === 'height' ? 1 : 2) && <>
                  <input aria-label={dimensionMode === 'angle' ? 'Angle dimension in degrees' : `${dimensionMode === 'width' || dimensionMode === 'height' ? dimensionMode : 'Length'} dimension in millimeters`} type="number" min={dimensionMode === 'angle' ? -180 : 0.01} max={dimensionMode === 'angle' ? 180 : undefined} step="0.1" value={dimensionValue} onChange={(event) => setDimensionValue(Number(event.target.value))} style={{ width: 76 }} />
                  <button className="subtle-button" onClick={applySketchDimension}>{dimensionMode === 'angle' ? 'Apply °' : 'Apply mm'}</button>
                </>}
            </>}
            {sketchDiagnostics && <span title="Estimated sketch constraint status" style={{ fontSize: 10, color: sketchDiagnostics.status === 'fully_defined' ? '#83e0a2' : sketchDiagnostics.status === 'over_defined' || sketchDiagnostics.status === 'inconsistent' ? '#ff9b86' : '#9ab99a' }}>{sketchDiagnostics.status.replace('_', ' ')} · {sketchDiagnostics.dof} DOF</span>}
            {sketchEntities.some((entity) => entity.isBrokenProjection) && <span title="Some projected references no longer match a source edge" style={{ fontSize: 10, color: '#ff6573' }}>{sketchEntities.filter((entity) => entity.isBrokenProjection).length} broken reference(s)</span>}
            {constraintMessage && <span style={{ fontSize: 10, color: '#9ab99a' }}>{constraintMessage}</span>}
            <button className="subtle-button" onClick={cancelSketch}><X size={13} /> Cancel</button>
            <button className="primary-button" onClick={finishSketch}><Save size={13} /> Finish Sketch</button>
          </div>
          <span className="solid-ribbon-divider" />

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, paddingRight: 10 }}>
            <span style={{ fontSize: 11, color: '#8b9b8b' }}>{sketchEntities.length} entities</span>
            <span style={{ fontSize: 10, color: '#5a7a5a' }}>
              {activeArbitraryPlane ? `📐 ${activeArbitraryPlane.name}` : `📐 ${activeProfilePlane.toUpperCase()} plane`}
            </span>
          </div>
        </div>
      )}

      {/* Main Work Area */}
      <div className="work-area">
        {/* Left Browser Panel */}
        {treeOpen && (
          <aside className="left-panel">
            <div className="panel-heading">
              <div className="panel-title">
                <Layers3 size={15} /> Feature Browser
              </div>
              <button className="small-icon-button" onClick={() => setTreeOpen(false)}>
                <PanelLeftClose size={15} />
              </button>
            </div>
            <div className="tree-document">
              <ChevronDown size={13} />
              <Cuboid size={15} />
              <span>{documentName}</span>
            </div>
            <div className="tree-search">
              <Search size={14} />
              <input placeholder="Filter components..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>

            <div className="tree-section-label">
              <span>COMPONENTS ({parts.length})</span>
              <button onClick={() => addPart('box')}>
                <Plus size={14} />
              </button>
            </div>
            <div className="part-list">
              {parts
                .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
                .map((p) => (
                  <div
                    key={p.id}
                    className={`part-row ${selectedId === p.id ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedId(p.id)
                      setSelectedSketchId(null)
                    }}
                  >
                    <span className="part-type">{p.kind[0].toUpperCase()}</span>
                    <span className="part-name">{p.name}</span>
                    <button
                      className="visibility-button"
                      onClick={(e) => {
                        e.stopPropagation()
                        commitParts(parts.map((pt) => (pt.id === p.id ? { ...pt, visible: !pt.visible } : pt)))
                      }}
                    >
                      {p.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>
                  </div>
                ))}
            </div>

            <div className="tree-section-label feature-label">
              <span>SKETCHES ({sketches.length})</span>
              <button onClick={() => startSketch('rectangle')}>
                <Plus size={14} />
              </button>
            </div>
            {sketches.map((sk) => (
              <div
                key={sk.id}
                className={`feature-row feature-selectable ${selectedSketchId === sk.id ? 'selected' : ''}`}
                onClick={() => {
                  editSketch(sk)
                }}
              >
                <span className="feature-icon sketch-icon">
                  <Grid2X2 size={13} />
                </span>
                <span style={{ flex: 1 }}>
                  {sk.name} ({sk.plane})
                </span>
                <button
                  className="visibility-button"
                  title="Delete sketch"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteSelectedSketch(sk.id)
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </aside>
        )}

        {/* Central 3D Canvas Viewport */}
        <section className="center-workspace" style={{ position: 'relative' }}>
          <div className="viewport" ref={viewportRef}>
            <div className="viewport-top-left">
              <span className="view-label">
                <span className="view-dot" /> {activeWorkspace.toUpperCase()} WORKSPACE
              </span>
              <span className="viewport-separator" />
              <span>Unit: Millimeter (mm) · Material Density Enabled</span>
            </div>

            {sectionAnalysis.enabled && (
              <div className="section-analysis-bar">
                <span>
                  <Scissors size={14} /> Section Cut Plane:
                </span>
                <select
                  value={sectionAnalysis.plane}
                  onChange={(e) => setSectionAnalysis((s) => ({ ...s, plane: e.target.value as 'x' | 'y' | 'z' }))}
                  style={{ background: '#1c2026', color: '#ffad48', border: '1px solid #485260', borderRadius: 4, padding: '2px 6px' }}
                >
                  <option value="x">YZ Plane (X-Axis)</option>
                  <option value="y">XZ Plane (Y-Axis)</option>
                  <option value="z">XY Plane (Z-Axis)</option>
                </select>
                <input
                  type="range"
                  min="-10"
                  max="10"
                  step="0.1"
                  value={sectionAnalysis.offset}
                  onChange={(e) => setSectionAnalysis((s) => ({ ...s, offset: Number(e.target.value) }))}
                />
                <button
                  className="subtle-button"
                  onClick={() => setSectionAnalysis((s) => ({ ...s, invert: !s.invert }))}
                >
                  Invert
                </button>
                <button
                  className="small-icon-button"
                  onClick={() => setSectionAnalysis((s) => ({ ...s, enabled: false }))}
                >
                  <X size={14} />
                </button>
              </div>
            )}

            {inspectionActive && (
              <div className="inspection-modal">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong>
                    <Ruler size={15} /> Physical Properties & Measurements
                  </strong>
                  <button className="small-icon-button" onClick={() => setInspectionActive(false)}>
                    <X size={14} />
                  </button>
                </div>
                {activeMetrics && selectedPart ? (
                  <>
                    <div style={{ color: '#ffad48', fontSize: 12, fontWeight: 'bold' }}>
                      Selected: {selectedPart.name} ({getMaterial(selectedPart.materialId).name})
                    </div>
                    <div className="inspection-stat-grid">
                      <div className="inspection-stat-box">
                        <span>Volume</span>
                        <span>{activeMetrics.volumeCm3.toFixed(2)} cm³</span>
                      </div>
                      <div className="inspection-stat-box">
                        <span>Mass (Weight)</span>
                        <span>{activeMetrics.massGrams.toFixed(2)} g</span>
                      </div>
                      <div className="inspection-stat-box">
                        <span>Surface Area</span>
                        <span>{activeMetrics.surfaceAreaMm2.toFixed(1)} mm²</span>
                      </div>
                      <div className="inspection-stat-box">
                        <span>Center of Gravity</span>
                        <span>
                          [{activeMetrics.centerOfMass.map((c) => c.toFixed(1)).join(', ')}]
                        </span>
                      </div>
                    </div>
                  </>
                ) : (
                  <p style={{ margin: 0, color: '#9ba2ad' }}>Click any component to inspect exact volume, weight, and center of gravity.</p>
                )}
              </div>
            )}

            {activeWorkspace === 'simulation' && (
              <div className="simulation-hud">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong>
                    <Flame size={15} color="#ff7373" /> Static Stress FEA
                  </strong>
                  <button className="primary-button" style={{ padding: '3px 8px', fontSize: 10 }} onClick={runFEASimulation}>
                    Solve FEA
                  </button>
                </div>
                <div>Force Load: {simulationSetup.loadForceN} N (Downward)</div>
                <div>Component: {selectedPart?.name || 'Base Part'}</div>
                <div className="simulation-gradient-bar" />
                <div className="simulation-legend-labels">
                  <span>Min: {simulationSetup.minStressMpa} MPa</span>
                  <span>Max: {simulationSetup.maxStressMpa} MPa</span>
                </div>
                {simulationSetup.status === 'solved' && (
                  <div
                    className={`fos-badge ${
                      simulationSetup.factorOfSafety > 1.5
                        ? 'safe'
                        : simulationSetup.factorOfSafety > 1.0
                        ? 'warning'
                        : 'danger'
                    }`}
                  >
                    <span>Factor of Safety (FOS): {simulationSetup.factorOfSafety}</span>
                  </div>
                )}
              </div>
            )}

            {activeWorkspace === 'manufacture' && (
              <div className="cam-workspace-layout">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong>
                    <Wrench size={15} /> 2.5D CAM Setup
                  </strong>
                  <button className="primary-button" style={{ padding: '4px 8px', fontSize: 10 }} onClick={calculateCAM}>
                    Generate Toolpaths
                  </button>
                </div>
                <label>
                  Machining Strategy:
                  <select
                    value={camSetup.selectedStrategy}
                    onChange={(e) => setCAMSetup((c) => ({ ...c, selectedStrategy: e.target.value as any }))}
                    style={{ background: '#1c2026', color: '#ffad48', border: '1px solid #485260', borderRadius: 4, width: '100%', padding: '4px' }}
                  >
                    <option value="facing">Face Milling (Zigzag Raster)</option>
                    <option value="pocket">Adaptive Pocketing (Inward)</option>
                    <option value="contour">Contour Profile (Outer Boundary)</option>
                  </select>
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <label style={{ flex: 1 }}>
                    Tool Dia (mm):
                    <input
                      type="number"
                      value={camSetup.toolDiameterMm}
                      onChange={(e) => setCAMSetup((c) => ({ ...c, toolDiameterMm: Number(e.target.value) }))}
                      style={{ background: '#1c2026', color: '#fff', border: '1px solid #485260', borderRadius: 4, width: '100%', padding: '4px' }}
                    />
                  </label>
                  <label style={{ flex: 1 }}>
                    Spindle (RPM):
                    <input
                      type="number"
                      value={camSetup.spindleRpm}
                      onChange={(e) => setCAMSetup((c) => ({ ...c, spindleRpm: Number(e.target.value) }))}
                      style={{ background: '#1c2026', color: '#fff', border: '1px solid #485260', borderRadius: 4, width: '100%', padding: '4px' }}
                    />
                  </label>
                </div>
                <strong>G-Code Program (ISO Standard):</strong>
                <div className="gcode-viewer">{camSetup.gcode || '(Click Generate Toolpaths to compile G-Code)'}</div>
              </div>
            )}

            {activeWorkspace === 'assemble' && (
              <div className="assembly-workspace-layout">
                <div className="assembly-card assembly-controls-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong>
                      <Layers3 size={15} /> Kinematic Joints & Mates
                    </strong>
                  </div>
                  <label>
                    Exploded View Slider: {(explodedRatio * 100).toFixed(0)}%
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={explodedRatio}
                      onChange={(e) => setExplodedRatio(Number(e.target.value))}
                      style={{ width: '100%', accentColor: '#ffad48' }}
                    />
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {joints.map((j) => (
                      <div key={j.id} style={{ fontSize: 11, background: '#1c2026', padding: '6px 8px', borderRadius: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#ffad48', fontWeight: 'bold' }}>{j.name}</span>
                          <span style={{ color: '#8891a0' }}>{j.type.toUpperCase()}</span>
                        </div>
                        {j.type !== 'rigid' && (
                          <input
                            type="range"
                            min={j.minLimit}
                            max={j.maxLimit}
                            step="1"
                            value={j.currentValue}
                            onChange={(e) => {
                              const val = Number(e.target.value)
                              setJoints((prev) => prev.map((item) => (item.id === j.id ? { ...item, currentValue: val } : item)))
                            }}
                            style={{ width: '100%', accentColor: '#2878e2', marginTop: 4 }}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="assembly-card assembly-bom-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong>
                      <FileText size={15} /> Live Bill of Materials (BOM)
                    </strong>
                    <button className="subtle-button" onClick={exportAssemblyBOM}>
                      <Download size={13} /> Export CSV
                    </button>
                  </div>
                  <div className="bom-table-container">
                    <table className="bom-table">
                      <thead>
                        <tr>
                          <th>Item</th>
                          <th>Part Name</th>
                          <th>Qty</th>
                          <th>Material</th>
                          <th>Vol (cm³)</th>
                          <th>Mass (g)</th>
                          <th>Dimensions (mm)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {generateBOM(parts).map((item, idx) => (
                          <tr key={item.partId}>
                            <td>{idx + 1}</td>
                            <td style={{ fontWeight: 600 }}>{item.name}</td>
                            <td>{item.quantity}</td>
                            <td>{item.materialName}</td>
                            <td>{item.volumeCm3.toFixed(2)}</td>
                            <td style={{ color: '#ffad48', fontWeight: 600 }}>{item.massGrams.toFixed(1)}</td>
                            <td>{item.dimensionsMm}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {showExtrudeDialog && (
              <div className="extrude-dialog extrude-command-panel">
                <div className="operation-panel-heading">
                  <span>
                    <Move3D size={15} /> Extrude Profile
                  </span>
                  <button onClick={() => setShowExtrudeDialog(false)}>
                    <X size={14} />
                  </button>
                </div>
                <label>
                  Depth (mm):
                  <input
                    type="number"
                    step="0.5"
                    min="0.1"
                    value={extrudeDistance}
                    onChange={(e) => setExtrudeDistance(Number(e.target.value))}
                  />
                </label>
                <label>
                  Direction:
                  <select aria-label="Extrusion direction" value={extrudeMode} onChange={(event) => setExtrudeMode(event.target.value as 'new' | 'symmetric')}>
                    <option value="new">One sided</option>
                    <option value="symmetric">Symmetric about sketch plane</option>
                  </select>
                </label>
                <button className="primary-button" onClick={createExtrusion}>
                  Apply Extrusion
                </button>
              </div>
            )}

            {solidCommand && (
              <div className="extrude-dialog extrude-command-panel">
                <div className="operation-panel-heading">
                  <span>
                    <Cuboid size={15} /> {solidCommand.toUpperCase()}
                  </span>
                  <button onClick={() => setSolidCommand(null)}>
                    <X size={14} />
                  </button>
                </div>
                {solidCommand === 'revolve' && (
                  <>
                    <p style={{ fontSize: 11, color: '#9aa6b2', margin: '0 0 8px' }}>Revolve closed profiles from the selected Front plane sketch around its vertical axis.</p>
                    <label>
                      Angle (degrees):
                      <input type="number" min="1" max="360" step="1" value={operationValue} onChange={(e) => setOperationValue(Number(e.target.value))} />
                    </label>
                  </>
                )}
                {solidCommand === 'loft' && (
                  <>
                    <p style={{ fontSize: 11, color: '#9aa6b2', margin: '0 0 8px' }}>Connects the selected sketch profile to a parallel end section. Each sketch must contain a closed profile.</p>
                    <label>
                      End section sketch:
                      <select aria-label="Loft end section sketch" value={loftTargetSketchId} onChange={(event) => setLoftTargetSketchId(event.target.value)}>
                        {sketches.filter((sketch) => sketch.id !== selectedSketchId && sketch.visible).map((sketch) => <option key={sketch.id} value={sketch.id}>{sketch.name}</option>)}
                      </select>
                    </label>
                  </>
                )}
                {solidCommand === 'sweep' && (
                  <>
                    <p style={{ fontSize: 11, color: '#9aa6b2', margin: '0 0 8px' }}>Carries the selected closed profile along an open line or spline. The path must start at the profile center and normal to its plane.</p>
                    <label>
                      Path sketch:
                      <select aria-label="Sweep path sketch" value={sweepTargetSketchId} onChange={(event) => setSweepTargetSketchId(event.target.value)}>
                        {sketches.filter((sketch) => sketch.id !== selectedSketchId && sketch.visible).map((sketch) => <option key={sketch.id} value={sketch.id}>{sketch.name}</option>)}
                      </select>
                    </label>
                  </>
                )}
                {solidCommand === 'circular-pattern' && (
                  <>
                    <label>
                      Pattern axis:
                      <select value={operationAxis} onChange={(e) => setOperationAxis(e.target.value as 'x' | 'y' | 'z')}>
                        <option value="x">X axis</option><option value="y">Y axis</option><option value="z">Z axis</option>
                      </select>
                    </label>
                    <label>
                      Instance Count:
                      <input
                        type="number"
                        min="2"
                        max="24"
                        value={operationValue}
                        onChange={(e) => setOperationValue(Number(e.target.value))}
                      />
                    </label>
                    <label>
                      Radius (mm):
                      <input
                        type="number"
                        min="1"
                        max="50"
                        step="0.5"
                        value={operationSpacing}
                        onChange={(e) => setOperationSpacing(Number(e.target.value))}
                      />
                    </label>
                  </>
                )}
                {solidCommand === 'pattern' && (
                  <>
                    <label>
                      Pattern direction:
                      <select value={operationAxis} onChange={(e) => setOperationAxis(e.target.value as 'x' | 'y' | 'z')}>
                        <option value="x">X axis</option><option value="y">Y axis</option><option value="z">Z axis</option>
                      </select>
                    </label>
                    <label>
                      Instance Count:
                      <input
                        type="number"
                        min="2"
                        max="20"
                        value={operationValue}
                        onChange={(e) => setOperationValue(Number(e.target.value))}
                      />
                    </label>
                    <label>
                      Spacing (mm):
                      <input
                        type="number"
                        min="0.5"
                        step="0.5"
                        value={operationSpacing}
                        onChange={(e) => setOperationSpacing(Number(e.target.value))}
                      />
                    </label>
                  </>
                )}
                {(solidCommand === 'fillet' || solidCommand === 'chamfer') && (
                  <label>
                    Radius / Size (mm):
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      value={operationValue}
                      onChange={(e) => setOperationValue(Number(e.target.value))}
                    />
                  </label>
                )}
                {(solidCommand === 'hole' || solidCommand === 'shell') && (
                  <>
                    <label>
                      {solidCommand === 'hole' ? 'Hole diameter (mm):' : 'Wall thickness (mm):'}
                      <input
                        type="number"
                        step="0.1"
                        min="0.1"
                        value={operationValue}
                        onChange={(e) => setOperationValue(Number(e.target.value))}
                      />
                    </label>
                    {solidCommand === 'hole' && (
                      <label>
                        Hole axis:
                        <select value={operationAxis} onChange={(e) => setOperationAxis(e.target.value as 'x' | 'y' | 'z')}>
                          <option value="x">X axis</option>
                          <option value="y">Y axis</option>
                          <option value="z">Z axis</option>
                        </select>
                      </label>
                    )}
                  </>
                )}
                {solidCommand === 'combine' && (
                  <>
                    <label>
                      Mode:
                      <select
                        value={combineMode}
                        onChange={(e) => setCombineMode(e.target.value as any)}
                        style={{ background: '#1c2026', color: '#ffad48', border: '1px solid #485260', borderRadius: 4, width: '100%', padding: '4px' }}
                      >
                        <option value="join">Join (Boolean Add)</option>
                        <option value="cut">Cut (Boolean Subtract)</option>
                        <option value="intersect">Intersect</option>
                      </select>
                    </label>
                    <label>
                      Tool Body:
                      <select
                        value={operationToolId}
                        onChange={(e) => setOperationToolId(e.target.value)}
                        style={{ background: '#1c2026', color: '#ffad48', border: '1px solid #485260', borderRadius: 4, width: '100%', padding: '4px' }}
                      >
                        {parts
                          .filter((p) => p.id !== selectedId)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  </>
                )}
                <button className="primary-button" onClick={runSolidCommand}>
                  Execute Feature
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Right Properties & Materials Panel */}
        {propertiesOpen && (
          <aside className="right-panel">
            <div className="panel-heading">
              <div className="panel-title">
                <Settings2 size={15} /> Properties & Engineering
              </div>
              <button className="small-icon-button" onClick={() => setPropertiesOpen(false)}>
                <PanelRightClose size={15} />
              </button>
            </div>

            {selectedPart ? (
              <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="selection-card">
                  <div className="selection-icon">
                    <Cuboid size={16} />
                  </div>
                  <div className="selection-info">
                    <strong>{selectedPart.name}</strong>
                    <span>{selectedPart.kind.toUpperCase()} Component</span>
                  </div>
                </div>

                <div className="property-section">
                  <div className="property-heading">
                    <span>ENGINEERING MATERIAL</span>
                  </div>
                  <div className="material-palette-grid">
                    {(Object.keys(MATERIAL_PRESETS) as MaterialPresetId[]).map((mId) => {
                      const mat = MATERIAL_PRESETS[mId]
                      return (
                        <button
                          key={mId}
                          className={`material-card-btn ${selectedPart.materialId === mId ? 'active' : ''}`}
                          onClick={() => {
                            commitParts(parts.map((p) => (p.id === selectedPart.id ? { ...p, materialId: mId, color: mat.color } : p)))
                            notify(`Material set to ${mat.name}`)
                          }}
                        >
                          <span className="material-preview-dot" style={{ background: mat.color }} />
                          <span>{mat.name.split(' ')[0]}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="property-section">
                  <div className="property-heading">
                    <span>BOUNDS & SIZE (MM)</span>
                  </div>
                  <div className="dimension-grid">
                    <label className="dimension-field">
                      <span>Width</span>
                      <div>
                        <input
                          type="number"
                          step="0.1"
                          value={Number(selectedPart.size[0].toFixed(2))}
                          onChange={(e) => {
                            const val = Number(e.target.value)
                            updateSelectedPartSize(0, val)
                          }}
                        />
                      </div>
                    </label>
                    <label className="dimension-field">
                      <span>Height</span>
                      <div>
                        <input
                          type="number"
                          step="0.1"
                          value={Number(selectedPart.size[1].toFixed(2))}
                          onChange={(e) => {
                            const val = Number(e.target.value)
                            updateSelectedPartSize(1, val)
                          }}
                        />
                      </div>
                    </label>
                    <label className="dimension-field">
                      <span>Depth</span>
                      <div>
                        <input
                          type="number"
                          step="0.1"
                          value={Number(selectedPart.size[2].toFixed(2))}
                          onChange={(e) => {
                            const val = Number(e.target.value)
                            updateSelectedPartSize(2, val)
                          }}
                        />
                      </div>
                    </label>
                  </div>
                </div>

                <div className="selection-actions">
                  <button onClick={duplicateSelected}>
                    <Copy size={14} /> Duplicate
                  </button>
                  <button className="delete-action" onClick={deleteSelected}>
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              </div>
            ) : (
              <div className="no-selection">
                <p>Select any part in the viewport or browser to edit dimensions, appearance, and physical properties.</p>
              </div>
            )}
          </aside>
        )}
      </div>

      {/* FULL-SCREEN WORKSPACE OVERLAYS FOR DRAWINGS AND AUTOMATION */}

      {activeWorkspace === 'manage' && (
        <div className="workspace-fullscreen-overlay">
          <div className="drawing-sheet-toolbar">
            <strong><ShieldCheck size={16} /> Document Versions</strong>
            <div className="toolbar-actions">
              <button className="subtle-button" onClick={() => setActiveWorkspace('design')}>Return to 3D View</button>
              <button className="primary-button" onClick={createVersionSnapshot}><Save size={14} /> Create Snapshot</button>
            </div>
          </div>
          <div style={{ padding: 24, overflow: 'auto', display: 'grid', gap: 10, alignContent: 'start' }}>
            {versions.length === 0 && <p>No snapshots yet. Create one to save a named restore point.</p>}
            {[...versions].reverse().map((version) => (
              <article key={version.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: 16, border: '1px solid #39424e', borderRadius: 8, background: '#1a2028' }}>
                <div>
                  <strong>{version.label}</strong>
                  <div style={{ marginTop: 4, color: '#9aa6b2', fontSize: 12 }}>{version.description} · {new Date(version.timestamp).toLocaleString()}</div>
                </div>
                <button className="subtle-button" onClick={() => restoreVersion(version)}>Restore</button>
              </article>
            ))}
          </div>
        </div>
      )}

      {/* 1. Drawings 2D Sheet Workspace Overlay */}
      {activeWorkspace === 'drawings' && (
        <div className="workspace-fullscreen-overlay">
          <div className="drawing-sheet-toolbar">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Grid2X2 size={16} color="#ffad48" />
              <strong>Engineering 2D Drawing Workspace (ISO / ANSI 3rd Angle)</strong>
            </div>
            <div className="toolbar-actions">
              <button className="subtle-button" onClick={() => setActiveWorkspace('design')}>
                Return to 3D View
              </button>
              <button className="subtle-button" onClick={() => window.print()}>
                <Printer size={14} /> Print Drawing
              </button>
              <button className="primary-button" onClick={exportDrawingSVG}>
                <Download size={14} /> Download SVG
              </button>
            </div>
          </div>
          <div className="drawing-sheet-scroll">
            <div
              className="drawing-svg-frame"
              dangerouslySetInnerHTML={{ __html: generateEngineeringDrawingSVG(parts, documentName) }}
            />
          </div>
        </div>
      )}

      {/* 2. FeatureScript / Automation Workspace Overlay */}
      {activeWorkspace === 'automate' && (
        <div className="automate-workspace-layout">
          <div className="automate-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Code2 size={16} color="#ffad48" />
              <strong>BestCad FeatureScript & Automation IDE</strong>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="subtle-button" onClick={() => setActiveWorkspace('design')}>
                Return to 3D View
              </button>
              <button className="primary-button" onClick={runAutomationScript}>
                <Play size={14} /> Run Script
              </button>
            </div>
          </div>
          <div className="automate-body">
            <aside className="automate-sidebar">
              <span style={{ fontSize: 10, fontWeight: 'bold', color: '#8891a0' }}>SCRIPT TEMPLATES</span>
              {SCRIPT_TEMPLATES.map((tmpl) => (
                <button
                  key={tmpl.id}
                  className="script-template-card"
                  onClick={() => {
                    setActiveScript(tmpl.code)
                    notify(`Loaded template: ${tmpl.name}`)
                  }}
                >
                  <strong>{tmpl.name}</strong>
                  <small>{tmpl.description}</small>
                </button>
              ))}
            </aside>
            <div className="automate-editor-pane">
              <textarea
                className="automate-textarea"
                value={activeScript}
                onChange={(e) => setActiveScript(e.target.value)}
                spellCheck={false}
              />
              <div className="automate-console">{scriptLog}</div>
            </div>
          </div>
        </div>
      )}

      {/* Footer Status */}
      <footer className="app-footer">
        <span>
          <span className="green-dot" /> BestCad 3D Workspace
        </span>
        <span className="footer-spacer" />
        <button onClick={captureRenderSnapshot}>
          <Camera size={13} /> Screenshot
        </button>
        <span className="footer-divider" />
        <button onClick={() => notify('Units: Millimeters (mm)')}>Units: mm</button>
      </footer>

      {toast && <div className="toast">{toast}</div>}
    </main>
  )
}

export default App
