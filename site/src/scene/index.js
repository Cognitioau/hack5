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
import { createDirt } from './dirt.js';
import { createHand } from './hand.js';
import { createLetter } from './letter.js';
import { createLightning } from './lightning.js';
import { createRain } from './rain.js';
import { createSky, MOON_DIR } from './sky.js';
import { CYCLE, createTimeline, HOLE } from './timeline.js';
import { createWorld, heightAt } from './world.js';

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
    splashes: low ? 500 : 1400,
    handCell: low ? 0.0032 : 0.0026,
  };
}

async function loadTextures() {
  const loader = new THREE.TextureLoader();
  const load = (name, srgb) =>
    loader.loadAsync(`/textures/${name}.jpg`).then((t) => {
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    });
  const [soil, soilN, grass, grassN, stone, stoneN] = await Promise.all([
    load('forest_ground_04_diff', true),
    load('forest_ground_04_nor', false),
    load('forrest_ground_01_diff', true),
    load('forrest_ground_01_nor', false),
    load('rock_boulder_dry_diff', true),
    load('rock_boulder_dry_nor', false),
  ]);
  return { soil, soilN, grass, grassN, stone, stoneN };
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

  const [textures, fontFamily] = await Promise.all([loadTextures(), loadFont('"IM Fell English"')]);
  const world = createWorld(scene, textures, { lowQuality: quality.low, fontFamily });
  const sky = createSky(scene, FOG);
  const rainScene = new THREE.Scene();
  const rain = createRain(scene, rainScene, { count: quality.rain, splashes: quality.splashes });
  const lightning = createLightning(scene);

  // Moonlight rims everything from behind; a soft cool key keeps the hand readable from the front.
  const moon = new THREE.DirectionalLight(0x9db2e2, 2.6);
  moon.position.copy(MOON_DIR).multiplyScalar(12).add(new THREE.Vector3(0, 2.5, 0));
  moon.target.position.set(0, 0, -0.3);
  moon.castShadow = true;
  moon.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
  Object.assign(moon.shadow.camera, { left: -2.2, right: 2.2, top: 2.2, bottom: -2.2, near: 2, far: 30 });
  moon.shadow.bias = -0.0004;
  moon.shadow.normalBias = 0.015;
  scene.add(moon, moon.target);
  const hemi = new THREE.HemisphereLight(0x33435f, 0x0b0a08, 0.7);
  scene.add(hemi);
  const key = new THREE.SpotLight(0xa9b9da, 4.5, 10, 0.42, 0.85, 1.4);
  key.position.set(1.9, 2.4, 2.6);
  key.target.position.set(HOLE.x, 0.25, HOLE.y);
  key.castShadow = !quality.low;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0005;
  scene.add(key, key.target);

  const hand = createHand({ cell: quality.handCell });
  const letter = createLetter({ fontFamily });
  const dirt = createDirt(scene, textures);
  const timeline = createTimeline({ scene, hand, letter, dirt, world, lightning });

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
  const bloom = new BloomEffect({
    mipmapBlur: true,
    luminanceThreshold: 0.75,
    luminanceSmoothing: 0.2,
    intensity: 1.1,
    radius: 0.75,
  });
  const vignette = new VignetteEffect({ offset: 0.28, darkness: 0.72 });
  const noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
  noise.blendMode.opacity.value = 0.09;
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
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
    hemi.intensity = 0.7 + flash * 2.2;
    scene.fog.color.copy(FOG).multiplyScalar(1 + flash * 2.5);

    if (timeline.handVisible()) hand.grip.getWorldPosition(focusGoal);
    else focusGoal.copy(timeline.letterRest);
    focus.lerp(focusGoal, 1 - Math.exp(-dt * 4));
    dof.target.copy(focus);

    pointerSmooth.lerp(pointer, 1 - Math.exp(-dt * 2));
    camera.position.set(
      cameraBase.x + pointerSmooth.x * 0.09 + Math.sin(time * 0.23) * 0.03,
      cameraBase.y - pointerSmooth.y * 0.04 + Math.sin(time * 0.31) * 0.012,
      cameraBase.z + Math.sin(time * 0.17) * 0.04,
    );
    camera.lookAt(lookBase);
  }

  // Replay from the start so physics and one-off events land exactly as they would live.
  while (time < startAt - 1e-6) step(Math.min(1 / 60, startAt - time));

  let previous = 0;
  // If the machine can't hold ~30 fps, render fewer pixels rather than stutter. The bar sits just
  // under 30 so a screen capped at 30 Hz (battery saver) is not mistaken for a slow GPU.
  let slowFrames = 0;
  let sampled = 0;
  function adapt(rawDt) {
    sampled++;
    if (rawDt > 1 / 28) slowFrames++;
    if (sampled < 90) return;
    const pixelRatio = renderer.getPixelRatio();
    if (slowFrames > 45 && pixelRatio > 0.8) {
      renderer.setPixelRatio(Math.max(0.75, pixelRatio * 0.8));
      resize();
    }
    sampled = 0;
    slowFrames = 0;
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
