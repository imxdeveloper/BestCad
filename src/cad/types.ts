import * as THREE from 'three'

export type Primitive = 'box' | 'cylinder' | 'sphere'
export type PartKind = Primitive | 'extrusion' | 'revolution' | 'custom'
export type StandardPlaneId = 'top' | 'front' | 'right'
export type SketchPlane = StandardPlaneId | string
export type SketchProfile = 'rectangle' | 'circle' | 'polygon'
export type SketchTool = 'select' | 'line' | 'polyline' | 'spline' | 'rectangle' | 'circle' | 'ellipse' | 'polygon' | 'slot' | 'arc' | 'trim' | 'offset' | 'dimension'

export type ArbitraryPlane = {
  id: string
  name: string
  origin: [number, number, number]
  normal: [number, number, number]
  uAxis: [number, number, number]
  vAxis: [number, number, number]
  sourceFaceId?: string
  sourcePartId?: string
}

// B-Rep (Boundary Representation) Data Structures
export type BRepSurfaceType = 'plane' | 'cylinder' | 'sphere' | 'cone' | 'torus'

export type BRepVertex = {
  id: string
  point: [number, number, number]
}

export type BRepEdge = {
  id: string
  startVertexId: string
  endVertexId: string
  curveType: 'line' | 'circle' | 'ellipse'
  radius?: number
  center?: [number, number, number]
}

export type BRepLoop = {
  id: string
  edgeIds: string[]
  isOuter: boolean
}

export type BRepFace = {
  id: string
  surfaceType: BRepSurfaceType
  origin: [number, number, number]
  normal: [number, number, number]
  uAxis: [number, number, number]
  vAxis: [number, number, number]
  radius?: number
  outerLoopId: string
  innerLoopIds: string[]
  area?: number
  boundaryPoints?: [number, number, number][]
}

export type BRepBody = {
  id: string
  partId: string
  vertices: BRepVertex[]
  edges: BRepEdge[]
  loops: BRepLoop[]
  faces: BRepFace[]
}

// Coupled Non-Linear Constraint Solver Types
export type CoupledConstraintType =
  | 'coincident'
  | 'horizontal'
  | 'vertical'
  | 'distance'
  | 'point_on_line'
  | 'parallel'
  | 'perpendicular'
  | 'tangent'
  | 'equal_length'
  | 'concentric'
  | 'fixed'
  | 'angle'

export type NonLinearConstraint = {
  id: string
  type: CoupledConstraintType
  entityIds: string[]
  pointIndices?: [number, number]
  /** Millimeters for distance, degrees for angle, and the X anchor for fixed-point constraints. */
  value?: number
}

export type SolverDiagnostics = {
  status: 'under_defined' | 'fully_defined' | 'over_defined' | 'inconsistent'
  dof: number
  residual: number
  iterations: number
  converged: boolean
}

export type SketchConstraintType = CoupledConstraintType

export type SketchConstraint = NonLinearConstraint

export type SketchEntity = {
  id: string
  type: 'line' | 'rectangle' | 'circle' | 'ellipse' | 'polygon' | 'slot' | 'arc' | 'spline'
  points: [number, number][]
  closed: boolean
  isConstruction?: boolean
  isProjected?: boolean
  isBrokenProjection?: boolean
  sourcePartId?: string
  sourceEdgeId?: string
  radius?: number
  sides?: number
}

export type SketchFeature = {
  id: string
  name: string
  plane: SketchPlane
  arbitraryPlane?: ArbitraryPlane
  entities: SketchEntity[]
  constraints?: SketchConstraint[]
  visible: boolean
}

export type SketchStage = 'idle' | 'plane-selection' | 'drawing' | 'extruding'
export type EdgeTreatment = { type: 'fillet' | 'chamfer'; size: number }
export type MeshData = { positions: number[]; indices: number[]; normals?: number[] }
export type SolidCommand =
  | 'revolve'
  | 'fillet'
  | 'chamfer'
  | 'shell'
  | 'hole'
  | 'pattern'
  | 'circular-pattern'
  | 'mirror'
  | 'combine'
  | 'loft'
  | 'sweep'

export type WorkspaceId =
  | 'design'
  | 'assemble'
  | 'drawings'
  | 'manufacture'
  | 'simulation'
  | 'electronics'
  | 'visualize'
  | 'manage'
  | 'automate'

export type MaterialPresetId =
  | 'steel'
  | 'aluminum'
  | 'titanium'
  | 'brass'
  | 'copper'
  | 'gold'
  | 'carbon_fiber'
  | 'acrylic'
  | 'pom_black'
  | 'abs_orange'

export type MaterialPreset = {
  id: MaterialPresetId
  name: string
  color: string
  metalness: number
  roughness: number
  clearcoat?: number
  density: number // g/cm³
  yieldStrength: number // MPa
  youngsModulus: number // GPa
  description: string
}

export type Part = {
  id: string
  name: string
  kind: PartKind
  size: [number, number, number]
  position: [number, number, number]
  rotation?: [number, number, number]
  color: string
  materialId?: MaterialPresetId
  visible: boolean
  profile?: [number, number][]
  profileType?: SketchProfile
  profilePlane?: SketchPlane
  arbitraryPlane?: ArbitraryPlane
  revolveAxis?: 'horizontal' | 'vertical'
  revolveAngle?: number // 1 to 360 degrees
  extrudeMode?: 'new' | 'symmetric' | 'cut'
  sketchId?: string
  sketchEntityId?: string
  loftSketchIds?: [string, string]
  loftSketchEntityIds?: [string, string]
  edgeTreatment?: EdgeTreatment
  meshData?: MeshData
  brep?: BRepBody
  operation?: string
}

export type JointType = 'revolute' | 'slider' | 'rigid' | 'cylindrical'

export type AssemblyJoint = {
  id: string
  name: string
  type: JointType
  basePartId: string
  targetPartId: string
  axis: 'x' | 'y' | 'z'
  currentValue: number
  minLimit: number
  maxLimit: number
  origin?: [number, number, number]
}

export type AssemblyBOMItem = {
  partId: string
  name: string
  quantity: number
  materialName: string
  volumeCm3: number
  massGrams: number
  dimensionsMm: string
}

export type SimulationSetup = {
  fixedPartIds: string[]
  loadPartId: string
  loadForceN: number
  loadDirection: 'x' | 'y' | 'z' | '-y'
  status: 'idle' | 'solved'
  maxStressMpa: number
  minStressMpa: number
  factorOfSafety: number
  yieldStrengthMpa: number
}

export type CAMToolpathType = 'facing' | 'pocket' | 'contour'

export type CAMSetup = {
  stockOffsetMm: number
  toolDiameterMm: number
  spindleRpm: number
  feedRateMmMin: number
  selectedStrategy: CAMToolpathType
  gcode: string
  isSimulating: boolean
  simulationProgress: number
}

export type SectionAnalysisState = {
  enabled: boolean
  plane: 'x' | 'y' | 'z'
  offset: number
  invert: boolean
}

export type InspectionState = {
  active: boolean
  selectedPartIds: string[]
  distanceBetween?: number
  volumeTotal?: number
  surfaceAreaTotal?: number
  massTotal?: number
  centerOfMass?: [number, number, number]
}

export type ModelSnapshot = {
  parts: Part[]
  sketches: SketchFeature[]
  joints?: AssemblyJoint[]
}

export type VersionSnapshot = {
  id: string
  label: string
  timestamp: string
  description: string
  parts: Part[]
  sketches: SketchFeature[]
  joints?: AssemblyJoint[]
}

export type SavedDocument = {
  documentName: string
  parts: Part[]
  sketches?: SketchFeature[]
  selectedId?: string | null
  joints?: AssemblyJoint[]
  versions?: VersionSnapshot[]
  materialId?: MaterialPresetId
}

export type Viewer = {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
  perspCamera: THREE.PerspectiveCamera
  orthoCamera: THREE.OrthographicCamera
  renderer: THREE.WebGLRenderer
  controls: any
  parts: THREE.Group
  sketch: THREE.Group
  planes: THREE.Group
  toolpathGroup: THREE.Group
  simulationGroup: THREE.Group
  sectionClippingPlane: THREE.Plane
  resizeObserver: ResizeObserver
  frame: number
}
