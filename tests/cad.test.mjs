import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { solveCoupledConstraints } from '../src/cad/constraintSolver.ts'
import { offsetOpenPath, offsetPolygon } from '../src/cad/sketcher.ts'
import { solveAssemblyJoints, generateBOM } from '../src/cad/assembly.ts'
import { generateCAMToolpaths } from '../src/cad/cam.ts'
import { solveStaticStressFEA } from '../src/cad/simulation.ts'
import { computeGeometryMetrics, calculateDistance } from '../src/cad/inspection.ts'
import { generateEngineeringDrawingSVG } from '../src/cad/drawing.ts'
import { executeCADScript, SCRIPT_TEMPLATES } from '../src/cad/automate.ts'
import { buildBoxBRep, buildExtrusionBRep, getPartBRep } from '../src/cad/brep.ts'
import { getSketchProjectionFrame, projectPartEdgeToSketch, syncProjectedSketches } from '../src/cad/sketchProjection.ts'
import { getExtrusionOrigin } from '../src/cad/extrusion.ts'
import { MATERIAL_PRESETS } from '../src/cad/materials.ts'

function makePart(overrides = {}) {
  return {
    id: 'part-1',
    name: 'Test block',
    kind: 'box',
    size: [10, 20, 30],
    position: [0, 10, 0],
    color: '#8899aa',
    materialId: 'aluminum',
    visible: true,
    ...overrides,
  }
}

test('constraint solver applies a horizontal relation without mutating input', () => {
  const entities = [{ id: 'line', type: 'line', points: [[0, 0], [4, 3]], closed: false }]
  const result = solveCoupledConstraints(entities, [{ id: 'h', type: 'horizontal', entityIds: ['line'] }])

  assert.equal(result.diagnostics.converged, true)
  assert.ok(Math.abs(result.solvedEntities[0].points[0][1] - result.solvedEntities[0].points[1][1]) < 1e-4)
  assert.deepEqual(entities[0].points, [[0, 0], [4, 3]])
})

test('constraint solver enforces a target point distance', () => {
  const entities = [{ id: 'line', type: 'line', points: [[0, 0], [3, 4]], closed: false }]
  const result = solveCoupledConstraints(entities, [{ id: 'd', type: 'distance', entityIds: ['line'], value: 10 }])
  const [a, b] = result.solvedEntities[0].points

  assert.equal(result.diagnostics.converged, true)
  assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - 10) < 0.01)
})

test('constraint solver supports coincident points, fixed points, and target angles', () => {
  const coincident = solveCoupledConstraints([
    { id: 'a', type: 'line', points: [[0, 0], [2, 0]], closed: false },
    { id: 'b', type: 'line', points: [[8, 6], [9, 6]], closed: false },
  ], [{ id: 'coincident', type: 'coincident', entityIds: ['a', 'b'], pointIndices: [1, 0] }])
  const [aEnd] = coincident.solvedEntities[0].points.slice(1)
  const [bStart] = coincident.solvedEntities[1].points
  assert.ok(Math.hypot(aEnd[0] - bStart[0], aEnd[1] - bStart[1]) < 1e-4)

  const fixed = solveCoupledConstraints([
    { id: 'fixed', type: 'line', points: [[4, 7], [5, 7]], closed: false },
  ], [{ id: 'anchor', type: 'fixed', entityIds: ['fixed'], pointIndices: [0], value: 2 }])
  assert.ok(Math.abs(fixed.solvedEntities[0].points[0][0] - 2) < 1e-4)
  assert.ok(Math.abs(fixed.solvedEntities[0].points[0][1] - 7) < 1e-4)

  const angled = solveCoupledConstraints([
    { id: 'horizontal', type: 'line', points: [[0, 0], [5, 0]], closed: false },
    { id: 'rotating', type: 'line', points: [[0, 2], [3, 5]], closed: false },
  ], [{ id: 'right-angle', type: 'angle', entityIds: ['horizontal', 'rotating'], value: 90 }])
  const first = angled.solvedEntities[0].points
  const second = angled.solvedEntities[1].points
  const firstAngle = Math.atan2(first[1][1] - first[0][1], first[1][0] - first[0][0])
  const secondAngle = Math.atan2(second[1][1] - second[0][1], second[1][0] - second[0][0])
  assert.ok(angled.diagnostics.converged)
  assert.ok(Math.abs(Math.atan2(Math.sin(secondAngle - firstAngle - Math.PI / 2), Math.cos(secondAngle - firstAngle - Math.PI / 2))) < 1e-4)
})

test('polygon offset returns finite points and preserves vertex count', () => {
  const result = offsetPolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 1)
  assert.equal(result.length, 4)
  assert.ok(result.flat().every(Number.isFinite))
})

test('polygon offset expands in the same direction for either winding', () => {
  const counterClockwise = offsetPolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 1)
  const clockwise = offsetPolygon([[0, 0], [0, 10], [10, 10], [10, 0]], 1)
  assert.deepEqual(counterClockwise, [[-1, -1], [11, -1], [11, 11], [-1, 11]])
  assert.deepEqual(clockwise, [[-1, -1], [-1, 11], [11, 11], [11, -1]])
})

test('open path offset preserves direction and moves points by the requested normal distance', () => {
  assert.deepEqual(offsetOpenPath([[0, 0], [10, 0]], 2), [[0, 2], [10, 2]])
})

test('projected sketch references follow source edges and report broken references', () => {
  const part = makePart()
  const brep = getPartBRep(part)
  const frame = getSketchProjectionFrame({ plane: 'front' })
  const candidate = brep.edges.map((edge) => ({ edge, geometry: projectPartEdgeToSketch(part, edge.id, frame, brep) }))
    .find((item) => item.geometry?.type === 'line')
  assert.ok(candidate)
  const entity = {
    id: 'projection-1', ...candidate.geometry, isConstruction: true, isProjected: true,
    sourcePartId: part.id, sourceEdgeId: candidate.edge.id,
  }
  const sketch = { id: 'sketch-1', name: 'Front', plane: 'front', entities: [entity], constraints: [] }
  const moved = { ...part, position: [part.position[0] + 3, part.position[1], part.position[2]] }
  const updated = syncProjectedSketches([sketch], [moved])[0].entities[0]
  assert.equal(updated.isBrokenProjection, false)
  assert.ok(updated.points.every((point, index) => Math.abs(point[0] - entity.points[index][0] - 3) < 1e-4))

  const missing = syncProjectedSketches([sketch], [])[0].entities[0]
  assert.equal(missing.isBrokenProjection, true)
  const recovered = syncProjectedSketches([{ ...sketch, entities: [missing] }], [part])[0].entities[0]
  assert.equal(recovered.isBrokenProjection, false)
  assert.deepEqual(recovered.points, entity.points)
})

test('constraint diagnostics use independent degrees of freedom and report redundant relations', () => {
  const entities = [{ id: 'line', type: 'line', points: [[0, 0], [4, 3]], closed: false }]
  const underDefined = solveCoupledConstraints(entities, [{ id: 'h', type: 'horizontal', entityIds: ['line'] }])
  const fullyDefined = solveCoupledConstraints(entities, [
    { id: 'h', type: 'horizontal', entityIds: ['line'] },
    { id: 'd', type: 'distance', entityIds: ['line'], value: 4 },
    { id: 'fixed', type: 'fixed', entityIds: ['line'], pointIndices: [0], value: 0 },
  ])
  const redundant = solveCoupledConstraints(entities, [
    { id: 'h1', type: 'horizontal', entityIds: ['line'] },
    { id: 'h2', type: 'horizontal', entityIds: ['line'] },
  ])
  assert.equal(underDefined.diagnostics.status, 'under_defined')
  assert.equal(underDefined.diagnostics.dof, 3)
  assert.equal(fullyDefined.diagnostics.status, 'fully_defined')
  assert.equal(fullyDefined.diagnostics.dof, 0)
  assert.equal(redundant.diagnostics.status, 'over_defined')
})

test('assembly slider clamps travel and leaves source positions intact', () => {
  const base = makePart({ id: 'base', position: [5, 0, 0] })
  const moving = makePart({ id: 'moving', position: [0, 2, 0] })
  const result = solveAssemblyJoints([base, moving], [{
    id: 'slider', name: 'Slide', type: 'slider', basePartId: 'base', targetPartId: 'moving', axis: 'x',
    currentValue: 50, minLimit: -5, maxLimit: 5,
  }])

  assert.equal(result.get('moving').position[0], 10)
  assert.equal(moving.position[0], 0)
})

test('BOM groups equal box instances and calculates volume and mass', () => {
  const items = generateBOM([makePart(), makePart({ id: 'part-2' })])
  assert.equal(items.length, 1)
  assert.equal(items[0].quantity, 2)
  assert.equal(items[0].volumeCm3, 12)
  assert.ok(items[0].massGrams > 0)
})

test('CAM generation returns finite bounds, non-empty paths, and valid program framing', () => {
  const result = generateCAMToolpaths([makePart()], {
    stockOffsetMm: 2, toolDiameterMm: 4, spindleRpm: 8000, feedRateMmMin: 500,
    selectedStrategy: 'facing', gcode: '', isSimulating: false, simulationProgress: 0,
  })

  assert.ok(result.segments.length > 0)
  assert.ok(Number.isFinite(result.stockBoundingBox.min.x))
  assert.ok(Number.isFinite(result.totalTimeMinutes))
  assert.match(result.gcode, /^%\n/)
  assert.match(result.gcode, /M30 \(End of program\)\n%$/)
})

test('CAM rejects invalid cutting settings and safely handles hidden or empty models', () => {
  const setup = {
    stockOffsetMm: 2, toolDiameterMm: 4, spindleRpm: 8000, feedRateMmMin: 500,
    selectedStrategy: 'facing', gcode: '', isSimulating: false, simulationProgress: 0,
  }
  const empty = generateCAMToolpaths([], setup)
  assert.deepEqual(empty.segments, [])
  assert.equal(empty.totalTimeMinutes, 0)
  assert.ok(Number.isFinite(empty.stockBoundingBox.min.x))
  assert.throws(() => generateCAMToolpaths([makePart()], { ...setup, toolDiameterMm: -1 }), /Tool diameter/)
  assert.throws(() => generateCAMToolpaths([makePart()], { ...setup, feedRateMmMin: 0 }), /Feed rate/)
  assert.throws(() => generateCAMToolpaths([makePart()], { ...setup, toolDiameterMm: 0.001 }), /more than 10000 passes/)
  assert.throws(() => generateCAMToolpaths([makePart({ size: [0, 1, 1] })], setup), /invalid dimensions/)
})

test('CAM pocket and contour strategies generate finite cutting segments', () => {
  for (const selectedStrategy of ['pocket', 'contour']) {
    const result = generateCAMToolpaths([makePart()], {
      stockOffsetMm: 2, toolDiameterMm: 4, spindleRpm: 8000, feedRateMmMin: 500,
      selectedStrategy, gcode: '', isSimulating: false, simulationProgress: 0,
    })
    assert.ok(result.segments.some((segment) => segment.type === 'cut'), selectedStrategy)
    assert.ok(result.segments.flatMap((segment) => segment.points).flat().every(Number.isFinite), selectedStrategy)
  }
})

test('simulation returns finite stress values and a colored mesh', () => {
  const geometry = new THREE.BoxGeometry(10, 20, 30)
  const result = solveStaticStressFEA(makePart(), geometry, {
    fixedPartIds: ['part-1'], loadPartId: 'part-1', loadForceN: 1000, loadDirection: '-y',
    status: 'idle', maxStressMpa: 0, minStressMpa: 0, factorOfSafety: 0, yieldStrengthMpa: 0,
  })

  assert.ok(Number.isFinite(result.maxStressMpa))
  assert.ok(Number.isFinite(result.factorOfSafety))
  assert.equal(result.meshWithStressColors.getAttribute('color').count, geometry.getAttribute('position').count)
  geometry.dispose()
  result.meshWithStressColors.dispose()
})

test('inspection computes a box volume, surface area, and center of mass', () => {
  const geometry = new THREE.BoxGeometry(10, 20, 30)
  const metrics = computeGeometryMetrics(geometry, MATERIAL_PRESETS.aluminum.density)

  assert.ok(Math.abs(metrics.volumeMm3 - 6000) < 1e-6)
  assert.ok(Math.abs(metrics.surfaceAreaMm2 - 2200) < 1e-6)
  assert.ok(metrics.centerOfMass.every((coordinate) => Math.abs(coordinate) < 1e-6))
  assert.equal(calculateDistance([0, 0, 0], [3, 4, 12]), 13)
  geometry.dispose()
})

test('drawing output contains a sheet, title, and view labels', () => {
  const svg = generateEngineeringDrawingSVG([makePart()], 'Bracket')
  assert.match(svg.trimStart(), /^<svg\b/)
  assert.match(svg, /BRACKET/)
  assert.match(svg, /FRONT/)
  assert.match(svg, /TOP/)
  assert.match(svg, /RIGHT/)
})

test('drawing title escapes XML metacharacters', () => {
  const svg = generateEngineeringDrawingSVG([makePart()], '<svg & "gear">')
  assert.match(svg, /TITLE: &lt;SVG &amp; &quot;GEAR&quot;&gt;/)
  assert.doesNotMatch(svg, /TITLE: <SVG/)
})

test('all provided automation templates execute and create parts', () => {
  assert.ok(SCRIPT_TEMPLATES.length > 0)
  for (const template of SCRIPT_TEMPLATES) {
    const created = []
    const result = executeCADScript(template.code, (kind, options) => created.push({ kind, ...options }))
    assert.equal(result.success, true, `${template.name}: ${result.log}`)
    assert.equal(result.partsCreated, created.length)
    assert.ok(created.length > 0, template.name)
  }
})

test('automation reports script errors without throwing into the workspace', () => {
  const result = executeCADScript('throw new Error("bad script")', () => assert.fail('must not create a part'))
  assert.equal(result.success, false)
  assert.match(result.log, /bad script/)
})

test('box B-rep has a closed six-face shell', () => {
  const body = buildBoxBRep(makePart())
  assert.equal(body.faces.length, 6)
  assert.equal(body.loops.length, 6)
  assert.equal(body.vertices.length, 8)
  assert.equal(body.edges.length, 12)
})

test('extrusion B-rep includes vertices, edges, loops, and linked faces', () => {
  const body = buildExtrusionBRep(makePart({
    kind: 'extrusion',
    profile: [[-2, -1], [2, -1], [2, 1], [-2, 1]],
    profilePlane: 'top',
  }))
  const vertexIds = new Set(body.vertices.map((vertex) => vertex.id))
  const edgeIds = new Set(body.edges.map((edge) => edge.id))
  const loopIds = new Set(body.loops.map((loop) => loop.id))

  assert.equal(body.vertices.length, 8)
  assert.equal(body.edges.length, 12)
  assert.equal(body.loops.length, 6)
  assert.equal(body.faces.length, 6)
  assert.ok(body.edges.every((edge) => vertexIds.has(edge.startVertexId) && vertexIds.has(edge.endVertexId)))
  assert.ok(body.loops.every((loop) => loop.edgeIds.length === 4 && loop.edgeIds.every((edgeId) => edgeIds.has(edgeId))))
  assert.ok(body.faces.every((face) => loopIds.has(face.outerLoopId)))
})

test('extrusion B-rep rejects profiles that cannot enclose a solid', () => {
  assert.throws(() => buildExtrusionBRep(makePart({ kind: 'extrusion', profile: [[0, 0], [1, 0]] })), /at least three/)
})

test('symmetric extrusion centers mesh and B-rep depth on the sketch plane', () => {
  const part = makePart({
    kind: 'extrusion', profile: [[0, 0], [4, 0], [4, 3], [0, 3]], profilePlane: 'front',
    extrudeMode: 'symmetric', size: [4, 3, 8], position: [2, 5, 7],
  })
  const body = buildExtrusionBRep(part)
  const bottom = body.vertices.filter((vertex) => vertex.id.includes('_bot_'))
  const top = body.vertices.filter((vertex) => vertex.id.includes('_top_'))
  assert.deepEqual(getExtrusionOrigin(part), [2, 5, 3])
  assert.ok(bottom.every((vertex) => vertex.point[2] === 3))
  assert.ok(top.every((vertex) => vertex.point[2] === 11))
  const oneSided = buildExtrusionBRep({ ...part, extrudeMode: 'new' })
  assert.ok(oneSided.vertices.filter((vertex) => vertex.id.includes('_bot_')).every((vertex) => vertex.point[2] === 7))
})
