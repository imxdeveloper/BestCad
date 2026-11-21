import * as THREE from 'three'
import type { Part } from './types'
import { applyPartTransform, createPartGeometry } from './partGeometry'

type TriangleMesh = { positions: [number, number, number][]; indices: number[] }

function triangleMesh(part: Part): TriangleMesh {
  const geometry = createPartGeometry(part)
  try {
    const position = geometry.getAttribute('position')
    const index = geometry.getIndex()
    if (!position || position.count < 3) throw new RangeError(`${part.name} has no exportable triangles`)
    const transform = new THREE.Object3D()
    applyPartTransform(transform, part)
    transform.updateMatrix()
    const vertices: [number, number, number][] = Array.from({ length: position.count }, (_, i) => {
      const point = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(transform.matrix)
      return [point.x, point.y, point.z]
    })
    const indices: number[] = []
    const count = index?.count ?? position.count
    for (let i = 0; i + 2 < count; i += 3) {
      const triangle = [index ? index.getX(i) : i, index ? index.getX(i + 1) : i + 1, index ? index.getX(i + 2) : i + 2]
      if (new THREE.Vector3(...vertices[triangle[1]]).sub(new THREE.Vector3(...vertices[triangle[0]])).cross(new THREE.Vector3(...vertices[triangle[2]]).sub(new THREE.Vector3(...vertices[triangle[0]]))).lengthSq() > 1e-18) indices.push(...triangle)
    }
    if (indices.length < 12) throw new RangeError(`${part.name} has too few triangles to form a solid`)
    const edgeUse = new Map<string, { count: number; orientation: number }>()
    let signedVolume = 0
    const keyFor = (index: number) => vertices[index].map((coordinate) => Number(coordinate.toFixed(7))).join(',')
    for (let offset = 0; offset < indices.length; offset += 3) {
      const triangle = indices.slice(offset, offset + 3)
      const points = triangle.map((index) => new THREE.Vector3(...vertices[index]))
      signedVolume += points[0].dot(new THREE.Vector3().crossVectors(points[1], points[2])) / 6
      for (let edge = 0; edge < 3; edge += 1) {
        const start = keyFor(triangle[edge]), end = keyFor(triangle[(edge + 1) % 3])
        const key = [start, end].sort().join('|')
        const entry = edgeUse.get(key) ?? { count: 0, orientation: 0 }
        entry.count += 1
        entry.orientation += start < end ? 1 : -1
        edgeUse.set(key, entry)
      }
    }
    if ([...edgeUse.values()].some((edge) => edge.count !== 2 || edge.orientation !== 0)) {
      throw new RangeError(`${part.name} mesh is open or inconsistently oriented and cannot be exported as a solid`)
    }
    if (Math.abs(signedVolume) < 1e-9) throw new RangeError(`${part.name} mesh encloses no solid volume`)
    if (signedVolume < 0) {
      for (let offset = 0; offset < indices.length; offset += 3) [indices[offset + 1], indices[offset + 2]] = [indices[offset + 2], indices[offset + 1]]
    }
    return { positions: vertices, indices }
  } finally {
    geometry.dispose()
  }
}

function stepString(value: string): string {
  let output = ''
  let escapedUnicode = ''
  const flushUnicode = () => {
    if (!escapedUnicode) return
    output += `\\X2\\${escapedUnicode}\\X0\\`
    escapedUnicode = ''
  }
  for (const character of value.replace(/[\r\n]/g, ' ')) {
    if (character.codePointAt(0)! > 0x7e) {
      for (let index = 0; index < character.length; index += 1) escapedUnicode += character.charCodeAt(index).toString(16).padStart(4, '0').toUpperCase()
    } else {
      flushUnicode()
      output += character === "'" ? "''" : character
    }
  }
  flushUnicode()
  return output
}
function stepNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError('STEP geometry contains a non-finite coordinate')
  const rounded = value.toFixed(8)
  if (/[eE]/.test(rounded)) throw new RangeError('STEP coordinates exceed the supported numeric range')
  const compact = rounded.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')
  const normalized = compact === '-0' ? '0' : compact
  return normalized.includes('.') ? normalized : `${normalized}.0`
}

/** Serializes visible parts as faceted solids in a STEP Part 21 product shape representation. */
export function createSTEPText(parts: Part[], documentName = 'BestCad_Model', timestamp = new Date().toISOString()): string {
  const visibleParts = parts.filter((part) => part.visible)
  if (!visibleParts.length) throw new RangeError('There are no visible solids to export')
  const lines = [
    'ISO-10303-21;', 'HEADER;',
    "FILE_DESCRIPTION(('BestCad faceted solid model'),'2;1');",
    `FILE_NAME('${stepString(documentName)}.stp','${stepString(timestamp)}',('BestCad User'),('BestCad'),'BestCad','BestCad STEP Exporter','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));", 'ENDSEC;', 'DATA;',
  ]
  let nextEntity = 1
  const emit = (text: string) => {
    const id = `#${nextEntity++}`
    lines.push(`${id} = ${text};`)
    return id
  }

  const lengthUnit = emit('(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))')
  const angleUnit = emit('(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))')
  const solidAngleUnit = emit('(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())')
  const uncertainty = emit("UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.0001)," + lengthUnit + ",'distance_accuracy_value','')")
  const context = emit(`(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${lengthUnit},${angleUnit},${solidAngleUnit})) REPRESENTATION_CONTEXT('',''))`)
  const applicationContext = emit("APPLICATION_CONTEXT('mechanical design')")
  emit(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${applicationContext})`)
  const productContext = emit(`PRODUCT_CONTEXT('',${applicationContext},'mechanical')`)
  const product = emit(`PRODUCT('${stepString(documentName)}','${stepString(documentName)}','',(${productContext}))`)
  const formation = emit(`PRODUCT_DEFINITION_FORMATION('','',${product})`)
  const definitionContext = emit(`PRODUCT_DEFINITION_CONTEXT('part definition',${applicationContext},'design')`)
  const definition = emit(`PRODUCT_DEFINITION('','',${formation},${definitionContext})`)
  const definitionShape = emit(`PRODUCT_DEFINITION_SHAPE('','',${definition})`)

  const breps: string[] = []
  for (const part of visibleParts) {
    const mesh = triangleMesh(part)
    const points = new Map<string, string>()
    const pointKey = (point: [number, number, number]) => point.map((coordinate) => Number(coordinate.toFixed(7))).join(',')
    const getPoint = (point: [number, number, number]) => {
      const key = pointKey(point)
      if (!points.has(key)) points.set(key, emit(`CARTESIAN_POINT('',(${point.map(stepNumber).join(',')}))`))
      return points.get(key)!
    }
    const edgeUse = new Map<string, number>()
    const faceIds: string[] = []
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      const triangle = mesh.indices.slice(offset, offset + 3).map((index) => mesh.positions[index])
      const pointIds = triangle.map(getPoint)
      for (let edge = 0; edge < 3; edge += 1) {
        const key = [pointIds[edge], pointIds[(edge + 1) % 3]].sort().join('|')
        edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1)
      }
      const p0 = new THREE.Vector3(...triangle[0]), p1 = new THREE.Vector3(...triangle[1]), p2 = new THREE.Vector3(...triangle[2])
      const normal = new THREE.Vector3().crossVectors(p1.clone().sub(p0), p2.clone().sub(p0)).normalize()
      const xAxis = p1.clone().sub(p0).normalize()
      const normalId = emit(`DIRECTION('',(${normal.toArray().map(stepNumber).join(',')}))`)
      const xAxisId = emit(`DIRECTION('',(${xAxis.toArray().map(stepNumber).join(',')}))`)
      const placement = emit(`AXIS2_PLACEMENT_3D('',${pointIds[0]},${normalId},${xAxisId})`)
      const plane = emit(`PLANE('',${placement})`)
      const loop = emit(`POLY_LOOP('',(${pointIds.join(',')}))`)
      const bound = emit(`FACE_OUTER_BOUND('',${loop},.T.)`)
      faceIds.push(emit(`FACE_SURFACE('',(${bound}),${plane},.T.)`))
    }
    if ([...edgeUse.values()].some((uses) => uses !== 2)) throw new RangeError(`${part.name} is not a closed manifold and cannot be exported as a solid`)
    const shell = emit(`CLOSED_SHELL('',(${faceIds.join(',')}))`)
    breps.push(emit(`FACETED_BREP('${stepString(part.name)}',${shell})`))
  }

  const representation = emit(`FACETED_BREP_SHAPE_REPRESENTATION('${stepString(documentName)}',(${breps.join(',')}),${context})`)
  emit(`SHAPE_DEFINITION_REPRESENTATION(${definitionShape},${representation})`)
  lines.push('ENDSEC;', 'END-ISO-10303-21;')
  return lines.join('\n')
}

export function exportToSTEP(parts: Part[], documentName = 'BestCad_Model'): void {
  const stepString = createSTEPText(parts, documentName)
  const blob = new Blob([stepString], { type: 'application/step;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${documentName.replace(/[^a-z0-9_-]/gi, '_')}.stp`
  link.click()
  URL.revokeObjectURL(url)
}
