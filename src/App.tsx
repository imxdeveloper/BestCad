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
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
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
import { raycastPlanarFace } from './cad/brep'

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

function planeLocalExtrusionProfile(points: [number, number][]): [number, number][] {
  return points.map(([u, v]): [number, number] => [u, v])
}

function arcPoints(center: [number, number], start: [number, number], end: [number, number]): [number, number][] {
  const radius = Math.hypot(start[0] - center[0], start[1] - center[1])
  let startAngle = Math.atan2(start[1] - center[1], start[0] - center[0])
  let endAngle = Math.atan2(end[1] - center[1], end[0] - center[0])
  while (endAngle <= startAngle) endAngle += Math.PI * 2
  if (endAngle - startAngle > Math.PI * 2 - 0.01) endAngle = startAngle + 0.01
  return Array.from({ length: 33 }, (_, index): [number, number] => {
    const angle = startAngle + ((endAngle - startAngle) * index) / 32
    return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius]
  })
}

function sketchEntityPoints(entity: SketchEntity): [number, number][] {
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

function createChamferedBoxGeometry(size: Part['size'], chamfer: number): THREE.BufferGeometry {
  const [width, height, depth] = size
  const shape = new THREE.Shape()
  shape.moveTo(-width / 2, -depth / 2)
  shape.lineTo(width / 2, -depth / 2)
  shape.lineTo(width / 2, depth / 2)
  shape.lineTo(-width / 2, depth / 2)
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: chamfer,
    bevelThickness: chamfer,
  })
  geometry.translate(0, 0, -height / 2)
  geometry.rotateX(-Math.PI / 2)
  return geometry
}

function createTreatedCylinderGeometry(part: Part, treatment: EdgeTreatment): THREE.BufferGeometry {
  const radius = Math.min(part.size[0], part.size[2]) / 2
  const height = part.size[1]
  const edgeSize = Math.min(treatment.size, radius * 0.45, height * 0.45)
  const points: THREE.Vector2[] = [new THREE.Vector2(0, -height / 2)]
  if (treatment.type === 'fillet') {
    points.push(new THREE.Vector2(radius - edgeSize, -height / 2))
    for (let index = 0; index <= 6; index += 1) {
      const angle = -Math.PI / 2 + (Math.PI / 2 * index) / 6
      points.push(new THREE.Vector2(radius - edgeSize + Math.cos(angle) * edgeSize, -height / 2 + edgeSize + Math.sin(angle) * edgeSize))
    }
    points.push(new THREE.Vector2(radius, height / 2 - edgeSize))
    for (let index = 0; index <= 6; index += 1) {
      const angle = (Math.PI / 2 * index) / 6
      points.push(new THREE.Vector2(radius - edgeSize + Math.cos(angle) * edgeSize, height / 2 - edgeSize + Math.sin(angle) * edgeSize))
    }
  } else {
    points.push(
      new THREE.Vector2(radius - edgeSize, -height / 2),
      new THREE.Vector2(radius, -height / 2 + edgeSize),
      new THREE.Vector2(radius, height / 2 - edgeSize),
      new THREE.Vector2(radius - edgeSize, height / 2),
    )
  }
  points.push(new THREE.Vector2(0, height / 2))
  return new THREE.LatheGeometry(points, 48)
}

function createPartMesh(part: Part, selected: boolean, customGeo?: THREE.BufferGeometry) {
  let geometry: THREE.BufferGeometry = customGeo ?? new THREE.BufferGeometry()
  if (!customGeo) {
    if (part.meshData) {
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.meshData.positions, 3))
      geometry.setIndex(part.meshData.indices)
      geometry.computeVertexNormals()
    } else if (part.kind === 'revolution' && part.profile) {
      const axis = part.revolveAxis ?? 'vertical'
      const points = part.profile.map(([u, v]) => new THREE.Vector2(Math.abs(axis === 'vertical' ? u : v), axis === 'vertical' ? v : u))
      const angleRad = THREE.MathUtils.degToRad(part.revolveAngle ?? 360)
      geometry = new THREE.LatheGeometry(points, 64, 0, angleRad)
      if (axis === 'vertical') {
        if (part.profilePlane === 'right') geometry.rotateY(Math.PI / 2)
        else if (part.profilePlane === 'top') geometry.rotateX(Math.PI / 2)
      } else {
        const horizontalAxis = part.profilePlane === 'right' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(1, 0, 0)
        geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), horizontalAxis))
      }
    } else if (part.kind === 'extrusion' && part.profile) {
      const shape = new THREE.Shape()
      const plane = part.profilePlane ?? 'top'
      const profile = planeLocalExtrusionProfile(part.profile)
      profile.forEach(([x, y], index) => {
        if (index === 0) shape.moveTo(x, y)
        else shape.lineTo(x, y)
      })
      shape.closePath()
      const treatment = part.edgeTreatment
      geometry = new THREE.ExtrudeGeometry(shape, {
        depth: part.arbitraryPlane ? part.size[2] : part.size[sketchPlaneAxes(plane).normalAxis],
        bevelEnabled: Boolean(treatment),
        bevelSegments: treatment?.type === 'fillet' ? 4 : 1,
        bevelSize: treatment?.size ?? 0,
        bevelThickness: treatment?.size ?? 0,
      })
      if (part.arbitraryPlane) {
        const { uAxis, vAxis, normal } = part.arbitraryPlane
        const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...uAxis), new THREE.Vector3(...vAxis), new THREE.Vector3(...normal))
        geometry.applyMatrix4(basis)
      }
    } else if (part.kind === 'box' && part.edgeTreatment?.type === 'fillet') {
      const radius = Math.min(part.edgeTreatment.size, Math.min(...part.size) * 0.45)
      geometry = new RoundedBoxGeometry(...part.size, 4, radius)
    } else if (part.kind === 'box' && part.edgeTreatment?.type === 'chamfer') {
      const chamfer = Math.min(part.edgeTreatment.size, Math.min(...part.size) * 0.45)
      geometry = createChamferedBoxGeometry(part.size, chamfer)
    } else if (part.kind === 'cylinder' && part.edgeTreatment) {
      geometry = createTreatedCylinderGeometry(part, part.edgeTreatment)
    } else if (part.kind === 'cylinder') {
      geometry = new THREE.CylinderGeometry(part.size[0] / 2, part.size[2] / 2, part.size[1], 48)
    } else if (part.kind === 'sphere') {
      geometry = new THREE.SphereGeometry(0.5, 40, 28)
      geometry.scale(...part.size)
    } else {
      geometry = new THREE.BoxGeometry(...part.size)
    }
  }

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
  mesh.position.set(...part.position)
  if (part.rotation) {
    mesh.rotation.set(...part.rotation)
  }
  if (part.kind === 'extrusion') {
    const plane = part.profilePlane ?? 'top'
    if (part.arbitraryPlane) {
      // Geometry is already oriented in the arbitrary sketch frame.
    } else if (plane === 'top') mesh.rotation.x = -Math.PI / 2
    else if (plane === 'right') mesh.rotation.y = -Math.PI / 2
  }
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
  const viewerRef = useRef<Viewer | null>(null)
  const editingSketchRef = useRef<SketchFeature | null>(null)
  const sketchReturnProjectionRef = useRef<'perspective' | 'orthographic'>('perspective')

  const [parts, setParts] = useState<Part[]>(() => {
    try {
      const saved = localStorage.getItem('clonecad-document')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed.parts) && parsed.parts.length > 0) return parsed.parts
      }
    } catch {}
    return initialParts
  })

  const [sketches, setSketches] = useState<SketchFeature[]>(() => {
    try {
      const saved = localStorage.getItem('clonecad-document')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed.sketches)) return parsed.sketches
      }
    } catch {}
    return []
  })

  const [joints, setJoints] = useState<AssemblyJoint[]>(() => {
    try {
      const saved = localStorage.getItem('clonecad-document')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed.joints)) return parsed.joints
      }
    } catch {}
    return initialJoints
  })

  const [selectedId, setSelectedId] = useState<string | null>('jaw')
  const [selectedSketchId, setSelectedSketchId] = useState<string | null>(null)
  const [past, setPast] = useState<ModelSnapshot[]>([])
  const [future, setFuture] = useState<ModelSnapshot[]>([])
  const [sketchEntities, setSketchEntities] = useState<SketchEntity[]>([])
  const [pendingSketchPoints, setPendingSketchPoints] = useState<[number, number][]>([])
  const [sketchType, setSketchType] = useState<SketchTool>('rectangle')
  const [sketchPlane, setSketchPlane] = useState<SketchPlane>('top')
  const [sketchStage, setSketchStage] = useState<SketchStage>('idle')
  const [extrudeDistance, setExtrudeDistance] = useState(4)
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
  const [documentName, setDocumentName] = useState('Desk clamp')
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
  const [versions] = useState<VersionSnapshot[]>(() => [
    { id: 'v1', label: 'V1.0 - Baseline clamp assembly', timestamp: '12:00:00', description: 'Initial geometry setup with 6 parts', parts: initialParts, sketches: [] },
  ])

  // ── B-Rep Face Picking & Arbitrary Sketch Plane State ──────────────────────
  const [hoveredFacePlane, setHoveredFacePlane] = useState<ArbitraryPlane | null>(null)
  const [activeArbitraryPlane, setActiveArbitraryPlane] = useState<ArbitraryPlane | null>(null)
  const facePickOverlayRef = useRef<THREE.Mesh | null>(null)

  const selectedPart = parts.find((part) => part.id === selectedId) ?? null
  const selectedSketch = sketches.find((sketch) => sketch.id === selectedSketchId) ?? null
  const profileEntities = sketchStage === 'drawing' ? sketchEntities : selectedSketch?.entities ?? sketchEntities
  const activeProfilePlane = sketchStage === 'drawing' ? sketchPlane : selectedSketch?.plane ?? sketchPlane

  const notify = useCallback((message: string) => {
    setToast(message)
  }, [])

  const commitModel = useCallback((next: ModelSnapshot) => {
    setPast((items) => [...items.slice(-29), { parts, sketches, joints }])
    setFuture([])
    setParts(next.parts)
    setSketches(next.sketches)
    if (next.joints) setJoints(next.joints)
    setSavedAt('Unsaved changes')
  }, [joints, parts, sketches])

  const commitParts = useCallback((next: Part[]) => {
    commitModel({ parts: next, sketches, joints })
  }, [commitModel, joints, sketches])

  const saveDocument = useCallback(() => {
    try {
      localStorage.setItem('clonecad-document', JSON.stringify({ documentName, parts, sketches, selectedId, joints, versions }))
      setSavedAt('Saved just now')
      notify('Document saved to this browser')
    } catch {
      notify('Could not save this document')
    }
  }, [documentName, joints, notify, parts, selectedId, sketches, versions])

  const undo = useCallback(() => {
    if (past.length === 0) return
    const previous = past[past.length - 1]
    setFuture((items) => [{ parts, sketches, joints }, ...items])
    setParts(previous.parts)
    setSketches(previous.sketches)
    if (previous.joints) setJoints(previous.joints)
    if (selectedId && !previous.parts.some((part) => part.id === selectedId)) setSelectedId(null)
    if (selectedSketchId && !previous.sketches.some((sketch) => sketch.id === selectedSketchId)) setSelectedSketchId(null)
    setPast((items) => items.slice(0, -1))
    setSavedAt('Unsaved changes')
  }, [joints, past, parts, selectedId, selectedSketchId, sketches])

  const redo = useCallback(() => {
    if (future.length === 0) return
    const next = future[0]
    setPast((items) => [...items, { parts, sketches, joints }])
    setParts(next.parts)
    setSketches(next.sketches)
    if (next.joints) setJoints(next.joints)
    if (selectedId && !next.parts.some((part) => part.id === selectedId)) setSelectedId(null)
    if (selectedSketchId && !next.sketches.some((sketch) => sketch.id === selectedSketchId)) setSelectedSketchId(null)
    setFuture((items) => items.slice(1))
    setSavedAt('Unsaved changes')
  }, [future, joints, parts, selectedId, selectedSketchId, sketches])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      const editingText = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      if (editingText) return
      const command = event.ctrlKey || event.metaKey
      if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (command && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
      } else if (command && event.key.toLowerCase() === 's') {
        event.preventDefault()
        saveDocument()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [redo, saveDocument, undo])

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
    const closedProfiles = profileEntities.filter((entity) => entity.closed && entity.type !== 'arc')
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
  }, [activeArbitraryPlane, activeProfilePlane, commitParts, extrudeDistance, notify, parts, profileEntities, selectedSketch, selectedSketchId, sketchStage, sketchType])

  function deleteSelectedSketch(sketchId: string) {
    const dependentParts = parts.filter((part) => part.sketchId === sketchId)
    commitModel({
      parts: dependentParts.length ? parts.filter((part) => part.sketchId !== sketchId) : parts,
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
      visible: previous?.visible ?? true,
    }
    const nextSketches = previous ? sketches.map((item) => item.id === previous.id ? feature : item) : [...sketches, feature]
    let nextParts = parts
    if (previous) {
      const regenerated = new Map<string, Part>()
      for (const part of parts.filter((item) => item.sketchId === previous.id && item.sketchEntityId)) {
        const source = feature.entities.find((entity) => entity.id === part.sketchEntityId)
        if (!source || !source.closed || source.type === 'arc') {
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
        regenerated.set(part.id, {
          ...part,
          profile,
          profileType: source.type === 'circle' ? 'circle' : source.type === 'rectangle' ? 'rectangle' : 'polygon',
          profilePlane: feature.plane,
          arbitraryPlane: feature.arbitraryPlane,
          position: feature.arbitraryPlane ? [...feature.arbitraryPlane.origin] : feature.plane === 'top' ? [0, SKETCH_PLANE_Y, 0] : [0, 0, 0],
          size,
        })
      }
      if (regenerated.size) nextParts = parts.map((part) => regenerated.get(part.id) ?? part)
    }
    commitModel({ parts: nextParts, sketches: nextSketches, joints })
    setSelectedSketchId(feature.id)
    setSelectedId(null)
    editingSketchRef.current = null
    setPendingSketchPoints([])
    setSketchEntities([])
    setActiveArbitraryPlane(null)
    setSketchStage('idle')
    setCameraProjection(sketchReturnProjectionRef.current)
    notify(`${feature.name} saved · ready for 3D features`)
  }

  function cancelSketch() {
    const returnProjection = sketchReturnProjectionRef.current
    editingSketchRef.current = null
    setPendingSketchPoints([])
    setSketchEntities([])
    setActiveArbitraryPlane(null)
    setHoveredFacePlane(null)
    setSketchStage('idle')
    setCameraProjection(returnProjection)
  }

  function editSketch(sketch: SketchFeature) {
    sketchReturnProjectionRef.current = cameraProjection
    editingSketchRef.current = sketch
    setSketchPlane(sketch.plane)
    setActiveArbitraryPlane(sketch.arbitraryPlane ?? null)
    setSketchEntities(sketch.entities)
    setPendingSketchPoints([])
    setSelectedSketchId(sketch.id)
    setSelectedId(null)
    setCameraProjection('orthographic')
    setSketchStage('drawing')
  }

  function chooseSketchTool(tool: SketchTool) {
    setSketchType(tool)
    setPendingSketchPoints([])
  }

  function addSketchPoint(point: [number, number]) {
    if (sketchType === 'select' || sketchType === 'trim' || sketchType === 'offset' || sketchType === 'dimension') return
    const required = sketchType === 'arc' ? 3 : 2
    const next = [...pendingSketchPoints, point]
    if (next.length < required) { setPendingSketchPoints(next); return }
    const type = sketchType === 'line' ? 'line' : sketchType === 'circle' ? 'circle' : sketchType === 'arc' ? 'arc' : 'rectangle'
    const closed = type === 'circle' || type === 'rectangle'
    const entity: SketchEntity = { id: createFeatureId('entity'), type, points: next, closed }
    setSketchEntities((items) => [...items, entity])
    setPendingSketchPoints([])
  }

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

  function openSolidCommand(command: SolidCommand) {
    if (command === 'revolve') {
      notify('Revolve is not implemented yet; use Extrude for sketch-based solid features')
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
    if (!selectedPart || operationValue < 2) return
    const count = operationValue
    const radius = operationSpacing || 3.0
    const copies: Part[] = []

    for (let i = 1; i < count; i++) {
      const angle = (i * Math.PI * 2) / count
      const cosA = Math.cos(angle)
      const sinA = Math.sin(angle)
      const newPos: Part['position'] = [
        selectedPart.position[0] + (operationAxis === 'y' ? cosA * radius : 0),
        selectedPart.position[1] + (operationAxis === 'x' ? cosA * radius : 0),
        selectedPart.position[2] + (operationAxis === 'y' ? sinA * radius : sinA * radius),
      ]
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
    notify(`Created circular pattern with ${count} instances`)
  }

  async function runSolidCommand() {
    if (!solidCommand) return
    if (solidCommand === 'circular-pattern') {
      runCircularPattern()
      return
    }
    if (solidCommand === 'pattern') {
      if (!selectedPart || operationValue < 2) return
      const axis = operationAxis === 'x' ? 0 : operationAxis === 'y' ? 1 : 2
      const copies = Array.from({ length: operationValue - 1 }, (_, index): Part => ({
        ...selectedPart,
        id: `${selectedPart.id}-pattern-${Date.now()}-${index}`,
        name: `${selectedPart.name} pattern ${index + 2}`,
        position: selectedPart.position.map((c, i) => (i === axis ? c + operationSpacing * (index + 1) : c)) as Part['position'],
        operation: `Pattern ${operationValue} × ${operationSpacing} mm`,
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
    exportToSTEP(parts, documentName)
    setExportDropdownOpen(false)
    notify('ISO 10303 STEP exported')
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
    const res = generateCAMToolpaths(parts, camSetup)
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
        const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: sketchStage === 'drawing' ? '#76e7a5' : '#ffad48', depthTest: false }))
        line.renderOrder = 10
        viewer.sketch.add(line)
      })
    })
    return () => {
      viewer.sketch.traverse((object) => {
        if (object instanceof THREE.Line || object instanceof THREE.Mesh) {
          object.geometry.dispose()
          const material = object.material
          if (Array.isArray(material)) material.forEach((item) => item.dispose())
          else material.dispose()
        }
      })
      viewer.sketch.clear()
    }
  }, [activeArbitraryPlane, parts, pendingSketchPoints, selectedSketchId, sketchEntities, sketchPlane, sketchStage, sketches])

  useEffect(() => {
    if (sketchStage !== 'drawing') return
    const host = viewportRef.current
    const viewer = viewerRef.current
    if (!host || !viewer) return
    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()
    const frame = sketchPlaneFrame(sketchPlane, activeArbitraryPlane ?? undefined)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(frame.normal, frame.origin)
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      const rect = host.getBoundingClientRect()
      mouse.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(mouse, viewer.camera)
      const world = raycaster.ray.intersectPlane(plane, new THREE.Vector3())
      if (!world) return
      event.preventDefault()
      addSketchPoint([Number(world.clone().sub(frame.origin).dot(frame.uAxis).toFixed(3)), Number(world.clone().sub(frame.origin).dot(frame.vAxis).toFixed(3))])
    }
    host.addEventListener('pointerdown', handlePointerDown)
    return () => host.removeEventListener('pointerdown', handlePointerDown)
  }, [activeArbitraryPlane, pendingSketchPoints, sketchPlane, sketchStage, sketchType])

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
  }, [sketchStage, parts])

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
            clone<span className="brand-accent">cad</span>
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

          <div style={{ position: 'relative' }}>
            <button className="primary-button" onClick={() => setExportDropdownOpen((o) => !o)}>
              <ArrowDownToLine size={15} /> Export <ChevronDown size={12} />
            </button>
            {exportDropdownOpen && (
              <div className="export-dropdown">
                <button className="export-item-btn" onClick={exportSTEPFile}>
                  <span>ISO 10303 STEP</span>
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
            {(['select', 'line', 'rectangle', 'circle', 'arc'] as SketchTool[]).map((tool) => (
              <button key={tool} onClick={() => chooseSketchTool(tool)} style={{ color: sketchType === tool ? '#8be2a5' : '#c1cad5', borderBottom: sketchType === tool ? '2px solid #70c887' : '2px solid transparent' }}>
                {tool === 'rectangle' ? <Square size={14} /> : tool === 'circle' ? <Circle size={14} /> : tool === 'line' ? <Ruler size={14} /> : tool === 'arc' ? <Rotate3D size={14} /> : <Search size={14} />}
                <span>{tool[0].toUpperCase() + tool.slice(1)}</span>
              </button>
            ))}
            <span style={{ fontSize: 10, color: '#8b9b8b', padding: '0 6px' }}>{sketchType === 'select' ? 'Select a drawing tool' : sketchType === 'line' ? 'Click two endpoints' : sketchType === 'arc' ? 'Click center, start, end' : sketchType === 'circle' ? 'Click center, then radius' : 'Click two corners'}</span>
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
                {solidCommand === 'circular-pattern' && (
                  <>
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
                            if (val > 0) {
                              const s: Part['size'] = [val, selectedPart.size[1], selectedPart.size[2]]
                              commitParts(parts.map((p) => (p.id === selectedPart.id ? { ...p, size: s } : p)))
                            }
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
                            if (val > 0) {
                              const s: Part['size'] = [selectedPart.size[0], val, selectedPart.size[2]]
                              commitParts(parts.map((p) => (p.id === selectedPart.id ? { ...p, size: s } : p)))
                            }
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
                            if (val > 0) {
                              const s: Part['size'] = [selectedPart.size[0], selectedPart.size[1], val]
                              commitParts(parts.map((p) => (p.id === selectedPart.id ? { ...p, size: s } : p)))
                            }
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
