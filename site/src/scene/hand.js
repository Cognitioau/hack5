import * as THREE from 'three';
import { BONE_COUNT, FINGERS, generateHandGeometry, THUMB } from './handSdf.js';
import { zombieSkinMaterial } from './handMaterial.js';

// The rig: forearm along +Y with the wrist at the origin, palm facing +Z, thumb toward -X. The
// shape around it (handSdf.js) is built from these same bones, then skinned to them.
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

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

// The mesh takes a second or so to build at full resolution, so it is built in a module worker
// from the bind pose. If a worker cannot start, the same code runs here instead.
function buildGeometry(rig, cell) {
  const bones = new Float32Array(BONE_COUNT * 16);
  rig.bones.forEach((bone, i) => bones.set(bone.matrixWorld.elements, i * 16));
  const inline = () => generateHandGeometry({ cell, bones });
  const made =
    typeof Worker === 'undefined'
      ? Promise.resolve().then(inline)
      : new Promise((resolve) => {
          let worker;
          try {
            worker = new Worker(new URL('./hand.worker.js', import.meta.url), { type: 'module' });
          } catch {
            resolve(inline());
            return;
          }
          worker.onmessage = (event) => {
            worker.terminate();
            resolve(event.data);
          };
          worker.onerror = (event) => {
            event.preventDefault();
            worker.terminate();
            resolve(inline());
          };
          worker.postMessage({ cell, bones });
        });
  return made.then((data) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(data.skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(data.skinWeight, 4));
    geometry.setAttribute('aMat', new THREE.BufferAttribute(data.material, 4, true));
    geometry.setAttribute('aShade', new THREE.BufferAttribute(data.shading, 4, true));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeBoundingSphere();
    geometry.userData.stats = data.stats;
    return geometry;
  });
}

const GRIP = [1.2, 1.45, 0.95];
// Clawed: knuckles cocked back, the last joints hooked. Each finger curls a little differently
// (index to little finger), so the hand never reads as a symmetrical rig.
const CLAW = [-0.3, 0.62, 0.78];
const CLAW_FINGER = [0.86, 1.0, 1.1, 1.24];
const CLAW_PHASE = [0.0, 2.1, 4.3, 1.2];
const tmpQ = new THREE.Quaternion();

// Resolves once the mesh is built; the returned object is the same as before.
export async function createHand({ cell = 0.0015 } = {}) {
  const rig = buildSkeleton();
  const geometry = await buildGeometry(rig, cell);
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
      // A tremor, plus now and then a sudden spasm that snaps one finger tighter.
      const tremor = Math.sin(time * (17 + i * 5) + i * 1.7) * 0.7 + Math.sin(time * (29.3 + i * 3.1) + CLAW_PHASE[i]) * 0.3;
      const spasm = Math.max(0, Math.sin(time * (1.9 + i * 0.37) + CLAW_PHASE[i])) ** 14;
      const jitter = state.twitch * (tremor * 0.12 + spasm * 0.35) * (1 - state.grip * 0.7);
      const splay = f.spec.splay * (0.4 + state.spread * 1.2);
      f.bones.forEach((b, s) => {
        const claw = CLAW[s] * state.claw * (s === 0 ? 1 : CLAW_FINGER[i]);
        const angle = GRIP[s] * state.grip + claw * (1 - state.grip) + jitter * (s + 1) * 0.5;
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
