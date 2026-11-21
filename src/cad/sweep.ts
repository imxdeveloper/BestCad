import * as THREE from 'three'
import type { MeshData } from './types'
import type { LoftMesh } from './loft'

function sectionNormal(points: THREE.Vector3[]): THREE.Vector3 {
  const normal = new THREE.Vector3()
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index], next = points[(index + 1) % points.length]
    normal.x += (point.y - next.y) * (point.z + next.z)
    normal.y += (point.z - next.z) * (point.x + next.x)
    normal.z += (point.x - next.x) * (point.y + next.y)
  }
  if (normal.length() < 1e-8) throw new RangeError('Sweep profile is degenerate')
  return normal.normalize()
}

/** Sweeps a planar closed profile along a 3D open polyline using parallel-transport frames. */
export function createSweepMesh(profileInput: THREE.Vector3[], pathInput: THREE.Vector3[]): LoftMesh {
  let profile = profileInput.map((point) => point.clone())
  if (profile.length > 1 && profile[0].distanceTo(profile[profile.length - 1]) < 1e-7) profile.pop()
  if (profile.length < 3 || profile.some((point) => !point.toArray().every(Number.isFinite))) throw new RangeError('Sweep needs a finite closed profile with at least three points')
  const path: THREE.Vector3[] = []
  for (const point of pathInput) {
    if (!point.toArray().every(Number.isFinite)) throw new RangeError('Sweep path contains a non-finite point')
    if (!path.length || path[path.length - 1].distanceTo(point) > 1e-6) path.push(point.clone())
  }
  if (path.length < 2) throw new RangeError('Sweep path needs at least two distinct points')
  const profileCenter = profile.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / profile.length)
  let normal = sectionNormal(profile)
  const firstTangent = path[1].clone().sub(path[0]).normalize()
  if (Math.abs(normal.dot(firstTangent)) < 0.98) throw new RangeError('Sweep path must start normal to the profile sketch plane')
  if (normal.dot(firstTangent) < 0) {
    profile = profile.reverse()
    normal.negate()
  }
  const u0 = profile[0].clone().sub(profileCenter).normalize()
  if (u0.lengthSq() < 1e-8) throw new RangeError('Sweep profile has no stable start direction')
  const v0 = new THREE.Vector3().crossVectors(normal, u0).normalize()
  const localProfile = profile.map((point) => {
    const relative = point.clone().sub(profileCenter)
    return new THREE.Vector2(relative.dot(u0), relative.dot(v0))
  })
  const capTriangles = THREE.ShapeUtils.triangulateShape(localProfile, [])
  if (capTriangles.length !== profile.length - 2) throw new RangeError('Sweep profile is self-intersecting or cannot be triangulated')

  const tangents = path.map((_, index) => {
    const before = path[Math.max(0, index - 1)]
    const after = path[Math.min(path.length - 1, index + 1)]
    const tangent = after.clone().sub(before).normalize()
    if (tangent.lengthSq() < 1e-8) throw new RangeError('Sweep path contains a cusp')
    return tangent
  })
  if (Math.abs(tangents[0].dot(normal)) < 0.98) throw new RangeError('Sweep start direction must match the profile plane normal')
  const frames: { u: THREE.Vector3; v: THREE.Vector3 }[] = []
  let u = u0.clone().addScaledVector(tangents[0], -u0.dot(tangents[0])).normalize()
  if (u.lengthSq() < 1e-8) throw new RangeError('Sweep frame is singular at the start of the path')
  frames.push({ u, v: new THREE.Vector3().crossVectors(tangents[0], u).normalize() })
  for (let index = 1; index < path.length; index += 1) {
    const rotation = new THREE.Quaternion().setFromUnitVectors(tangents[index - 1], tangents[index])
    u = frames[index - 1].u.clone().applyQuaternion(rotation).addScaledVector(tangents[index], -frames[index - 1].u.clone().applyQuaternion(rotation).dot(tangents[index])).normalize()
    if (u.lengthSq() < 1e-8) throw new RangeError('Sweep frame is singular along the path')
    frames.push({ u, v: new THREE.Vector3().crossVectors(tangents[index], u).normalize() })
  }

  const count = profile.length
  const vertices = path.flatMap((center, sectionIndex) => localProfile.map((point) =>
    center.clone().addScaledVector(frames[sectionIndex].u, point.x).addScaledVector(frames[sectionIndex].v, point.y),
  ))
  const indices: number[] = []
  for (let section = 0; section < path.length - 1; section += 1) {
    const current = section * count, nextSection = (section + 1) * count
    for (let index = 0; index < count; index += 1) {
      const next = (index + 1) % count
      indices.push(current + index, current + next, nextSection + next, current + index, nextSection + next, nextSection + index)
    }
  }
  const lastOffset = (path.length - 1) * count
  for (const triangle of capTriangles) {
    indices.push(triangle[2], triangle[1], triangle[0])
    indices.push(lastOffset + triangle[0], lastOffset + triangle[1], lastOffset + triangle[2])
  }

  const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  vertices.forEach((point) => { min.min(point); max.max(point) })
  const center = min.clone().add(max).multiplyScalar(0.5)
  const positions = vertices.flatMap((point) => point.sub(center).toArray())
  const size = max.clone().sub(min)
  const meshData: MeshData = { positions, indices }
  return { meshData, position: center.toArray() as [number, number, number], size: size.toArray() as [number, number, number] }
}
