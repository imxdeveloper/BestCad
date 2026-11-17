import * as THREE from 'three'
import type { Part } from './types'

export type BodyMetrics = {
  volumeMm3: number
  volumeCm3: number
  surfaceAreaMm2: number
  centerOfMass: [number, number, number]
  massGrams: number
  boundingBox: {
    min: [number, number, number]
    max: [number, number, number]
    size: [number, number, number]
  }
}

/**
 * Computes exact volume, surface area, and center of mass using Divergence Theorem
 * on closed 3D triangular meshes.
 */
export function computeGeometryMetrics(geometry: THREE.BufferGeometry, densityGPerCm3 = 2.7): BodyMetrics {
  const posAttr = geometry.getAttribute('position')
  const indexAttr = geometry.getIndex()

  if (!posAttr || posAttr.count < 3) {
    return {
      volumeMm3: 0,
      volumeCm3: 0,
      surfaceAreaMm2: 0,
      centerOfMass: [0, 0, 0],
      massGrams: 0,
      boundingBox: { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] },
    }
  }

  let totalVolume = 0
  let totalArea = 0
  let cx = 0
  let cy = 0
  let cz = 0

  const p1 = new THREE.Vector3()
  const p2 = new THREE.Vector3()
  const p3 = new THREE.Vector3()
  const edge1 = new THREE.Vector3()
  const edge2 = new THREE.Vector3()
  const normal = new THREE.Vector3()

  const numFaces = indexAttr ? indexAttr.count / 3 : posAttr.count / 3

  for (let i = 0; i < numFaces; i++) {
    const i1 = indexAttr ? indexAttr.getX(i * 3) : i * 3
    const i2 = indexAttr ? indexAttr.getX(i * 3 + 1) : i * 3 + 1
    const i3 = indexAttr ? indexAttr.getX(i * 3 + 2) : i * 3 + 2

    p1.fromBufferAttribute(posAttr, i1)
    p2.fromBufferAttribute(posAttr, i2)
    p3.fromBufferAttribute(posAttr, i3)

    edge1.crossVectors(p2, p3)
    const signedVol = p1.dot(edge1) / 6.0
    totalVolume += signedVol

    cx += signedVol * (p1.x + p2.x + p3.x) / 4.0
    cy += signedVol * (p1.y + p2.y + p3.y) / 4.0
    cz += signedVol * (p1.z + p2.z + p3.z) / 4.0

    edge1.subVectors(p2, p1)
    edge2.subVectors(p3, p1)
    normal.crossVectors(edge1, edge2)
    totalArea += normal.length() * 0.5
  }

  totalVolume = Math.abs(totalVolume)
  if (totalVolume > 1e-9) {
    cx /= totalVolume
    cy /= totalVolume
    cz /= totalVolume
  }

  geometry.computeBoundingBox()
  const bbox = geometry.boundingBox ?? new THREE.Box3()
  const bSize = bbox.getSize(new THREE.Vector3())

  const volumeCm3 = totalVolume / 1000.0
  const massGrams = volumeCm3 * densityGPerCm3

  return {
    volumeMm3: totalVolume,
    volumeCm3,
    surfaceAreaMm2: totalArea,
    centerOfMass: [cx, cy, cz],
    massGrams,
    boundingBox: {
      min: [bbox.min.x, bbox.min.y, bbox.min.z],
      max: [bbox.max.x, bbox.max.y, bbox.max.z],
      size: [bSize.x, bSize.y, bSize.z],
    },
  }
}

export function calculateDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

export function calculatePartCenterDistance(p1: Part, p2: Part): number {
  return calculateDistance(p1.position, p2.position)
}
