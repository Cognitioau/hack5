import * as THREE from 'three';
import { fbm2, mulberry32 } from './noise.js';
import { heightAt } from './world.js';

// Clods thrown up when the hand breaks the surface. Plain ballistics, then they rest and sink.
// The pool has to hold every burst in one cycle, because gentle bursts only take idle clods and
// nothing is freed until the grave settles.
export function createDirt(scene, textures, count = 120) {
  const random = mulberry32(5150);
  // A rounded, lumpy chunk: smooth noise over the sphere, slightly flattened, never spiky.
  const geometry = new THREE.IcosahedronGeometry(1, 3);
  const pos = geometry.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = 0.35 + 1.1 * fbm2(x * 1.6 + y * 0.9 + 2.1, z * 1.6 - y * 1.1 + 5.3) + 0.3 * fbm2(x * 4.5 + 1, z * 4.5 + y * 3.3);
    pos.setXYZ(i, x * n, y * n * 0.78, z * n);
    uv[i * 2] = 0.3 + x * 0.05;
    uv[i * 2 + 1] = 0.6 + z * 0.05 + y * 0.03;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0xe0c4aa,
    roughness: 0.62,
    envMapIntensity: 0.5,
    map: textures.soil,
    normalMap: textures.soilN,
    normalScale: new THREE.Vector2(0.7, 0.7),
  });
  // The scan's pale leaf litter is pressed down to the soil's own tone.
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      float zbL = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
      diffuseColor.rgb *= min(1.0, 0.13 / max(zbL, 1e-3));`,
    );
  };
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  scene.add(mesh);

  const clods = Array.from({ length: count }, () => ({
    p: new THREE.Vector3(),
    v: new THREE.Vector3(),
    spin: new THREE.Vector3(),
    rot: new THREE.Euler(),
    aspect: new THREE.Vector3(1, 1, 1),
    size: 0,
    resting: false,
    active: false,
  }));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();

  function burst(center, { strength = 1, clods: n = count } = {}) {
    let used = 0;
    for (const c of clods) {
      if (used >= n) break;
      if (c.active && strength < 1) continue;
      const a = random() * Math.PI * 2;
      const r = random() * 0.05;
      c.p.set(center.x + Math.cos(a) * r, center.y + 0.01, center.z + Math.sin(a) * r);
      // Clods thrown toward the lens stay small and short, so none fill the foreground.
      const towardCamera = Math.max(0, Math.sin(a) * 0.7 + Math.cos(a) * 0.3);
      const out = (0.25 + random() * 0.7) * strength * (1 - towardCamera * 0.6);
      c.v.set(Math.cos(a) * out, (0.9 + random() * 1.5) * strength, Math.sin(a) * out);
      c.spin.set(random() * 9, random() * 9, random() * 9);
      // Mostly crumbs, a few real clods.
      c.size = (0.003 + Math.pow(random(), 3.2) * 0.014) * (1 - towardCamera * 0.45);
      c.aspect.set(0.8 + random() * 0.5, 0.55 + random() * 0.35, 0.8 + random() * 0.5);
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
      s.copy(c.aspect).multiplyScalar(size);
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
