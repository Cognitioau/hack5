import * as THREE from 'three';
import { heightAt, normalAt } from './world.js';

export const CYCLE = 16;
// Where the hand breaks out, and where the letter waits for it.
export const HOLE = new THREE.Vector2(-0.07, 0.04);
const LETTER_OFFSET = new THREE.Vector2(0.118, 0.072);

const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
const span = (t, a, b) => clamp01((t - a) / (b - a));
const easeOut = (k) => 1 - (1 - k) ** 3;
const easeIn = (k) => k * k * k;
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const easeOutBack = (k) => {
  const c = 1.9;
  return 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2;
};
const mix = (a, b, k) => a + (b - a) * k;

export function createTimeline({ scene, hand, letter, dirt, world, lightning }) {
  const holeY = heightAt(HOLE.x, HOLE.y);
  const pivot = new THREE.Group();
  pivot.position.set(HOLE.x, holeY, HOLE.y);
  const yaw = new THREE.Group();
  const lean = new THREE.Group();
  pivot.add(yaw);
  yaw.add(lean);
  lean.add(hand.mesh);
  scene.add(pivot);

  const restX = HOLE.x + LETTER_OFFSET.x;
  const restZ = HOLE.y + LETTER_OFFSET.y;
  const twistToLetter = Math.atan2(LETTER_OFFSET.x, LETTER_OFFSET.y);
  const restPos = new THREE.Vector3(restX, heightAt(restX, restZ) + 0.004, restZ);
  const restQuat = new THREE.Quaternion()
    .setFromUnitVectors(new THREE.Vector3(0, 1, 0), normalAt(restX, restZ))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.55));

  function placeLetterAtRest() {
    scene.attach(letter);
    letter.position.copy(restPos);
    letter.quaternion.copy(restQuat);
    letter.visible = true;
  }
  placeLetterAtRest();

  const s = hand.state;
  let last = -1;
  let attached = false;
  const fired = new Set();
  const once = (key, t, at, fn) => {
    if (t >= at && !fired.has(key)) {
      fired.add(key);
      fn();
    }
  };
  const holeWorld = new THREE.Vector3(HOLE.x, holeY, HOLE.y);
  const fallQ = new THREE.Quaternion();
  const fallE = new THREE.Euler();

  function update(t, time) {
    if (t < last) {
      fired.clear();
      attached = false;
      placeLetterAtRest();
      dirt.setSink(1);
      dirt.setSink(0);
    }
    last = t;

    // Underground and waiting.
    s.rise = -0.34;
    s.grip = 0;
    s.claw = 0.8;
    s.spread = 0.9;
    s.pitch = 0;
    s.yaw = 0;
    s.roll = 0;
    s.twitch = 0;
    let twist = 0.25;
    let leanAngle = 0.08;
    let holeAmount = 0;
    let tremble = 0;

    if (t >= 3.2 && t < 4.4) {
      tremble = span(t, 3.2, 4.2);
      once('hop', t, 3.8, () => dirt.burst(holeWorld, { strength: 0.25, share: 0.15 }));
    }
    once('strike', t, 4.32, () => {
      lightning.strike(time);
      lightning.deferAmbient(time + 6);
    });
    once('burst', t, 4.4, () => dirt.burst(holeWorld, { strength: 1, share: 0.75 }));

    if (t >= 4.4) holeAmount = easeOut(span(t, 4.4, 4.55));
    if (t >= 4.4 && t < 9.2) {
      const rise = easeOutBack(span(t, 4.4, 4.9));
      s.rise = mix(-0.34, 0.1, rise);
      s.twitch = 1;
      // Searching: the wrist rolls and the fingers flex while it gets its bearings.
      const w = span(t, 4.9, 6.4);
      s.rise += Math.sin(t * 5.3) * 0.006 * w;
      s.roll = Math.sin(t * 2.6) * 0.32 * w;
      s.pitch = Math.sin(t * 3.4 + 1) * 0.18 * w;
      s.claw = 0.8 + Math.sin(t * 6.1) * 0.15 * w;
      twist = mix(0.25, twistToLetter, easeInOut(span(t, 5.4, 6.5)));
      leanAngle = mix(0.08, 0.16, w);

      // Reach over the letter, open wide, and close on it.
      const reach = easeInOut(span(t, 6.4, 7.2));
      s.rise = mix(s.rise, 0.08, reach);
      leanAngle = mix(leanAngle, 0.6, reach);
      s.pitch = mix(s.pitch, 1.2, reach);
      s.roll = mix(s.roll, 0, reach);
      s.spread = mix(0.9, 1.1, reach);
      s.claw = mix(s.claw, 0.25, reach);
      const grip = easeIn(span(t, 7.2, 7.45));
      s.grip = grip;
      s.twitch = mix(1, 0.2, reach);
      once('attach', t, 7.33, () => {
        hand.mesh.updateMatrixWorld(true);
        hand.grip.attach(letter);
        attached = true;
      });

      // Lift it, then drag it under.
      const lift = easeInOut(span(t, 7.5, 8.1));
      leanAngle = mix(leanAngle, 0.22, lift);
      s.pitch = mix(s.pitch, 0.45, lift);
      s.rise = mix(s.rise, 0.1, lift);
      const sink = easeIn(span(t, 8.1, 9.0));
      s.rise = mix(s.rise, -0.36, sink);
      leanAngle = mix(leanAngle, 0.02, sink);
      once('pull', t, 8.3, () => dirt.burst(holeWorld, { strength: 0.45, share: 0.25 }));
    }
    once('buried', t, 9.05, () => {
      letter.visible = false;
    });
    if (t >= 9) holeAmount = mix(1, 0.45, easeOut(span(t, 9, 10.5)));
    if (t >= 13) holeAmount = mix(0.45, 0, span(t, 13, 15.5));
    if (t >= 13.5) dirt.setSink(span(t, 13.5, 15.5));

    // A fresh letter flutters down onto the grave.
    if (t >= 11 && t < 13) {
      if (attached) {
        scene.attach(letter);
        attached = false;
      }
      letter.visible = true;
      const k = span(t, 11, 13);
      const e = easeOut(k);
      const sway = Math.sin(k * Math.PI * 3.2) * (1 - e);
      letter.position.set(
        restPos.x + 0.22 * (1 - e) + sway * 0.12,
        restPos.y + 1.35 * (1 - easeInOut(k)),
        restPos.z - 0.08 * (1 - e),
      );
      fallE.set(sway * 0.7, (1 - e) * 2.4, Math.cos(k * Math.PI * 3.2) * 0.45 * (1 - e));
      fallQ.setFromEuler(fallE);
      letter.quaternion.copy(restQuat).multiply(fallQ);
    }
    once('landed', t, 13, placeLetterAtRest);

    // The letter shivers as the ground starts to move.
    if (!attached && t < 4.4 && tremble > 0) {
      letter.position.y = restPos.y + Math.abs(Math.sin(time * 41)) * 0.003 * tremble;
    }

    yaw.rotation.y = twist;
    lean.rotation.x = leanAngle;
    world.uniforms.uHole.value.set(HOLE.x, HOLE.y, holeAmount, 0);
    world.uniforms.uTremble.value = tremble;
    hand.apply(time);
  }

  return {
    update,
    handVisible: () => s.rise > -0.12,
    letterRest: restPos,
  };
}
