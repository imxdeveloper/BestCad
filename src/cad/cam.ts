import * as THREE from 'three'
import type { Part, CAMSetup } from './types'

const MAX_CAM_PASSES = 10_000

export type ToolpathSegment = {
  type: 'rapid' | 'cut' | 'lead'
  points: [number, number, number][]
}

/**
 * Computes CNC 2.5D machining toolpaths and generates standard ISO RS-274 / Fanuc G-code
 */
export function generateCAMToolpaths(
  parts: Part[],
  setup: CAMSetup,
): {
  segments: ToolpathSegment[]
  stockBoundingBox: THREE.Box3
  gcode: string
  totalTimeMinutes: number
} {
  const stockBox = new THREE.Box3()
  for (const part of parts) {
    if (!part.visible) continue
    if (![...part.size, ...part.position].every(Number.isFinite) || part.size.some((dimension) => dimension <= 0)) {
      throw new RangeError(`Part "${part.name}" has invalid dimensions or position`)
    }
    const minX = part.position[0] - part.size[0] / 2
    const maxX = part.position[0] + part.size[0] / 2
    const minY = part.position[1] - part.size[1] / 2
    const maxY = part.position[1] + part.size[1] / 2
    const minZ = part.position[2] - part.size[2] / 2
    const maxZ = part.position[2] + part.size[2] / 2
    stockBox.expandByPoint(new THREE.Vector3(minX, minY, minZ))
    stockBox.expandByPoint(new THREE.Vector3(maxX, maxY, maxZ))
  }

  if (stockBox.isEmpty()) {
    const origin = new THREE.Vector3(0, 0, 0)
    return {
      segments: [],
      stockBoundingBox: new THREE.Box3(origin.clone(), origin.clone()),
      gcode: '',
      totalTimeMinutes: 0,
    }
  }

  if (!Number.isFinite(setup.stockOffsetMm) || setup.stockOffsetMm < 0) {
    throw new RangeError('Stock offset must be a finite, non-negative value')
  }
  if (!Number.isFinite(setup.toolDiameterMm) || setup.toolDiameterMm <= 0) {
    throw new RangeError('Tool diameter must be a finite, positive value')
  }
  if (!Number.isFinite(setup.spindleRpm) || setup.spindleRpm <= 0) {
    throw new RangeError('Spindle speed must be a finite, positive value')
  }
  if (!Number.isFinite(setup.feedRateMmMin) || setup.feedRateMmMin <= 0) {
    throw new RangeError('Feed rate must be a finite, positive value')
  }
  if (!['facing', 'pocket', 'contour'].includes(setup.selectedStrategy)) {
    throw new RangeError('Select a supported CAM strategy')
  }

  const margin = setup.stockOffsetMm
  stockBox.min.subScalar(margin)
  stockBox.max.addScalar(margin)

  const toolDiameter = setup.toolDiameterMm
  const stepover = toolDiameter * 0.45
  const toolRadius = toolDiameter / 2
  const safeZ = stockBox.max.y + 5.0
  const cutZ = stockBox.max.y

  const segments: ToolpathSegment[] = []
  const gcodeLines: string[] = []

  gcodeLines.push('%')
  gcodeLines.push('(PROGRAM: BESTCAD_CAM_OUTPUT)')
  gcodeLines.push(`(STRATEGY: ${setup.selectedStrategy.toUpperCase()})`)
  gcodeLines.push(`(TOOL: ${toolDiameter.toFixed(1)}MM ENDMILL)`)
  gcodeLines.push('G90 G94 G17 G21')
  gcodeLines.push('G28 G91 Z0.')
  gcodeLines.push('G90')
  gcodeLines.push(`T1 M06 (Tool change to 1)`)
  gcodeLines.push(`S${setup.spindleRpm} M03 (Spindle On CW)`)
  gcodeLines.push('G00 G54')
  gcodeLines.push(`G00 Z${safeZ.toFixed(2)}`)

  const minX = stockBox.min.x + toolRadius
  const maxX = stockBox.max.x - toolRadius
  const minZ = stockBox.min.z + toolRadius
  const maxZ = stockBox.max.z - toolRadius

  if (maxX <= minX || maxZ <= minZ) {
    throw new RangeError('Tool diameter is too large for the available stock area')
  }

  const estimatedPassCount = setup.selectedStrategy === 'facing'
    ? Math.floor((maxZ - minZ) / stepover) + 1
    : setup.selectedStrategy === 'pocket'
      ? Math.ceil(Math.min(maxX - minX, maxZ - minZ) / (stepover * 2))
      : 3
  if (estimatedPassCount > MAX_CAM_PASSES) {
    throw new RangeError(`CAM setup would create more than ${MAX_CAM_PASSES} passes`)
  }

  if (setup.selectedStrategy === 'facing') {
    let forward = true
    let currentZ = minZ
    let rapid = true

    while (currentZ <= maxZ) {
      const startX = forward ? minX : maxX
      const endX = forward ? maxX : minX

      segments.push({
        type: 'rapid',
        points: [
          [startX, safeZ, currentZ],
          [startX, cutZ, currentZ],
        ],
      })
      if (rapid) {
        gcodeLines.push(`G00 X${startX.toFixed(3)} Y${currentZ.toFixed(3)}`)
        gcodeLines.push(`G00 Z${cutZ.toFixed(3)}`)
        rapid = false
      } else {
        gcodeLines.push(`G01 X${startX.toFixed(3)} Y${currentZ.toFixed(3)} F${setup.feedRateMmMin}`)
      }

      segments.push({
        type: 'cut',
        points: [
          [startX, cutZ, currentZ],
          [endX, cutZ, currentZ],
        ],
      })
      gcodeLines.push(`G01 X${endX.toFixed(3)} Y${currentZ.toFixed(3)} F${setup.feedRateMmMin}`)

      currentZ += stepover
      forward = !forward
    }
  } else if (setup.selectedStrategy === 'contour') {
    const depths = [cutZ - 0.5, cutZ - 1.0, cutZ - 1.5]
    for (const z of depths) {
      segments.push({
        type: 'rapid',
        points: [[minX, safeZ, minZ], [minX, z, minZ]],
      })
      gcodeLines.push(`G00 X${minX.toFixed(3)} Y${minZ.toFixed(3)}`)
      gcodeLines.push(`G01 Z${z.toFixed(3)} F${setup.feedRateMmMin / 2}`)

      const perimeter: [number, number, number][] = [
        [minX, z, minZ],
        [maxX, z, minZ],
        [maxX, z, maxZ],
        [minX, z, maxZ],
        [minX, z, minZ],
      ]

      for (let i = 0; i < perimeter.length - 1; i++) {
        segments.push({
          type: 'cut',
          points: [perimeter[i], perimeter[i + 1]],
        })
        gcodeLines.push(`G01 X${perimeter[i + 1][0].toFixed(3)} Y${perimeter[i + 1][2].toFixed(3)} F${setup.feedRateMmMin}`)
      }
    }
  } else {
    let offset = 0
    while (minX + offset < maxX - offset && minZ + offset < maxZ - offset) {
      const x0 = minX + offset
      const x1 = maxX - offset
      const z0 = minZ + offset
      const z1 = maxZ - offset

      segments.push({
        type: 'rapid',
        points: [[x0, safeZ, z0], [x0, cutZ, z0]],
      })
      gcodeLines.push(`G00 X${x0.toFixed(3)} Y${z0.toFixed(3)}`)
      gcodeLines.push(`G01 Z${cutZ.toFixed(3)} F${setup.feedRateMmMin / 2}`)

      const loop: [number, number, number][] = [
        [x0, cutZ, z0],
        [x1, cutZ, z0],
        [x1, cutZ, z1],
        [x0, cutZ, z1],
        [x0, cutZ, z0],
      ]
      for (let i = 0; i < loop.length - 1; i++) {
        segments.push({
          type: 'cut',
          points: [loop[i], loop[i + 1]],
        })
        gcodeLines.push(`G01 X${loop[i + 1][0].toFixed(3)} Y${loop[i + 1][2].toFixed(3)} F${setup.feedRateMmMin}`)
      }

      offset += stepover
    }
  }

  gcodeLines.push(`G00 Z${safeZ.toFixed(2)}`)
  gcodeLines.push('M05 (Spindle Off)')
  gcodeLines.push('G28 G91 Z0.')
  gcodeLines.push('G90')
  gcodeLines.push('M30 (End of program)')
  gcodeLines.push('%')

  let totalCutDist = 0
  for (const seg of segments) {
    if (seg.type === 'cut') {
      const [p1, p2] = seg.points
      totalCutDist += Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2])
    }
  }
  const totalTimeMinutes = Number((totalCutDist / setup.feedRateMmMin).toFixed(1))

  return {
    segments,
    stockBoundingBox: stockBox,
    gcode: gcodeLines.join('\n'),
    totalTimeMinutes,
  }
}
