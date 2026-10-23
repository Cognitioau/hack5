import * as THREE from 'three';
import { NOISE_GLSL } from './noise.js';
import { surfaceNets } from './surfaceNets.js';

// Rest pose, in metres: forearm along +Y with the wrist at the origin, palm facing +Z, thumb
// toward -X. The fingers are a little long and the joints knobbly, because it has been buried.
const FINGERS = [
  { base: [-0.03, 0.094, -0.002], len: [0.052, 0.031, 0.025], r: 0.0102, splay: 0.13 },
  { base: [-0.0095, 0.1, -0.002], len: [0.057, 0.034, 0.027], r: 0.0106, splay: 0.03 },
  { base: [0.011, 0.097, -0.002], len: [0.054, 0.032, 0.026], r: 0.0101, splay: -0.08 },
  { base: [0.029, 0.088, -0.002], len: [0.043, 0.025, 0.023], r: 0.009, splay: -0.2 },
];
const THUMB = {
  base: [-0.022, 0.02, 0.006],
  dir: [-0.6, 0.66, 0.42],
  toward: [0.55, 0.45, 0.7],
  len: [0.044, 0.035, 0.03],
  r: 0.0128,
};
const FOREARM_BOTTOM = -0.46;
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// Capsule whose radius runs linearly from ra at a to rb at b.
function taper(a, b, ra, rb) {
  const bax = b.x - a.x;
  const bay = b.y - a.y;
  const baz = b.z - a.z;
  const bb = bax * bax + bay * bay + baz * baz;
  return (x, y, z) => {
    const pax = x - a.x;
    const pay = y - a.y;
    const paz = z - a.z;
    const h = Math.min(Math.max((pax * bax + pay * bay + paz * baz) / bb, 0), 1);
    const dx = pax - bax * h;
    const dy = pay - bay * h;
    const dz = paz - baz * h;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) - (ra + (rb - ra) * h);
  };
}

function sphere(c, r) {
  return (x, y, z) => Math.hypot(x - c.x, y - c.y, z - c.z) - r;
}

// Ellipsoid in a bone-aligned frame (approximate distance, fine for meshing).
function ellipsoid(matrixWorld, offset, radii) {
  const inv = new THREE.Matrix4().copy(matrixWorld).invert().elements;
  const m = Math.min(radii[0], radii[1], radii[2]);
  return (x, y, z) => {
    const lx = inv[0] * x + inv[4] * y + inv[8] * z + inv[12] - offset[0];
    const ly = inv[1] * x + inv[5] * y + inv[9] * z + inv[13] - offset[1];
    const lz = inv[2] * x + inv[6] * y + inv[10] * z + inv[14] - offset[2];
    return (Math.hypot(lx / radii[0], ly / radii[1], lz / radii[2]) - 1) * m;
  };
}

function boxRound(c, half, r) {
  return (x, y, z) => {
    const qx = Math.abs(x - c[0]) - half[0] + r;
    const qy = Math.abs(y - c[1]) - half[1] + r;
    const qz = Math.abs(z - c[2]) - half[2] + r;
    const ox = Math.max(qx, 0);
    const oy = Math.max(qy, 0);
    const oz = Math.max(qz, 0);
    return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
  };
}

function buildSkeleton() {
  const arm = new THREE.Bone();
  arm.name = 'arm';
  const hand = new THREE.Bone();
  hand.name = 'hand';
  arm.add(hand);
  const bones = [arm, hand];
  const fingers = [];

  for (const f of FINGERS) {
    const b0 = new THREE.Bone();
    b0.position.fromArray(f.base);
    b0.rotation.order = 'ZYX';
    b0.rotation.z = f.splay;
    hand.add(b0);
    const b1 = new THREE.Bone();
    b1.position.set(0, f.len[0], 0);
    b0.add(b1);
    const b2 = new THREE.Bone();
    b2.position.set(0, f.len[1], 0);
    b1.add(b2);
    bones.push(b0, b1, b2);
    fingers.push({ bones: [b0, b1, b2], spec: f, rest: b0.quaternion.clone() });
  }

  // The thumb's frame: +Y along the thumb, +Z the way it folds across the palm.
  const dir = new THREE.Vector3().fromArray(THUMB.dir).normalize();
  const toward = new THREE.Vector3().fromArray(THUMB.toward).normalize();
  const zAxis = toward.clone().sub(dir.clone().multiplyScalar(toward.dot(dir))).normalize();
  const xAxis = new THREE.Vector3().crossVectors(dir, zAxis);
  const basis = new THREE.Matrix4().makeBasis(xAxis, dir, zAxis);
  const t0 = new THREE.Bone();
  t0.position.fromArray(THUMB.base);
  t0.quaternion.setFromRotationMatrix(basis);
  hand.add(t0);
  const t1 = new THREE.Bone();
  t1.position.set(0, THUMB.len[0], 0);
  t0.add(t1);
  const t2 = new THREE.Bone();
  t2.position.set(0, THUMB.len[1], 0);
  t1.add(t2);
  bones.push(t0, t1, t2);
  const thumb = { bones: [t0, t1, t2], spec: THUMB, rest: t0.quaternion.clone() };

  arm.updateMatrixWorld(true);
  return { arm, hand, bones, fingers, thumb };
}

// Every primitive belongs to one bone; that ownership becomes the skin weights.
function buildPrimitives(rig) {
  const { arm, hand, bones, fingers, thumb } = rig;
  const index = (bone) => bones.indexOf(bone);
  const prims = [];
  const add = (owner, fn, aabb, nail = false) => prims.push({ owner: index(owner), fn, aabb, nail });
  const boxAround = (points, r) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of points) {
      min[0] = Math.min(min[0], p.x - r);
      min[1] = Math.min(min[1], p.y - r);
      min[2] = Math.min(min[2], p.z - r);
      max[0] = Math.max(max[0], p.x + r);
      max[1] = Math.max(max[1], p.y + r);
      max[2] = Math.max(max[2], p.z + r);
    }
    return { min, max };
  };
  const world = (bone, x = 0, y = 0, z = 0) => bone.localToWorld(new THREE.Vector3(x, y, z));

  // Forearm: slightly flattened front to back, thinning to a bony wrist.
  const elbow = new THREE.Vector3(0, FOREARM_BOTTOM, 0);
  const wrist = new THREE.Vector3(0, -0.012, 0);
  const forearm = taper(elbow, wrist, 0.035, 0.026);
  add(arm, (x, y, z) => forearm(x, y, z * 1.22), boxAround([elbow, wrist], 0.04));
  const ulna = new THREE.Vector3(0.019, -0.016, -0.006);
  add(arm, sphere(ulna, 0.0085), boxAround([ulna], 0.0085));
  const tendon = taper(new THREE.Vector3(0, -0.2, -0.012), new THREE.Vector3(0, -0.03, -0.01), 0.009, 0.007);
  add(arm, tendon, boxAround([new THREE.Vector3(0, -0.2, -0.012), wrist], 0.02));

  // Palm: a thin slab with the metacarpals standing proud on the back of the hand.
  add(hand, boxRound([0, 0.052, 0.003], [0.035, 0.037, 0.0105], 0.008), {
    min: [-0.04, 0.01, -0.01],
    max: [0.04, 0.095, 0.016],
  });
  for (const f of fingers) {
    const knuckle = world(f.bones[0]);
    const root = new THREE.Vector3(knuckle.x * 0.45, 0.008, -0.004);
    add(hand, taper(root, knuckle, 0.0085, f.spec.r * 1.05), boxAround([root, knuckle], 0.012));
  }
  const thenarFrame = new THREE.Matrix4().makeRotationZ(0.5);
  add(hand, ellipsoid(thenarFrame, [-0.003, 0.036, 0.009], [0.016, 0.024, 0.011]), {
    min: [-0.045, 0.0, -0.01],
    max: [0.01, 0.065, 0.025],
  });

  // Digits: tapered phalanges, bony joint knobs and a split, overgrown nail on each tip.
  const digits = [...fingers, thumb];
  for (const d of digits) {
    const isThumb = d === thumb;
    const radii = isThumb
      ? [d.spec.r, d.spec.r * 0.92, d.spec.r * 0.84, d.spec.r * 0.74]
      : [d.spec.r, d.spec.r * 0.86, d.spec.r * 0.76, d.spec.r * 0.66];
    const joints = [world(d.bones[0]), world(d.bones[1]), world(d.bones[2]), world(d.bones[2], 0, d.spec.len[2], 0)];
    for (let s = 0; s < 3; s++) {
      const owner = d.bones[s];
      add(owner, taper(joints[s], joints[s + 1], radii[s], radii[s + 1]), boxAround([joints[s], joints[s + 1]], radii[s] + 0.002));
      if (s > 0 || !isThumb) {
        const knob = joints[s];
        add(owner, sphere(knob, radii[s] * 1.14), boxAround([knob], radii[s] * 1.14));
      }
    }
    const tip = d.bones[2];
    const len = d.spec.len[2];
    const nailR = radii[3];
    add(
      tip,
      ellipsoid(tip.matrixWorld, [0, len * 0.72, -nailR * 0.62], [nailR * 0.92, len * 0.46, nailR * 0.34]),
      boxAround([world(tip, 0, len * 0.72, 0)], len * 0.6),
      true,
    );
  }
  return prims;
}

function bounds(prims, margin) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], p.aabb.min[a] - margin);
      max[a] = Math.max(max[a], p.aabb.max[a] + margin);
    }
  }
  return { min, max };
}

function buildGeometry(rig, cell) {
  const prims = buildPrimitives(rig);
  const K = 0.0055;
  const margin = K + cell * 2;
  const { min, max } = bounds(prims, margin);

  // Bucket primitives into horizontal bands so most samples test only a few of them.
  const BAND = 0.02;
  const bandCount = Math.ceil((max[1] - min[1]) / BAND) + 1;
  const bands = Array.from({ length: bandCount }, () => []);
  for (const p of prims) {
    const lo = Math.max(0, Math.floor((p.aabb.min[1] - margin - min[1]) / BAND));
    const hi = Math.min(bandCount - 1, Math.floor((p.aabb.max[1] + margin - min[1]) / BAND));
    for (let b = lo; b <= hi; b++) bands[b].push(p);
  }
  const inBox = (p, x, y, z) =>
    x >= p.aabb.min[0] - margin &&
    x <= p.aabb.max[0] + margin &&
    z >= p.aabb.min[2] - margin &&
    z <= p.aabb.max[2] + margin;

  const sdf = (x, y, z) => {
    const band = bands[Math.floor((y - min[1]) / BAND)];
    let skin = 1;
    let nail = 1;
    if (!band) return 1;
    for (const p of band) {
      if (!inBox(p, x, y, z)) continue;
      const d = p.fn(x, y, z);
      if (p.nail) nail = Math.min(nail, d);
      else skin = smin(skin, d, K);
    }
    return smin(skin, nail, 0.0018);
  };

  const mesh = surfaceNets(sdf, min, max, cell);
  const { positions, indices } = mesh;
  const count = positions.length / 3;
  const normals = new Float32Array(count * 3);
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const nailAttr = new Float32Array(count);
  const e = cell * 0.5;
  const boneCount = rig.bones.length;
  const boneDist = new Float32Array(boneCount);
  const order = new Array(boneCount);

  for (let v = 0; v < count; v++) {
    let x = positions[v * 3];
    let y = positions[v * 3 + 1];
    let z = positions[v * 3 + 2];
    // One Newton step pulls the vertex onto the true surface.
    let gx = sdf(x + e, y, z) - sdf(x - e, y, z);
    let gy = sdf(x, y + e, z) - sdf(x, y - e, z);
    let gz = sdf(x, y, z + e) - sdf(x, y, z - e);
    let gl = Math.hypot(gx, gy, gz) || 1;
    const d = sdf(x, y, z);
    x -= (d * gx) / gl;
    y -= (d * gy) / gl;
    z -= (d * gz) / gl;
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    gx = sdf(x + e, y, z) - sdf(x - e, y, z);
    gy = sdf(x, y + e, z) - sdf(x, y - e, z);
    gz = sdf(x, y, z + e) - sdf(x, y, z - e);
    gl = Math.hypot(gx, gy, gz) || 1;
    normals[v * 3] = gx / gl;
    normals[v * 3 + 1] = gy / gl;
    normals[v * 3 + 2] = gz / gl;

    boneDist.fill(Infinity);
    let skinD = Infinity;
    let nailD = Infinity;
    for (const p of prims) {
      const dist = p.fn(x, y, z);
      if (dist < boneDist[p.owner]) boneDist[p.owner] = dist;
      if (p.nail) nailD = Math.min(nailD, dist);
      else skinD = Math.min(skinD, dist);
    }
    nailAttr[v] = nailD < skinD + 0.0004 ? 1 : 0;
    for (let b = 0; b < boneCount; b++) order[b] = b;
    order.sort((a, b) => boneDist[a] - boneDist[b]);
    const nearest = boneDist[order[0]];
    let sum = 0;
    for (let w = 0; w < 4; w++) {
      const b = order[w];
      const weight = Math.exp(-Math.max(boneDist[b] - nearest, 0) / 0.0042);
      skinIndex[v * 4 + w] = b;
      skinWeight[v * 4 + w] = weight;
      sum += weight;
    }
    for (let w = 0; w < 4; w++) skinWeight[v * 4 + w] /= sum;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  geometry.setAttribute('aNail', new THREE.BufferAttribute(nailAttr, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

function zombieSkinMaterial() {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aNail;\nvarying vec3 vRest;\nvarying float vNail;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = position;\nvNail = aNail;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vRest;\nvarying float vNail;\n${NOISE_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float zMottle = zbFbm(vRest * 55.0);
        float zFine = zbFbm(vRest * 210.0);
        float zVein = 1.0 - smoothstep(0.0, 0.05, abs(zbNoise(vRest * vec3(95.0, 28.0, 95.0)) - 0.5));
        vec3 zSkin = mix(vec3(0.30, 0.33, 0.26), vec3(0.47, 0.47, 0.40), zMottle);
        zSkin = mix(zSkin, vec3(0.30, 0.20, 0.26), smoothstep(0.55, 0.78, zbFbm(vRest * 22.0 + 3.0)) * 0.75);
        zSkin = mix(zSkin, vec3(0.16, 0.13, 0.17), zVein * 0.45);
        float zDirt = (1.0 - smoothstep(-0.12, 0.0, vRest.y)) * (0.55 + 0.45 * zbFbm(vRest * 30.0))
          + smoothstep(0.58, 0.8, zbFbm(vRest * 38.0 + 7.0)) * 0.65
          + smoothstep(0.15, 0.2, vRest.y) * 0.45;
        zSkin = mix(zSkin, vec3(0.10, 0.075, 0.05), clamp(zDirt, 0.0, 1.0) * mix(0.55, 1.0, zFine));
        vec3 zNailCol = mix(vec3(0.34, 0.29, 0.17), vec3(0.09, 0.07, 0.05), smoothstep(0.35, 0.7, zFine));
        diffuseColor.rgb = mix(zSkin, zNailCol, vNail);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.58, 0.32, vNail) - zFine * 0.12;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        float zWrinkle = zbNoise(vRest * vec3(520.0, 70.0, 520.0));
        float zHeight = zFine * 0.0009 + zWrinkle * 0.00035 + zVein * 0.0003;
        normal = zbPerturb(-vViewPosition, normal, zHeight * (1.0 - vNail * 0.8), faceDirection);`,
      );
  };
  return material;
}

const GRIP = [1.2, 1.45, 0.95];
const CLAW = [-0.3, 0.6, 0.65];
const tmpQ = new THREE.Quaternion();

export function createHand({ cell = 0.0026 } = {}) {
  const rig = buildSkeleton();
  const geometry = buildGeometry(rig, cell);
  const skeleton = new THREE.Skeleton(rig.bones);
  const mesh = new THREE.SkinnedMesh(geometry, zombieSkinMaterial());
  mesh.add(rig.arm);
  mesh.bind(skeleton);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  mesh.scale.setScalar(1.12);

  // Where a held letter sits: just inside the curled fingers.
  const grip = new THREE.Object3D();
  grip.position.set(0.002, 0.098, 0.024);
  rig.hand.add(grip);

  const state = {
    rise: 0,
    grip: 0,
    claw: 0.6,
    spread: 0.6,
    pitch: 0,
    yaw: 0,
    roll: 0,
    twitch: 0,
  };

  function apply(time = 0) {
    rig.arm.position.y = state.rise;
    rig.hand.rotation.set(state.pitch, state.yaw, state.roll);
    rig.fingers.forEach((f, i) => {
      const jitter = state.twitch * Math.sin(time * (17 + i * 5) + i * 1.7) * 0.12;
      const splay = f.spec.splay * (0.4 + state.spread * 1.2);
      f.bones.forEach((b, s) => {
        const angle = GRIP[s] * state.grip + CLAW[s] * state.claw * (1 - state.grip) + jitter * (s + 1) * 0.5;
        if (s === 0) {
          b.quaternion.setFromAxisAngle(Z_AXIS, splay).multiply(tmpQ.setFromAxisAngle(X_AXIS, angle));
        } else {
          b.quaternion.setFromAxisAngle(X_AXIS, angle);
        }
      });
    });
    const [t0, t1, t2] = rig.thumb.bones;
    const thumbJitter = state.twitch * Math.sin(time * 13.0) * 0.1;
    t0.quaternion
      .copy(rig.thumb.rest)
      .multiply(tmpQ.setFromAxisAngle(X_AXIS, 0.45 * state.grip - 0.15 * state.spread));
    t1.quaternion.setFromAxisAngle(X_AXIS, 0.75 * state.grip + 0.2 * state.claw + thumbJitter);
    t2.quaternion.setFromAxisAngle(X_AXIS, 0.8 * state.grip + 0.45 * state.claw * (1 - state.grip));
  }
  apply();

  return { mesh, arm: rig.arm, palm: rig.hand, grip, state, apply };
}
