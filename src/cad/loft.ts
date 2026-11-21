import * as THREE from 'three'
import type { MeshData } from './types'

export type LoftMesh = { meshData: MeshData; position: [number, number, number]; size: [number, number, number] }

function cleanLoop(input: THREE.Vector3[]): THREE.Vector3[] {
  const points = input.filter((point) => point.toArray().every(Number.isFinite)).map((point) => point.clone())
  if (points.length > 1 && points[0].distanceTo(points[points.length - 1]) < 1e-7) points.pop()
  if (points.length < 3) throw new RangeError('Each loft section needs at least three points')
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index].distanceTo(points[(index + 1) % points.length]) < 1e-7) points.splice(index, 1)
  }
  if (points.length < 3) throw new RangeError('Each loft section needs at least three distinct points')
  const areaVector = points.reduce((sum, point, index) => sum.add(new THREE.Vector3().crossVectors(point, points[(index + 1) % points.length])), new THREE.Vector3())
  if (areaVector.length() < 1e-8) throw new RangeError('Loft section has zero area')
  return points
}

function sectionNormal(points: THREE.Vector3[]): THREE.Vector3 {
  const normal = new THREE.Vector3()
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index], next = points[(index + 1) % points.length]
    normal.x += (point.y - next.y) * (point.z + next.z)
    normal.y += (point.z - next.z) * (point.x + next.x)
    normal.z += (point.x - next.x) * (point.y + next.y)
  }
  if (normal.length() < 1e-8) throw new RangeError('Loft section is degenerate')
  return normal.normalize()
}

function resample(points: THREE.Vector3[], count: number): THREE.Vector3[] {
  const lengths = points.map((point, index) => point.distanceTo(points[(index + 1) % points.length]))
  const perimeter = lengths.reduce((sum, value) => sum + value, 0)
  if (perimeter < 1e-8) throw new RangeError('Loft section has zero perimeter')
  return Array.from({ length: count }, (_, sample) => {
    let distance = perimeter * sample / count
    for (let index = 0; index < points.length; index += 1) {
      if (distance <= lengths[index] || index === points.length - 1) {
        return points[index].clone().lerp(points[(index + 1) % points.length], Math.min(1, distance / Math.max(lengths[index], 1e-12)))
      }
      distance -= lengths[index]
    }
    return points[0].clone()
  })
}

/** Builds a closed, faceted loft between two planar closed sketch contours. */
export function createLoftMesh(firstInput: THREE.Vector3[], secondInput: THREE.Vector3[]): LoftMesh {
  const first = cleanLoop(firstInput)
  let second = cleanLoop(secondInput)
  const firstNormal = sectionNormal(first)
  const secondNormal = sectionNormal(second)
  if (first.some((point) => Math.abs(point.clone().sub(first[0]).dot(firstNormal)) > 1e-4) || second.some((point) => Math.abs(point.clone().sub(second[0]).dot(secondNormal)) > 1e-4)) {
    throw new RangeError('Loft section profiles must be planar')
  }
  if (Math.abs(firstNormal.dot(secondNormal)) < 0.995) throw new RangeError('Loft sections must be parallel; use a sweep for a changing section plane')
  if (firstNormal.dot(secondNormal) < 0) second = second.reverse()
  if (Math.abs(second[0].clone().sub(first[0]).dot(firstNormal)) < 1e-4) throw new RangeError('Loft sections must lie on separate parallel planes')
  const n = Math.max(12, Math.min(192, Math.max(first.length, second.length)))
  const a = resample(first, n)
  const b = resample(second, n)
  let bestShift = 0, bestCost = Infinity
  for (let shift = 0; shift < n; shift += 1) {
    let cost = 0
    for (let index = 0; index < n; index += 1) cost += a[index].distanceToSquared(b[(index + shift) % n])
    if (cost < bestCost) { bestCost = cost; bestShift = shift }
  }
  const alignedB = b.map((_, index) => b[(index + bestShift) % n])
  const vertices = [...a, ...alignedB]
  const indices: number[] = []
  for (let index = 0; index < n; index += 1) {
    const next = (index + 1) % n
    indices.push(index, next, n + next, index, n + next, n + index)
  }

  const u = a[1].clone().sub(a[0]).normalize()
  const v = new THREE.Vector3().crossVectors(firstNormal, u).normalize()
  const projected = a.map((point) => new THREE.Vector2(point.clone().sub(a[0]).dot(u), point.clone().sub(a[0]).dot(v)))
  const capTriangles = THREE.ShapeUtils.triangulateShape(projected, [])
  if (capTriangles.length !== n - 2) throw new RangeError('Loft profile is self-intersecting or cannot be triangulated')
  for (const triangle of capTriangles) {
    indices.push(triangle[2], triangle[1], triangle[0])
    indices.push(n + triangle[0], n + triangle[1], n + triangle[2])
  }

  const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  vertices.forEach((point) => { min.min(point); max.max(point) })
  const center = min.clone().add(max).multiplyScalar(0.5)
  const positions = vertices.flatMap((point) => point.sub(center).toArray())
  const size = max.clone().sub(min)
  return {
    meshData: { positions, indices },
    position: center.toArray() as [number, number, number],
    size: size.toArray() as [number, number, number],
  }
}
