import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

/** A unit ivory die by default; color selects the pip ink. */
export function createDie(value: number, color: number | string, bodyColor: number | string = 0xf3e5c8): THREE.Group {
  if (!Number.isInteger(value) || value < 1 || value > 6) {
    throw new RangeError("Die value must be an integer from 1 to 6.");
  }

  const die = new THREE.Group();
  die.name = "die";
  die.userData.value = value;
  const radius = .1;
  const faceExtent = .5 - radius;
  const pipRadius = .074;
  const pipSegments = 24;
  const ivory = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: .58, metalness: 0 });
  const ink = new THREE.MeshStandardMaterial({ color, roughness: .56, metalness: 0 });
  const bodyGeometry = new RoundedBoxGeometry(1, 1, 1, 3, radius);

  // Replace only the six flat squares with perforated faces. The rounded
  // edge shell stays intact, so the pips can recess below the unit surface.
  const normals = bodyGeometry.getAttribute("normal");
  const indices: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < normals.count; i += 3) {
    a.fromBufferAttribute(normals, i);
    b.fromBufferAttribute(normals, i + 1);
    c.fromBufferAttribute(normals, i + 2);
    const flat = Math.max(Math.abs(a.x), Math.abs(a.y), Math.abs(a.z)) > .999999 &&
      a.distanceToSquared(b) < 1e-12 && a.distanceToSquared(c) < 1e-12;
    if (!flat) indices.push(i, i + 1, i + 2);
  }
  bodyGeometry.setIndex(indices);
  bodyGeometry.clearGroups();
  const body = new THREE.Mesh(bodyGeometry, ivory);
  body.name = "body";
  die.add(body);

  // An inward-facing, shallow bowl; the rim is flush with the face.
  const pipGeometry = new THREE.LatheGeometry([
    new THREE.Vector2(pipRadius, 0),
    new THREE.Vector2(.065, -.006),
    new THREE.Vector2(.044, -.015),
    new THREE.Vector2(0, -.019),
  ], pipSegments).rotateX(Math.PI / 2);
  const patterns = [[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];
  const canonicalNormals: [number, number, number][] = [
    [0, 0, 1], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, -1, 0], [0, 0, -1],
  ];
  const front = new THREE.Vector3(0, 0, 1);
  // Rotate a single canonical layout, preserving its handedness for every result.
  const orientation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...canonicalNormals[value - 1]), front);

  for (const [index, canonicalNormal] of canonicalNormals.entries()) {
    const faceValue = index + 1;
    const face = new THREE.Group();
    const originalNormal = new THREE.Vector3(...canonicalNormal);
    const normal = originalNormal.clone().applyQuaternion(orientation);
    normal.set(Math.round(normal.x) || 0, Math.round(normal.y) || 0, Math.round(normal.z) || 0);
    face.name = `face-${faceValue}`;
    face.userData.value = faceValue;
    face.userData.normal = normal.toArray();
    face.position.copy(normal).multiplyScalar(.5);
    face.quaternion.setFromUnitVectors(front, originalNormal).premultiply(orientation);

    const surface = new THREE.Shape()
      .moveTo(-faceExtent, -faceExtent).lineTo(faceExtent, -faceExtent)
      .lineTo(faceExtent, faceExtent).lineTo(-faceExtent, faceExtent).closePath();
    for (const slot of patterns[faceValue]) {
      const x = (slot % 3 - 1) * .235;
      const y = (1 - Math.floor(slot / 3)) * .235;
      const hole = new THREE.Path();
      // Match the bowl's polygon exactly rather than approximate a second circle.
      for (let segment = 0; segment < pipSegments; segment++) {
        const angle = segment / pipSegments * Math.PI * 2;
        const px = x + Math.sin(angle) * pipRadius;
        const py = y - Math.cos(angle) * pipRadius;
        if (segment === 0) hole.moveTo(px, py);
        else hole.lineTo(px, py);
      }
      surface.holes.push(hole.closePath());
      const pip = new THREE.Mesh(pipGeometry, ink);
      pip.name = "pip";
      pip.position.set(x, y, 0);
      face.add(pip);
    }
    const cap = new THREE.Mesh(new THREE.ShapeGeometry(surface), ivory);
    cap.name = "face-surface";
    face.add(cap);
    die.add(face);
  }
  die.traverse(object => { object.castShadow = true; object.receiveShadow = true; });
  return die;
}

/** Releases only this die's resources, once each, and detaches its graph. */
export function disposeDie(die: THREE.Group): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  die.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  die.removeFromParent();
  die.clear();
}
