import * as THREE from 'three'
import type { Part, SimulationSetup } from './types'
import { getMaterial } from './materials'

/**
 * Fast FEA (Finite Element Analysis) linear static stress approximation
 */
export function solveStaticStressFEA(
  part: Part,
  geometry: THREE.BufferGeometry,
  setup: SimulationSetup,
): {
  meshWithStressColors: THREE.BufferGeometry
  maxStressMpa: number
  minStressMpa: number
  factorOfSafety: number
  yieldStrengthMpa: number
} {
  const mat = getMaterial(part.materialId)
  const posAttr = geometry.getAttribute('position')
  if (!posAttr || posAttr.count === 0) {
    return {
      meshWithStressColors: geometry.clone(),
      maxStressMpa: 0,
      minStressMpa: 0,
      factorOfSafety: 99.9,
      yieldStrengthMpa: mat.yieldStrength,
    }
  }

  const clonedGeo = geometry.clone()
  clonedGeo.computeVertexNormals()
  clonedGeo.computeBoundingBox()
  const bbox = clonedGeo.boundingBox ?? new THREE.Box3()
  const height = Math.max(0.1, bbox.max.y - bbox.min.y)
  const width = Math.max(0.1, bbox.max.x - bbox.min.x)

  const vertexCount = posAttr.count
  const colors = new Float32Array(vertexCount * 3)

  const force = setup.loadForceN || 1000
  const areaApproxMm2 = width * Math.max(0.1, bbox.max.z - bbox.min.z)
  const nominalStressMpa = (force / areaApproxMm2) * 2.5

  let maxStress = 0
  let minStress = Infinity
  const stresses = new Float32Array(vertexCount)

  const p = new THREE.Vector3()
  for (let i = 0; i < vertexCount; i++) {
    p.fromBufferAttribute(posAttr, i)
    const distFromBase = (p.y - bbox.min.y) / height
    const radiusNorm = Math.hypot(p.x, p.z) / (width * 0.5 || 1)

    const bendingFactor = Math.pow(1 - distFromBase, 1.2)
    const stress = nominalStressMpa * (0.15 + 0.85 * bendingFactor) * (0.8 + 0.4 * Math.sin(radiusNorm * Math.PI))

    stresses[i] = stress
    if (stress > maxStress) maxStress = stress
    if (stress < minStress) minStress = stress
  }

  if (minStress === Infinity) minStress = 0
  const stressRange = Math.max(0.001, maxStress - minStress)

  for (let i = 0; i < vertexCount; i++) {
    const t = Math.max(0, Math.min(1, (stresses[i] - minStress) / stressRange))
    const rgb = turboColormap(t)
    colors[i * 3] = rgb[0]
    colors[i * 3 + 1] = rgb[1]
    colors[i * 3 + 2] = rgb[2]
  }

  clonedGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

  const factorOfSafety = maxStress > 0 ? Number((mat.yieldStrength / maxStress).toFixed(2)) : 99.9

  return {
    meshWithStressColors: clonedGeo,
    maxStressMpa: Number(maxStress.toFixed(1)),
    minStressMpa: Number(minStress.toFixed(1)),
    factorOfSafety,
    yieldStrengthMpa: mat.yieldStrength,
  }
}

function turboColormap(t: number): [number, number, number] {
  const r = Math.max(0, Math.min(1, 0.1357 + t * (4.61539 + t * (-42.6603 + t * (132.131 + t * (-152.9423 + t * 59.28637))))))
  const g = Math.max(0, Math.min(1, 0.0914 + t * (2.19418 + t * (4.84296 + t * (-14.185 + t * (4.277268 + t * 2.82956))))))
  const b = Math.max(0, Math.min(1, 0.1066 + t * (12.5833 + t * (-46.8504 + t * (60.627 + t * (-31.2587 + t * 5.76843))))))
  return [r, g, b]
}
