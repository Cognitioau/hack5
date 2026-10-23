import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { MOON_DIR } from './sky.js';
import { heightAt } from './world.js';

// The ground under the splashes, baked once so a splash can land anywhere on it.
const GROUND = { x: -2.6, z: -3.4, size: 4.6, cells: 128 };
// Each splash is an impact glint and a crown of droplets thrown up off the mud.
const DROPLETS = 5;
// The slap throws one big splash of its own.
const SPLAT_DROPLETS = 48;

function bakeGround() {
  const { x, z, size, cells } = GROUND;
  const data = new Uint16Array(cells * cells);
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const h = heightAt(x + (size * i) / (cells - 1), z + (size * j) / (cells - 1));
      data[j * cells + i] = THREE.DataUtils.toHalfFloat(h);
    }
  }
  const texture = new THREE.DataTexture(data, cells, cells, THREE.RedFormat, THREE.HalfFloatType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// Streaks fall inside a box in front of the camera; the shader wraps each one back to the top.
export function createRain(scene, streakScene, { count, splashes, hole }) {
  const random = mulberry32(911);
  const uniforms = {
    uTime: { value: 0 },
    uFlash: { value: 0 },
    uMoon: { value: MOON_DIR.clone().normalize() },
    uBoxMin: { value: new THREE.Vector3(-4.5, -0.3, -7) },
    uBoxSize: { value: new THREE.Vector3(9, 5, 9.2) },
    uViewHeight: { value: 900 },
    uGround: { value: bakeGround() },
    // xz of the grave's hole, then how hard it is glowing.
    uHoleGlow: { value: new THREE.Vector4(hole.x, hole.y, 0, 0) },
    // Where and when the slap landed.
    uSplat: { value: new THREE.Vector4(0, 0, 0, -100) },
  };

  const quad = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute('position', quad.getAttribute('position'));
  geometry.setAttribute('uv', quad.getAttribute('uv'));
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    seeds[i * 4] = random();
    seeds[i * 4 + 1] = random();
    seeds[i * 4 + 2] = random();
    seeds[i * 4 + 3] = random();
  }
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geometry.instanceCount = count;

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uMoon;
      uniform vec3 uBoxMin;
      uniform vec3 uBoxSize;
      attribute vec4 aSeed;
      varying vec2 vUv;
      varying float vFade;
      void main() {
        float speed = 7.5 + aSeed.w * 3.0;
        vec3 p = uBoxMin + aSeed.xyz * uBoxSize;
        p.y = uBoxMin.y + mod(aSeed.y * uBoxSize.y - uTime * speed, uBoxSize.y);
        p.x += (p.y - uBoxMin.y) * 0.08;
        vec3 fall = normalize(vec3(-0.08, -1.0, 0.0));
        vec3 toCam = normalize(cameraPosition - p);
        vec3 side = normalize(cross(toCam, fall));
        float dist = length(cameraPosition - p);
        // Drops just in front of the lens are out of focus: wider, softer, fainter.
        float near = mix(2.2, 1.0, smoothstep(0.3, 1.1, dist));
        float len = 0.16 + aSeed.w * 0.16;
        float width = (0.003 + aSeed.x * 0.0025) * near;
        vec3 world = p + side * position.x * width - fall * position.y * len;
        vUv = uv;
        // Rain shows where it is backlit: drops between the camera and the moon catch its light.
        float back = pow(max(dot(-toCam, uMoon), 0.0), 6.0);
        vFade = smoothstep(0.22, 0.6, dist) * (1.0 - smoothstep(5.0, 10.0, dist)) * mix(1.0, 0.45, smoothstep(1.5, 5.0, dist));
        vFade *= (0.75 + back * 0.85) / (near * near);
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uFlash;
      varying vec2 vUv;
      varying float vFade;
      void main() {
        float a = smoothstep(0.0, 0.5, vUv.y) * (1.0 - abs(vUv.x - 0.5) * 2.0);
        vec3 col = vec3(0.55, 0.62, 0.75) * (0.16 + uFlash * 0.9);
        gl_FragColor = vec4(col * a * vFade, 1.0);
      }`,
  });
  const streaks = new THREE.Mesh(geometry, material);
  streaks.frustumCulled = false;
  streakScene.add(streaks);

  // Splashes: each slot keeps splashing on its own clock, landing somewhere new every time. One
  // instance is the glint of the impact; the rest are droplets thrown up off the mud on short
  // arcs. The last few instances belong to the slap.
  const perSplash = DROPLETS + 1;
  const total = splashes * perSplash + SPLAT_DROPLETS;
  const drops = new Float32Array(total * 4);
  for (let i = 0; i < total; i++) {
    const splat = i >= splashes * perSplash;
    drops[i * 4] = splat ? -1 : Math.floor(i / perSplash);
    drops[i * 4 + 1] = splat ? 1 + (i % SPLAT_DROPLETS) : i % perSplash;
    drops[i * 4 + 2] = random();
    drops[i * 4 + 3] = random();
  }
  const splashGeometry = new THREE.InstancedBufferGeometry();
  splashGeometry.index = quad.index;
  splashGeometry.setAttribute('position', quad.getAttribute('position'));
  splashGeometry.setAttribute('uv', quad.getAttribute('uv'));
  splashGeometry.setAttribute('aDrop', new THREE.InstancedBufferAttribute(drops, 4));
  splashGeometry.instanceCount = total;
  const { x: gx, z: gz, size: gs, cells } = GROUND;
  const splashMaterial = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    // Each droplet is a ribbon along its path; which way it winds depends on the view.
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uViewHeight;
      uniform sampler2D uGround;
      uniform vec4 uHoleGlow;
      uniform vec4 uSplat;
      attribute vec4 aDrop;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vGreen;
      varying float vGlint;
      float hash(float n) { return fract(sin(n) * 43758.5453123); }
      float groundAt(vec2 xz) {
        vec2 uv = (xz - vec2(${gx.toFixed(3)}, ${gz.toFixed(3)})) / ${gs.toFixed(3)};
        return texture2D(uGround, uv * ${((cells - 1) / cells).toFixed(6)} + ${(0.5 / cells).toFixed(6)}).r;
      }
      void main() {
        float slot = aDrop.x;
        float k = aDrop.y;
        vec3 base;
        float age;
        float power;
        float turn;
        if (slot < 0.0) {
          base = uSplat.xyz;
          age = uTime - uSplat.w;
          power = 2.0;
          turn = 0.0;
        } else {
          float period = 0.5 + hash(slot * 0.731 + 0.3) * 0.7;
          float clock = uTime / period + hash(slot * 1.37 + 0.1);
          float n = floor(clock);
          age = fract(clock) * period;
          float a = hash(slot * 7.13 + n * 1.618);
          float b = hash(slot * 3.91 + n * 2.718);
          vec2 xz;
          if (hash(slot * 0.193 + 0.7) < 0.55) {
            // Most land on and around the grave, where the eye is.
            float r = sqrt(a);
            xz = vec2(0.0, -0.25) + vec2(cos(b * 6.2832) * r * 0.8, sin(b * 6.2832) * r * 1.15);
          } else {
            xz = vec2(-2.4 + a * 4.2, -3.2 + b * 4.2);
          }
          base = vec3(xz.x, groundAt(xz) + 0.002, xz.y);
          power = 0.7 + hash(slot * 5.3 + n * 0.77) * 0.6;
          turn = hash(slot * 2.1 + n * 3.3) * 6.2832;
        }

        vec3 pos;
        vec3 dir;
        float life;
        float speed = 0.0;
        if (k < 0.5) {
          life = 0.05;
          pos = base + vec3(0.0, 0.003, 0.0);
          dir = vec3(0.0, 1.0, 0.0);
        } else {
          float around = aDrop.z * 6.2832 + turn;
          float elevation = 0.75 + aDrop.w * 0.6;
          vec3 v0 = vec3(cos(around) * cos(elevation), sin(elevation), sin(around) * cos(elevation));
          v0 *= (0.35 + aDrop.w * 0.45) * power;
          life = 2.0 * v0.y / 9.8;
          float t = clamp(age, 0.0, life);
          pos = base + v0 * t + vec3(0.0, -4.9 * t * t, 0.0);
          vec3 vel = v0 + vec3(0.0, -9.8 * t, 0.0);
          speed = length(vel);
          dir = vel / max(speed, 1e-4);
        }
        float alive = step(0.0, age) * step(age, life);

        vec3 toCam = cameraPosition - pos;
        float dist = length(toCam);
        // Never thinner than about a pixel and a half; a clamped drop dims to keep its brightness.
        float pixel = dist * 2.0 / (projectionMatrix[1][1] * uViewHeight);
        float trueWidth = k < 0.5 ? 0.01 * power : 0.0016 * min(power, 1.3);
        float width = max(trueWidth, pixel * 1.5);
        // Droplets smear along their path over about one frame.
        float len = k < 0.5 ? width : max(width, speed * 0.016);
        vec3 side = normalize(cross(toCam / dist, dir));
        vec3 world = pos + side * position.x * width + dir * position.y * len;

        vUv = uv;
        vGlint = k < 0.5 ? 1.0 : 0.0;
        float fade = k < 0.5 ? 1.0 - age / life : 1.0 - 0.6 * smoothstep(0.5, 1.0, age / life);
        vAlpha = alive * fade * (trueWidth / width) * (1.0 - smoothstep(4.0, 7.0, dist));
        vec2 fromHole = base.xz - uHoleGlow.xy;
        vGreen = clamp(uHoleGlow.z * exp(-dot(fromHole, fromHole) / 0.05), 0.0, 1.0) * 0.35;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uFlash;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vGreen;
      varying float vGlint;
      void main() {
        vec2 c = vUv - 0.5;
        float drop = (1.0 - smoothstep(0.2, 0.5, abs(c.x))) * (1.0 - smoothstep(0.3, 0.5, abs(c.y)));
        float a = mix(drop, exp(-dot(c, c) * 20.0) * 0.6, vGlint);
        // Moonlit water, catching a little of the grave's green close to its glow.
        vec3 col = mix(vec3(0.55, 0.62, 0.75), vec3(0.3, 1.0, 0.06) * 1.3, vGreen);
        gl_FragColor = vec4(col * a * vAlpha * (0.75 + uFlash * 1.6), 1.0);
      }`,
  });
  const splash = new THREE.Mesh(splashGeometry, splashMaterial);
  splash.frustumCulled = false;
  scene.add(splash);

  return {
    uniforms,
    // A one-off splash where something hits the wet ground, timed on the scene clock.
    splat(at, time) {
      uniforms.uSplat.value.set(at.x, at.y, at.z, time);
    },
  };
}
