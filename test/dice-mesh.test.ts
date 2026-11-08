import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { createDie, disposeDie } from "../src/dice-mesh";

function faces(die: THREE.Group): THREE.Group[] {
  return die.children.filter((child): child is THREE.Group => child instanceof THREE.Group);
}

function meshes(die: THREE.Group): THREE.Mesh[] {
  const result: THREE.Mesh[] = [];
  die.traverse(object => { if (object instanceof THREE.Mesh) result.push(object); });
  return result;
}

describe("createDie", () => {
  it("gives the shared goods die a white body with contrasting pips", () => {
    const die = createDie(4, 0x353c36, 0xffffff);
    for (const mesh of meshes(die))
      expect((mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(mesh.name === "pip" ? 0x353c36 : 0xffffff);
    disposeDie(die);
  });

  it.each([1, 2, 3, 4, 5, 6])("puts %i on +Z with six consistent, correctly pipped faces", value => {
    const die = createDie(value, 0x603343);
    const sides = faces(die);
    expect(die.userData.value).toBe(value);
    expect(die.position.toArray()).toEqual([0, 0, 0]);
    expect(die.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(sides.map(face => face.userData.value).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sides.map(face => face.userData.normal.join(",")).sort())
      .toEqual(["-1,0,0", "0,-1,0", "0,0,-1", "0,0,1", "0,1,0", "1,0,0"]);
    expect(sides.find(face => face.userData.normal.join(",") === "0,0,1")?.userData.value).toBe(value);
    expect(meshes(die).filter(mesh => mesh.name === "pip")).toHaveLength(21);

    const patterns = [[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];
    for (const face of sides) {
      const normal = new THREE.Vector3(...face.userData.normal as [number, number, number]);
      expect(new THREE.Vector3(0, 0, 1).applyQuaternion(face.quaternion).distanceTo(normal)).toBeLessThan(1e-12);
      expect(face.position.distanceTo(normal.clone().multiplyScalar(.5))).toBeLessThan(1e-12);
      const opposite = sides.find(other => new THREE.Vector3(...other.userData.normal as [number, number, number]).dot(normal) === -1)!;
      expect(face.userData.value + opposite.userData.value).toBe(7);
      const pips = face.children.filter(child => child.name === "pip");
      expect(pips).toHaveLength(face.userData.value);
      expect(pips.map(pip => {
        expect(pip).toBeInstanceOf(THREE.Mesh);
        expect(pip.position.z).toBe(0);
        return Math.round(1 - pip.position.y / .235) * 3 + Math.round(pip.position.x / .235 + 1);
      }).sort()).toEqual(patterns[face.userData.value]);
    }
    const normalFor = (n: number) => new THREE.Vector3(...sides.find(face => face.userData.value === n)!.userData.normal as [number, number, number]);
    expect(normalFor(1).cross(normalFor(2)).dot(normalFor(3))).toBe(-1);
    disposeDie(die);
  });

  it("has unit bounds, rounded corners, and true recessed pips without a canvas", () => {
    const die = createDie(5, "#234b47");
    const bounds = new THREE.Box3().setFromObject(die, true);
    expect(bounds.getCenter(new THREE.Vector3()).length()).toBeLessThan(1e-7);
    for (const dimension of bounds.getSize(new THREE.Vector3()).toArray()) expect(dimension).toBeCloseTo(1, 6);
    const body = die.getObjectByName("body") as THREE.Mesh;
    expect(body.geometry).toBeInstanceOf(RoundedBoxGeometry);
    const positions = body.geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i++) {
      expect(new THREE.Vector3().fromBufferAttribute(positions, i).length()).toBeLessThan(.85);
    }
    const front = faces(die).find(face => face.userData.normal.join(",") === "0,0,1")!;
    const centerPip = front.children.find(child => child.name === "pip" && child.position.length() === 0) as THREE.Mesh;
    const centerRay = new THREE.Raycaster(new THREE.Vector3(0, 0, 2), new THREE.Vector3(0, 0, -1));
    const pipHits = centerRay.intersectObject(die, true);
    expect(pipHits[0].object.uuid).toBe(centerPip.uuid);
    expect(pipHits[0].point.z).toBeCloseTo(.481, 6);
    const surfaceRay = new THREE.Raycaster(new THREE.Vector3(.12, 0, 2), new THREE.Vector3(0, 0, -1));
    const surfaceHits = surfaceRay.intersectObject(die, true);
    expect(surfaceHits[0].object.name).toBe("face-surface");
    expect(surfaceHits[0].point.z).toBeCloseTo(.5, 6);
    const pipPositions = centerPip.geometry.getAttribute("position");
    for (let i = 0; i < pipPositions.count; i++) expect(pipPositions.getZ(i)).toBeLessThan(1e-7);
    const triangles = meshes(die).reduce((sum, mesh) => sum + (mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position").count) / 3, 0);
    expect(triangles).toBeLessThan(5000);
    disposeDie(die);
  });

  it("shares lit materials and pip geometry within a die, never between dice", () => {
    const burgundy = createDie(2, 0x603343);
    const teal = createDie(6, "#234b47");
    const firstMeshes = meshes(burgundy);
    const secondMeshes = meshes(teal);
    const firstPips = firstMeshes.filter(mesh => mesh.name === "pip");
    expect(new Set(firstPips.map(pip => pip.geometry)).size).toBe(1);
    expect(new Set(firstPips.map(pip => pip.material)).size).toBe(1);
    expect(new Set(firstMeshes.map(mesh => mesh.material)).size).toBe(2);
    expect(new Set(firstMeshes.map(mesh => mesh.geometry)).size).toBe(8);
    for (const mesh of [...firstMeshes, ...secondMeshes]) {
      expect(mesh.material).toBeInstanceOf(THREE.MeshStandardMaterial);
      const material = mesh.material as THREE.MeshStandardMaterial;
      expect(material.metalness).toBe(0);
      expect(material.roughness).toBeGreaterThan(.3);
      expect(material.map).toBeNull();
      expect(mesh.castShadow).toBe(true);
      expect(mesh.receiveShadow).toBe(true);
    }
    for (const mesh of secondMeshes) {
      expect(firstMeshes.some(first => first.geometry === mesh.geometry || first.material === mesh.material)).toBe(false);
      expect((mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(mesh.name === "pip" ? 0x234b47 : 0xf3e5c8);
    }
    expect((firstPips[0].material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x603343);
    (firstPips[0].material as THREE.MeshStandardMaterial).color.set(0xffffff);
    faces(burgundy)[0].userData.normal[0] = 99;
    const fresh = createDie(2, 0x603343);
    expect(faces(fresh)[0].userData.normal).not.toContain(99);
    expect(((fresh.getObjectByName("pip") as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x603343);
    expect(((teal.getObjectByName("pip") as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x234b47);
    disposeDie(burgundy);
    disposeDie(teal);
    disposeDie(fresh);
  });

  it.each([0, 7, 2.5, NaN, Infinity])("rejects invalid face value %s", value => {
    expect(() => createDie(value, 0x603343)).toThrow(RangeError);
  });
});

describe("disposeDie", () => {
  it("disposes each owned resource once, handles repeated materials, and detaches safely", () => {
    const die = createDie(4, 0x603343);
    const other = createDie(1, 0x234b47);
    const parent = new THREE.Group().add(die, other);
    const ownedMeshes = meshes(die);
    const material = ownedMeshes[0].material as THREE.Material;
    ownedMeshes[0].material = [material, material];
    const geometries = new Set(ownedMeshes.map(mesh => mesh.geometry));
    const materials = new Set(ownedMeshes.flatMap(mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material]));
    const disposed = [...geometries, ...materials].map(resource => vi.spyOn(resource, "dispose"));
    const otherDisposed = vi.spyOn(meshes(other)[0].geometry, "dispose");
    disposeDie(die);
    disposeDie(die);
    for (const spy of disposed) expect(spy).toHaveBeenCalledTimes(1);
    expect(otherDisposed).not.toHaveBeenCalled();
    expect(die.parent).toBeNull();
    expect(die.children).toHaveLength(0);
    expect(parent.children).toEqual([other]);
    expect(meshes(other).filter(mesh => mesh.name === "pip")).toHaveLength(21);
    disposeDie(other);
  });
});
