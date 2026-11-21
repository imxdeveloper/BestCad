import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import type { Part } from './types'
import { getExtrusionOrigin } from './extrusion'

function treatedCylinderGeometry(part: Part): THREE.BufferGeometry {
  const treatment = part.edgeTreatment!
  const radius = Math.min(part.size[0], part.size[2]) / 2
  const height = part.size[1]
  const edge = Math.min(treatment.size, radius * 0.45, height * 0.45)
  const points: THREE.Vector2[] = [new THREE.Vector2(0, -height / 2)]
  if (treatment.type === 'fillet') {
    points.push(new THREE.Vector2(radius - edge, -height / 2))
    for (let index = 0; index <= 6; index += 1) {
      const angle = -Math.PI / 2 + Math.PI / 2 * index / 6
      points.push(new THREE.Vector2(radius - edge + Math.cos(angle) * edge, -height / 2 + edge + Math.sin(angle) * edge))
    }
    points.push(new THREE.Vector2(radius, height / 2 - edge))
    for (let index = 0; index <= 6; index += 1) {
      const angle = Math.PI / 2 * index / 6
      points.push(new THREE.Vector2(radius - edge + Math.cos(angle) * edge, height / 2 - edge + Math.sin(angle) * edge))
    }
  } else {
    points.push(new THREE.Vector2(radius - edge, -height / 2), new THREE.Vector2(radius, -height / 2 + edge), new THREE.Vector2(radius, height / 2 - edge), new THREE.Vector2(radius - edge, height / 2))
  }
  points.push(new THREE.Vector2(0, height / 2))
  return new THREE.LatheGeometry(points, 48)
}

function treatedBoxGeometry(part: Part): THREE.BufferGeometry {
  if (part.edgeTreatment?.type === 'fillet') {
    const radius = Math.min(part.edgeTreatment.size, Math.min(...part.size) * 0.45)
    return new RoundedBoxGeometry(...part.size, 4, radius)
  }
  const [width, height, depth] = part.size
  const shape = new THREE.Shape()
  shape.moveTo(-width / 2, -depth / 2)
  shape.lineTo(width / 2, -depth / 2)
  shape.lineTo(width / 2, depth / 2)
  shape.lineTo(-width / 2, depth / 2)
  shape.closePath()
  const chamfer = Math.min(part.edgeTreatment!.size, Math.min(...part.size) * 0.45)
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: true, bevelSegments: 1, bevelSize: chamfer, bevelThickness: chamfer })
  geometry.translate(0, 0, -height / 2)
  geometry.rotateX(-Math.PI / 2)
  return geometry
}

export function createPartGeometry(part: Part): THREE.BufferGeometry {
  if (part.meshData) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.meshData.positions, 3))
    geometry.setIndex(part.meshData.indices)
    geometry.computeVertexNormals()
    return geometry
  }
  if (part.kind === 'revolution' && part.profile) {
    const axis = part.revolveAxis ?? 'vertical'
    const points = part.profile.map(([u, v]) => new THREE.Vector2(Math.abs(axis === 'vertical' ? u : v), axis === 'vertical' ? v : u))
    const geometry = new THREE.LatheGeometry(points, 64, 0, THREE.MathUtils.degToRad(part.revolveAngle ?? 360))
    if (axis === 'vertical') {
      if (part.profilePlane === 'right') geometry.rotateY(Math.PI / 2)
      else if (part.profilePlane === 'top') geometry.rotateX(Math.PI / 2)
    } else {
      const direction = part.profilePlane === 'right' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(1, 0, 0)
      geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction))
    }
    return geometry
  }
  if (part.kind === 'extrusion' && part.profile) {
    const shape = new THREE.Shape()
    part.profile.forEach(([u, v], index) => index ? shape.lineTo(u, v) : shape.moveTo(u, v))
    shape.closePath()
    const plane = part.profilePlane ?? 'top'
    const depth = part.arbitraryPlane ? part.size[2] : part.size[plane === 'top' ? 1 : plane === 'front' ? 2 : 0]
    const treatment = part.edgeTreatment
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth, bevelEnabled: Boolean(treatment), bevelSegments: treatment?.type === 'fillet' ? 4 : 1,
      bevelSize: treatment?.size ?? 0, bevelThickness: treatment?.size ?? 0,
    })
    if (part.arbitraryPlane) {
      const frame = part.arbitraryPlane
      geometry.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(...frame.uAxis), new THREE.Vector3(...frame.vAxis), new THREE.Vector3(...frame.normal)))
    }
    return geometry
  }
  if (part.kind === 'box') return part.edgeTreatment ? treatedBoxGeometry(part) : new THREE.BoxGeometry(...part.size)
  if (part.kind === 'cylinder') return part.edgeTreatment ? treatedCylinderGeometry(part) : new THREE.CylinderGeometry(part.size[0] / 2, part.size[2] / 2, part.size[1], 48)
  if (part.kind === 'sphere') return new THREE.SphereGeometry(0.5, 40, 28).scale(...part.size)
  return new THREE.BoxGeometry(...part.size)
}

/** Applies the same object-space placement used by the design viewport. */
export function applyPartTransform(mesh: THREE.Object3D, part: Part): void {
  mesh.position.set(...part.position)
  if (part.rotation) mesh.rotation.set(...part.rotation)
  if (part.kind === 'extrusion') {
    mesh.position.set(...getExtrusionOrigin(part))
    if (!part.arbitraryPlane) {
      if (part.profilePlane === 'top') mesh.rotation.x = -Math.PI / 2
      else if (part.profilePlane === 'right') mesh.rotation.y = -Math.PI / 2
    }
  }
}
