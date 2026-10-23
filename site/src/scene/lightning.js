import * as THREE from 'three';
import { mulberry32 } from './noise.js';

// A strike is a few uneven pulses. The bolt is a jagged ribbon far behind the graveyard.
const PULSES = [
  [0.0, 0.05, 1.0],
  [0.09, 0.14, 0.35],
  [0.2, 0.3, 0.85],
  [0.42, 0.62, 0.25],
];

function boltGeometry(rand) {
  const points = [];
  const branch = (start, end, depth, width) => {
    const segments = [start, end];
    for (let level = 0; level < 6; level++) {
      const next = [];
      for (let i = 0; i < segments.length - 1; i++) {
        const a = segments[i];
        const b = segments[i + 1];
        const mid = a.clone().lerp(b, 0.5);
        mid.x += (rand() - 0.5) * a.distanceTo(b) * 0.45;
        next.push(a, mid);
      }
      next.push(segments[segments.length - 1]);
      segments.splice(0, segments.length, ...next);
    }
    for (let i = 0; i < segments.length - 1; i++) {
      points.push({ a: segments[i], b: segments[i + 1], w: width * (1 - i / segments.length) });
      if (depth > 0 && rand() < 0.06) {
        const from = segments[i];
        const to = from.clone().add(new THREE.Vector3((rand() - 0.5) * 30, -15 - rand() * 20, 0));
        branch(from, to, depth - 1, width * 0.45);
      }
    }
  };
  branch(new THREE.Vector3(0, 70, 0), new THREE.Vector3((rand() - 0.5) * 30, -2, 0), 2, 0.9);
  const positions = [];
  for (const { a, b, w } of points) {
    const n = new THREE.Vector3(-(b.y - a.y), b.x - a.x, 0).normalize().multiplyScalar(w / 2);
    positions.push(
      a.x - n.x, a.y - n.y, 0, a.x + n.x, a.y + n.y, 0, b.x + n.x, b.y + n.y, 0,
      a.x - n.x, a.y - n.y, 0, b.x + n.x, b.y + n.y, 0, b.x - n.x, b.y - n.y, 0,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

export function createLightning(scene) {
  // Seeded, so a frozen ?t= frame always shows the same sky.
  const random = mulberry32(4242);
  const light = new THREE.DirectionalLight(0xdfe6ff, 0);
  light.position.set(6, 12, -14);
  scene.add(light);

  const boltMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(4, 4.4, 6),
    transparent: true,
    opacity: 0,
    fog: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const bolt = new THREE.Mesh(new THREE.BufferGeometry(), boltMaterial);
  bolt.frustumCulled = false;
  scene.add(bolt);

  let strikeAt = -Infinity;
  let nextAmbient = 5 + random() * 6;
  let boltX = 0;

  function strike(time) {
    strikeAt = time;
    boltX = (random() - 0.5) * 120;
    bolt.geometry.dispose();
    bolt.geometry = boltGeometry(random);
    bolt.position.set(boltX, 0, -150);
  }

  function flashAt(time) {
    const t = time - strikeAt;
    let f = 0;
    for (const [start, end, peak] of PULSES) {
      if (t >= start && t < end) {
        const k = (t - start) / (end - start);
        f = Math.max(f, peak * (1 - k) * (1 - k));
      }
    }
    return f;
  }

  return {
    strike,
    // Ambient strikes come at irregular intervals; the timeline adds one when the hand breaks out.
    update(time) {
      if (time >= nextAmbient) {
        strike(time);
        nextAmbient = time + 7 + random() * 9;
      }
      const flash = flashAt(time);
      light.intensity = flash * 9;
      boltMaterial.opacity = time - strikeAt < 0.34 ? Math.min(1, flash * 2.5) : 0;
      return { flash, boltDirX: Math.sin(Math.atan2(boltX, 150)) };
    },
    deferAmbient(until) {
      nextAmbient = Math.max(nextAmbient, until);
    },
  };
}
