import * as THREE from 'three'
import type { AssemblyJoint, AssemblyBOMItem, Part } from './types'
import { getMaterial } from './materials'

/**
 * Calculates transformed part positions and orientations taking into account
 * assembly joints and degrees of freedom.
 */
export function solveAssemblyJoints(
  parts: Part[],
  joints: AssemblyJoint[],
  explodedRatio = 0,
): Map<string, { position: [number, number, number]; rotation: [number, number, number] }> {
  const result = new Map<string, { position: [number, number, number]; rotation: [number, number, number] }>()

  // Initialize with base position & rotation
  for (const part of parts) {
    result.set(part.id, {
      position: [...part.position],
      rotation: part.rotation ? [...part.rotation] : [0, 0, 0],
    })
  }

  // Apply kinematic joints
  for (const joint of joints) {
    const target = result.get(joint.targetPartId)
    const base = result.get(joint.basePartId)
    if (!target || !base) continue

    const axisIdx = joint.axis === 'x' ? 0 : joint.axis === 'y' ? 1 : 2

    if (joint.type === 'slider') {
      // Linear displacement in mm
      const clampedVal = Math.max(joint.minLimit, Math.min(joint.maxLimit, joint.currentValue))
      target.position[axisIdx] = base.position[axisIdx] + clampedVal
    } else if (joint.type === 'revolute') {
      // Rotation in radians
      const clampedDeg = Math.max(joint.minLimit, Math.min(joint.maxLimit, joint.currentValue))
      const rad = THREE.MathUtils.degToRad(clampedDeg)
      target.rotation[axisIdx] = (base.rotation[axisIdx] || 0) + rad
    } else if (joint.type === 'cylindrical') {
      const clampedVal = Math.max(joint.minLimit, Math.min(joint.maxLimit, joint.currentValue))
      target.position[axisIdx] = base.position[axisIdx] + clampedVal
      target.rotation[axisIdx] = (base.rotation[axisIdx] || 0) + clampedVal * 0.1
    }
  }

  // Apply Exploded View displacement if active (> 0)
  if (explodedRatio > 0 && parts.length > 0) {
    let cx = 0, cy = 0, cz = 0
    let count = 0
    for (const part of parts) {
      if (part.visible) {
        cx += part.position[0]
        cy += part.position[1]
        cz += part.position[2]
        count++
      }
    }
    if (count > 0) {
      cx /= count
      cy /= count
      cz /= count

      const maxDisplacement = 4.0 // mm scale factor for explosion
      for (const part of parts) {
        const item = result.get(part.id)
        if (!item) continue
        const dx = part.position[0] - cx
        const dy = part.position[1] - cy
        const dz = part.position[2] - cz
        const dist = Math.hypot(dx, dy, dz) || 1

        const nx = dx / dist
        const ny = dy / dist
        const nz = dz / dist

        item.position[0] += nx * maxDisplacement * explodedRatio
        item.position[1] += ny * maxDisplacement * explodedRatio
        item.position[2] += nz * maxDisplacement * explodedRatio
      }
    }
  }

  return result
}

/**
 * Generates an engineering Bill of Materials (BOM) from the assembly parts
 */
export function generateBOM(parts: Part[]): AssemblyBOMItem[] {
  const bomMap = new Map<string, AssemblyBOMItem>()

  for (const part of parts) {
    const mat = getMaterial(part.materialId)
    // Approximate volume from size (mm³)
    let volMm3 = part.size[0] * part.size[1] * part.size[2]
    if (part.kind === 'cylinder') {
      const r = Math.min(part.size[0], part.size[2]) / 2
      volMm3 = Math.PI * r * r * part.size[1]
    } else if (part.kind === 'sphere') {
      const r = part.size[0] / 2
      volMm3 = (4 / 3) * Math.PI * Math.pow(r, 3)
    }

    const volCm3 = volMm3 / 1000.0
    const massG = volCm3 * mat.density

    // Group parts by identical name & dimensions
    const groupKey = `${part.name}-${part.size.map((s) => s.toFixed(1)).join('x')}`

    if (bomMap.has(groupKey)) {
      const existing = bomMap.get(groupKey)!
      existing.quantity += 1
      existing.volumeCm3 += volCm3
      existing.massGrams += massG
    } else {
      bomMap.set(groupKey, {
        partId: part.id,
        name: part.name,
        quantity: 1,
        materialName: mat.name,
        volumeCm3: volCm3,
        massGrams: massG,
        dimensionsMm: `${part.size[0].toFixed(1)} × ${part.size[1].toFixed(1)} × ${part.size[2].toFixed(1)}`,
      })
    }
  }

  return Array.from(bomMap.values())
}

/**
 * Exports BOM as standard comma-separated values (CSV)
 */
export function exportBOMtoCSV(bom: AssemblyBOMItem[], documentName = 'Assembly'): void {
  const header = ['Item #', 'Part Name', 'Quantity', 'Material', 'Volume (cm3)', 'Mass (g)', 'Dimensions (mm)'].join(',')
  const rows = bom.map((item, index) =>
    [
      index + 1,
      `"${item.name.replace(/"/g, '""')}"`,
      item.quantity,
      `"${item.materialName}"`,
      item.volumeCm3.toFixed(2),
      item.massGrams.toFixed(2),
      `"${item.dimensionsMm}"`,
    ].join(','),
  )

  const csvContent = [header, ...rows].join('\n')
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.setAttribute('href', url)
  link.setAttribute('download', `${documentName.replace(/[^a-z0-9_-]/gi, '_')}_BOM.csv`)
  link.click()
  URL.revokeObjectURL(url)
}
