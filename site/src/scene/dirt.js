import * as THREE from 'three';
import { heightAt } from './world.js';

// Clods thrown up when the hand breaks the surface. Plain ballistics, then they rest and sink.
export function createDirt(scene, textures, count = 90) {
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const pos = geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const s = 0.75 + Math.random() * 0.5;
    pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * s * 0.8, pos.getZ(i) * s);
  }
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0x9a8a7a,
    roughness: 0.85,
    map: textures.soil,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  scene.add(mesh);

  const clods = Array.from({ length: count }, () => ({
    p: new THREE.Vector3(),
    v: new THREE.Vector3(),
    spin: new THREE.Vector3(),
    rot: new THREE.Euler(),
    size: 0,
    resting: false,
    active: false,
  }));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();

  function burst(center, { strength = 1, share = 1 } = {}) {
    const n = Math.floor(count * share);
    let used = 0;
    for (const c of clods) {
      if (used >= n) break;
      if (c.active && strength < 1) continue;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.05;
      c.p.set(center.x + Math.cos(a) * r, center.y + 0.01, center.z + Math.sin(a) * r);
      const out = (0.25 + Math.random() * 0.7) * strength;
      c.v.set(Math.cos(a) * out, (0.9 + Math.random() * 1.5) * strength, Math.sin(a) * out);
      c.spin.set(Math.random() * 12, Math.random() * 12, Math.random() * 12);
      c.size = 0.004 + Math.pow(Math.random(), 2.6) * 0.016;
      c.resting = false;
      c.active = true;
      used++;
    }
  }

  let sink = 0;
  function update(dt) {
    for (let i = 0; i < count; i++) {
      const c = clods[i];
      if (!c.active) {
        m.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, m);
        continue;
      }
      if (!c.resting) {
        c.v.y -= 9.8 * dt;
        c.p.addScaledVector(c.v, dt);
        c.rot.x += c.spin.x * dt;
        c.rot.y += c.spin.y * dt;
        c.rot.z += c.spin.z * dt;
        const floor = heightAt(c.p.x, c.p.z) + c.size * 0.4;
        if (c.p.y < floor) {
          c.p.y = floor;
          if (c.v.y < -0.8) {
            c.v.y *= -0.25;
            c.v.x *= 0.4;
            c.v.z *= 0.4;
          } else {
            c.resting = true;
          }
        }
      }
      q.setFromEuler(c.rot);
      const size = c.size * (1 - sink);
      s.set(size, size, size);
      m.compose(c.p, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  return {
    burst,
    update,
    // 0 shows every clod, 1 has them all sunk back into the mound.
    setSink(value) {
      sink = value;
      if (value >= 1) for (const c of clods) c.active = false;
    },
  };
}
