import {
  BloomEffect,
  BlendFunction,
  DepthOfFieldEffect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import * as THREE from 'three';
import { loadAssets } from './assets.js';
import { createDirt } from './dirt.js';
import { createHand } from './hand.js';
import { createLetter } from './letter.js';
import { createLightning } from './lightning.js';
import { createRain } from './rain.js';
import { createSky, MOON_DIR } from './sky.js';
import { CYCLE, createTimeline, HOLE } from './timeline.js';
import { createWorld, GLOW_COLOR, heightAt } from './world.js';

const FOG = new THREE.Color(0.034, 0.042, 0.058);

function pickQuality() {
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const low = small || coarse || (navigator.hardwareConcurrency ?? 8) <= 4;
  return {
    low,
    dpr: low ? 1.25 : 1.75,
    shadows: true,
    shadowSize: low ? 1024 : 2048,
    multisampling: low ? 0 : 4,
    rain: low ? 3000 : 6500,
    splashes: low ? 900 : 2400,
    handCell: low ? 0.0024 : 0.0015,
  };
}

async function loadFont(family) {
  try {
    await document.fonts.load(`48px ${family}`);
    await document.fonts.load(`italic 32px ${family}`);
  } catch {
    // The canvas falls back to the serif stack below.
  }
  return `${family}, Georgia, 'Times New Roman', serif`;
}

export async function startScene(canvas, { startAt = 0, paused: initiallyPaused = false, openBand, onReady } = {}) {
  const quality = pickQuality();
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    stencil: false,
    depth: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.dpr));
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;

  const scene = new THREE.Scene();
  scene.background = FOG;
  scene.fog = new THREE.FogExp2(FOG, 0.085);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 400);

  // The hand is meshed in a worker while the textures and models download.
  const [textures, fontFamily, hand] = await Promise.all([
    loadAssets(renderer, { low: quality.low }),
    loadFont('"IM Fell English"'),
    createHand({ cell: quality.handCell }),
  ]);
  const world = createWorld(scene, textures, { lowQuality: quality.low, fontFamily });
  const rainScene = new THREE.Scene();
  const sky = createSky(scene, FOG, rainScene);
  // Wet soil, puddles and stone pick up the moonlit sky from a prefiltered copy of it.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(sky.mesh.geometry, sky.mesh.material));
  scene.environment = pmrem.fromScene(envScene, 0.02, 0.1, 1000).texture;
  pmrem.dispose();
  const rain = createRain(scene, rainScene, { count: quality.rain, splashes: quality.splashes, hole: HOLE });
  const lightning = createLightning(scene);

  // Moonlight rims everything from behind; a soft cool key keeps the hand readable from the front.
  const moon = new THREE.DirectionalLight(0xa9bde8, 3.6);
  moon.position.copy(MOON_DIR).multiplyScalar(12).add(new THREE.Vector3(0, 2.5, 0));
  moon.target.position.set(0, 0, -0.3);
  moon.castShadow = true;
  moon.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
  Object.assign(moon.shadow.camera, { left: -2.2, right: 2.2, top: 2.2, bottom: -2.2, near: 2, far: 30 });
  moon.shadow.bias = -0.0004;
  moon.shadow.normalBias = 0.015;
  scene.add(moon, moon.target);
  const hemi = new THREE.HemisphereLight(0x2c3b56, 0x0a0907, 0.45);
  scene.add(hemi);
  // A hard cool rim from behind the grave, low enough to edge the hand, the clods and the stone.
  const rim = new THREE.SpotLight(0xb4c8ff, 6, 8, 0.5, 0.6, 1.2);
  rim.position.set(-1.2, 1.1, -2.6);
  rim.target.position.set(HOLE.x, 0.15, HOLE.y);
  scene.add(rim, rim.target);
  // The grave's own light: faint at rest, flaring when the hand breaks the surface.
  const glow = new THREE.PointLight(GLOW_COLOR, 0, 1.4, 2);
  glow.position.set(HOLE.x + 0.01, heightAt(HOLE.x, HOLE.y) + 0.01, HOLE.y - 0.08);
  scene.add(glow);
  // Moonlight rakes across the headstone's face so the carving casts its own shade.
  const rake = new THREE.SpotLight(0x9fb3dc, 7, 6, 0.38, 0.7, 1.2);
  rake.position.set(-1.35, 1.75, -0.65);
  rake.target.position.set(0.05, 0.55, -1.36);
  scene.add(rake, rake.target);
  const key = new THREE.SpotLight(0xa9b9da, 2.6, 10, 0.42, 0.85, 1.4);
  key.position.set(1.9, 2.4, 2.6);
  key.target.position.set(HOLE.x, 0.25, HOLE.y);
  key.castShadow = !quality.low;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0005;
  scene.add(key, key.target);

  const letter = createLetter({ fontFamily });
  const dirt = createDirt(scene, textures);
  const timeline = createTimeline({ scene, hand, letter, dirt, world, lightning, rain });

  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: quality.multisampling,
  });
  composer.addPass(new RenderPass(scene, camera));
  const dof = new DepthOfFieldEffect(camera, {
    focusDistance: 2,
    focusRange: 0.8,
    bokehScale: quality.low ? 2.4 : 3.2,
    resolutionScale: quality.low ? 0.5 : 0.75,
  });
  dof.target = new THREE.Vector3(HOLE.x, 0.2, HOLE.y);
  composer.addPass(new EffectPass(camera, dof));
  // Rain is drawn after depth of field: thin streaks smeared by the background's blur vanish.
  const rainPass = new RenderPass(rainScene, camera);
  rainPass.clearPass.enabled = false;
  rainPass.ignoreBackground = true;
  rainPass.skipShadowMapUpdate = true;
  composer.addPass(rainPass);
  // The threshold sits above the moon's disc so only the grave's green and the lightning bloom hard.
  const bloom = new BloomEffect({
    mipmapBlur: true,
    luminanceThreshold: 0.9,
    luminanceSmoothing: 0.25,
    intensity: 1.35,
    radius: 0.78,
  });
  const vignette = new VignetteEffect({ offset: 0.28, darkness: 0.72 });
  const noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
  noise.blendMode.opacity.value = 0.09;
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
  composer.addPass(new EffectPass(camera, bloom, vignette, toneMapping, noise));

  const cameraBase = new THREE.Vector3();
  const lookBase = new THREE.Vector3();
  // The hand plays out around this point, halfway between its raised fist and the letter.
  const action = new THREE.Vector3(HOLE.x + 0.05, heightAt(HOLE.x, HOLE.y) + 0.14, HOLE.y + 0.03);
  const projected = new THREE.Vector3();
  let paused = false;
  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    const aspect = w / h;
    camera.aspect = aspect;
    // Portrait screens pull the camera back and widen the lens so the whole grave stays in frame.
    const portrait = THREE.MathUtils.clamp(1 - aspect, 0, 0.6);
    camera.fov = 30 + portrait * 34;
    cameraBase.set(0.46 + portrait * 0.05, 0.36 + portrait * 0.25, 1.3 + portrait * 0.75);
    // Landscape keeps the hand right of the hero copy; portrait centres it above the copy.
    lookBase.set(-0.3 + portrait * 0.36, 0.3 - portrait * 0.36, -0.1);
    camera.clearViewOffset();
    // On a portrait screen the copy fills the bottom of the frame, so slide the picture until the
    // hand sits in the open band between the nav and the copy.
    const band = openBand?.();
    if (aspect < 0.9 && band && band.bottom > band.top) {
      camera.position.copy(cameraBase);
      camera.lookAt(lookBase);
      camera.updateMatrixWorld();
      projected.copy(action).project(camera);
      const y = ((1 - projected.y) / 2) * h;
      const shift = THREE.MathUtils.clamp(y - (band.top + band.bottom) / 2, -0.3 * h, 0.3 * h);
      camera.setViewOffset(w, h, 0, shift, w, h);
    }
    renderer.setSize(w, h, false);
    composer.setSize(w, h, false);
    rain.uniforms.uViewHeight.value = h * renderer.getPixelRatio();
    // A resize clears the canvas, so a paused scene has to draw its frame again.
    if (paused) composer.render(0);
  }
  resize();
  window.addEventListener('resize', resize);
  // The copy reflows once its web fonts arrive, which moves the open band.
  document.fonts?.ready.then(resize);

  const pointer = new THREE.Vector2();
  const pointerSmooth = new THREE.Vector2();
  window.addEventListener('pointermove', (e) => {
    pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  });

  const focus = new THREE.Vector3().copy(timeline.letterRest);
  const focusGoal = new THREE.Vector3();
  let time = 0;
  let glowLevel = 0.1;

  function step(dt) {
    time += dt;
    const t = time % CYCLE;
    timeline.update(t, time);
    dirt.update(dt);
    const { flash, boltDirX } = lightning.update(time);
    sky.uniforms.uTime.value = time;
    sky.uniforms.uFlash.value = flash;
    sky.uniforms.uBoltX.value = boltDirX;
    rain.uniforms.uTime.value = time;
    rain.uniforms.uFlash.value = flash;
    world.uniforms.uTime.value = time;
    // Glow follows the crater: a trembling build-up, a flare while the hand is out, embers after.
    const crater = world.uniforms.uHole.value.z;
    const goal = Math.max(
      0.1 + world.uniforms.uTremble.value * 0.35,
      crater * (timeline.handVisible() ? 1 : 0.3),
    );
    glowLevel += (goal - glowLevel) * (1 - Math.exp(-dt * (goal > glowLevel ? 14 : 2.5)));
    const flicker = 1 + 0.12 * Math.sin(time * 23.0) * Math.sin(time * 7.3 + 1.1) + 0.06 * Math.sin(time * 51.0);
    world.uniforms.uGlow.value = glowLevel * flicker;
    rain.uniforms.uHoleGlow.value.z = glowLevel * flicker;
    glow.intensity = 0.004 + glowLevel * flicker * 0.06;
    hemi.intensity = 0.45 + flash * 2.2;
    scene.fog.color.copy(FOG).multiplyScalar(1 + flash * 2.5);

    if (timeline.handVisible()) hand.grip.getWorldPosition(focusGoal);
    else focusGoal.copy(timeline.letterRest);
    focus.lerp(focusGoal, 1 - Math.exp(-dt * 4));
    dof.target.copy(focus);

    pointerSmooth.lerp(pointer, 1 - Math.exp(-dt * 2));
    const jolt = timeline.impact() * 0.006;
    camera.position.set(
      cameraBase.x + pointerSmooth.x * 0.09 + Math.sin(time * 0.23) * 0.03 + Math.sin(time * 71) * jolt,
      cameraBase.y - pointerSmooth.y * 0.04 + Math.sin(time * 0.31) * 0.012 - jolt,
      cameraBase.z + Math.sin(time * 0.17) * 0.04,
    );
    camera.lookAt(lookBase);
  }

  // Replay from the start so physics and one-off events land exactly as they would live.
  while (time < startAt - 1e-6) step(Math.min(1 / 60, startAt - time));

  let previous = 0;
  // If the machine can't hold ~30 fps, render fewer pixels rather than stutter. The bar sits just
  // under 30 so a screen capped at 30 Hz (battery saver) is not mistaken for a slow GPU. When the
  // slowdown passes (a busy tab, a screen recorder), the resolution climbs back; a step up that
  // proves too slow becomes the ceiling, so it never see-saws.
  let ceiling = renderer.getPixelRatio();
  let raised = false;
  let slowFrames = 0;
  let fastFrames = 0;
  let sampled = 0;
  function adapt(rawDt) {
    sampled++;
    if (rawDt > 1 / 28) slowFrames++;
    else if (rawDt < 1 / 50) fastFrames++;
    if (sampled < 90) return;
    const pixelRatio = renderer.getPixelRatio();
    if (slowFrames > 45 && pixelRatio > 0.8) {
      if (raised) ceiling = pixelRatio * 0.8;
      renderer.setPixelRatio(Math.max(0.75, pixelRatio * 0.8));
      raised = false;
      resize();
    } else if (fastFrames > 85 && pixelRatio < ceiling - 1e-3) {
      renderer.setPixelRatio(Math.min(ceiling, pixelRatio / 0.8));
      raised = true;
      resize();
    } else {
      raised = false;
    }
    sampled = 0;
    slowFrames = 0;
    fastFrames = 0;
  }
  function frame(now) {
    const rawDt = (now - previous) / 1000;
    const dt = Math.min(rawDt, 1 / 20);
    previous = now;
    adapt(rawDt);
    step(dt);
    composer.render(dt);
  }
  function setPaused(value) {
    paused = value;
    if (paused) {
      renderer.setAnimationLoop(null);
      composer.render(0);
    } else {
      previous = performance.now();
      renderer.setAnimationLoop(frame);
    }
  }
  setPaused(initiallyPaused);
  onReady?.();
  return { setPaused, paused: () => paused };
}
