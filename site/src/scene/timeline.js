import * as THREE from 'three';
import { heightAt, normalAt } from './world.js';

export const CYCLE = 16;
// Where the hand breaks out, and where the letter waits for it.
export const HOLE = new THREE.Vector2(-0.07, 0.04);
const LETTER_OFFSET = new THREE.Vector2(0.118, 0.072);

const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
const span = (t, a, b) => clamp01((t - a) / (b - a));
const easeOut = (k) => 1 - (1 - k) ** 3;
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const easeOutBack = (k) => {
  const c = 1.9;
  return 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2;
};
const mix = (a, b, k) => a + (b - a) * k;

export function createTimeline({ scene, hand, letter, dirt, world, lightning, rain }) {
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

  const letterHeld = new THREE.Vector3();
  function placeLetterAtRest() {
    scene.attach(letter);
    letter.userData.crumple(0);
    letter.position.copy(restPos);
    letter.quaternion.copy(restQuat);
    letter.visible = true;
  }
  placeLetterAtRest();

  const s = hand.state;
  let last = -1;
  let attached = false;
  let impact = 0;
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
  const letterWorld = new THREE.Vector3();

  // The slap is solved, not keyed: the forearm leans out of the hole toward the letter so the
  // palm lands flat on it with the wrist only gently bent. In the plane of the lean, u runs from
  // the hole toward the letter and v is up; phi is the hand's angle from vertical.
  const scale = hand.mesh.scale.x;
  const PALM = { along: 0.07, out: 0.013 };
  function poseFor(u, v, phi) {
    const wu = u - scale * (PALM.along * Math.sin(phi) + PALM.out * Math.cos(phi));
    const wv = v - scale * (PALM.along * Math.cos(phi) - PALM.out * Math.sin(phi));
    const lean = Math.atan2(wu, wv);
    return { lean, rise: Math.hypot(wu, wv) / scale, pitch: phi - lean };
  }
  const SLAP = poseFor(Math.hypot(LETTER_OFFSET.x, LETTER_OFFSET.y), restPos.y - holeY + 0.003, 1.66);

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
      twist = mix(0.25, twistToLetter, easeInOut(span(t, 5.4, 6.4)));
      leanAngle = mix(0.08, 0.16, w);

      // Wind-up: it sinks back toward the hole, cocks the wrist and spreads its fingers, then
      // holds for a beat, shaking.
      const coil = easeInOut(span(t, 6.35, 6.85));
      s.rise = mix(s.rise, 0.012, coil) + Math.sin(time * 37) * 0.0012 * span(t, 6.7, 7.0);
      leanAngle = mix(leanAngle, -0.12, coil);
      s.pitch = mix(s.pitch, -0.5, coil);
      s.roll = mix(s.roll, 0, coil);
      s.claw = mix(s.claw, 0.1, coil);
      s.spread = mix(0.9, 1.3, coil);
      s.twitch = mix(1, 0.35, coil);

      // Slap: it swings over the crater's lip, accelerating, and lands flat on the letter.
      const slap = span(t, 7.0, 7.16) ** 2;
      s.rise = mix(s.rise, SLAP.rise, slap);
      leanAngle = mix(leanAngle, SLAP.lean, slap);
      s.pitch = mix(s.pitch, SLAP.pitch, slap);
      s.claw = mix(s.claw, 0, slap);
      s.spread = mix(s.spread, 1.15, slap);
      s.twitch = mix(s.twitch, 0.08, slap);
      once('slap', t, 7.16, () => {
        letter.getWorldPosition(letterWorld);
        dirt.burst(letterWorld, { strength: 0.3, share: 0.2 });
        rain.splat(letterWorld, time);
        hand.mesh.updateMatrixWorld(true);
        hand.grip.attach(letter);
        letterHeld.copy(letter.position);
        attached = true;
      });
      // The blow presses it into the mud for a moment.
      const press = Math.sin(Math.PI * span(t, 7.16, 7.34));
      leanAngle += press * 0.035;
      s.claw += press * 0.12;

      // Gather: the fingers curl, crumpling the letter into a fist that lifts off the mud...
      const gather = easeInOut(span(t, 7.3, 7.72));
      s.grip = gather;
      s.rise = mix(s.rise, SLAP.rise - 0.012, gather);
      leanAngle = mix(leanAngle, SLAP.lean - 0.42, gather);
      s.pitch = mix(s.pitch, SLAP.pitch + 0.18, gather);
      s.spread = mix(s.spread, 0.85, gather);
      // ...while the arm is already sliding back down its hole, dragging the fist in after it.
      const pull = easeInOut(span(t, 7.45, 8.7));
      s.rise = mix(s.rise, -0.36, pull);
      leanAngle = mix(leanAngle, 0.06, pull);
      s.pitch = mix(s.pitch, 0.3, pull);
      once('pull', t, 8.0, () => dirt.burst(holeWorld, { strength: 0.45, share: 0.25 }));
      if (attached) {
        letter.userData.crumple(easeInOut(span(t, 7.28, 7.75)));
        letter.position.copy(letterHeld).multiplyScalar(1 - 0.3 * gather);
      }
    }
    // Gone once the fist is under the ground.
    if (attached && t >= 7.6 && letter.visible) {
      letter.getWorldPosition(letterWorld);
      if (letterWorld.y < holeY - 0.03 || t >= 8.9) letter.visible = false;
    }
    // The slap jolts the camera for a moment.
    impact = t >= 7.16 && t < 7.5 ? Math.exp(-(t - 7.16) * 18) : 0;
    if (t >= 9) holeAmount = mix(1, 0.45, easeOut(span(t, 9, 10.5)));
    if (t >= 13) holeAmount = mix(0.45, 0, span(t, 13, 15.5));
    if (t >= 13.5) dirt.setSink(span(t, 13.5, 15.5));

    // A fresh letter flutters down onto the grave.
    if (t >= 11 && t < 13) {
      if (attached) {
        scene.attach(letter);
        letter.userData.crumple(0);
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
    impact: () => impact,
    letterRest: restPos,
  };
}
