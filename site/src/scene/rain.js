import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { heightAt } from './world.js';

// Streaks fall inside a box in front of the camera; the shader wraps each one back to the top.
export function createRain(scene, streakScene, { count, splashes }) {
  const random = mulberry32(911);
  const uniforms = {
    uTime: { value: 0 },
    uFlash: { value: 0 },
    uBoxMin: { value: new THREE.Vector3(-4.5, -0.3, -7) },
    uBoxSize: { value: new THREE.Vector3(9, 5, 9.2) },
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
        float len = 0.16 + aSeed.w * 0.16;
        float width = 0.003 + aSeed.x * 0.0025;
        vec3 world = p + side * position.x * width - fall * position.y * len;
        vUv = uv;
        float dist = length(cameraPosition - p);
        vFade = smoothstep(0.4, 1.0, dist) * (1.0 - smoothstep(5.0, 10.0, dist)) * mix(1.0, 0.45, smoothstep(1.5, 5.0, dist));
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

  // Splashes: fixed spots on the ground, each blooming as a ring on its own clock.
  const splashGeometry = new THREE.InstancedBufferGeometry();
  const ring = new THREE.PlaneGeometry(1, 1);
  ring.rotateX(-Math.PI / 2);
  splashGeometry.index = ring.index;
  splashGeometry.setAttribute('position', ring.getAttribute('position'));
  splashGeometry.setAttribute('uv', ring.getAttribute('uv'));
  const spots = new Float32Array(splashes * 4);
  for (let i = 0; i < splashes; i++) {
    const a = random() * Math.PI * 2;
    const r = Math.sqrt(random()) * 3.2;
    const x = Math.cos(a) * r * 1.1;
    const z = -0.3 + Math.sin(a) * r;
    spots[i * 4] = x;
    spots[i * 4 + 1] = heightAt(x, z) + 0.004;
    spots[i * 4 + 2] = z;
    spots[i * 4 + 3] = random();
  }
  splashGeometry.setAttribute('aSpot', new THREE.InstancedBufferAttribute(spots, 4));
  splashGeometry.instanceCount = splashes;
  const splashMaterial = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec4 aSpot;
      varying vec2 vUv;
      varying float vLife;
      void main() {
        float period = 0.55 + aSpot.w * 0.5;
        vLife = fract(uTime / period + aSpot.w * 7.0);
        float size = 0.006 + vLife * 0.028;
        vUv = uv;
        vec3 world = aSpot.xyz + position * size;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uFlash;
      varying vec2 vUv;
      varying float vLife;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float ringA = smoothstep(0.7, 0.9, r) * (1.0 - smoothstep(0.9, 1.0, r));
        float a = ringA * (1.0 - vLife) * smoothstep(0.0, 0.08, vLife);
        gl_FragColor = vec4(vec3(0.5, 0.56, 0.68) * a * (0.28 + uFlash * 1.2), 1.0);
      }`,
  });
  const splash = new THREE.Mesh(splashGeometry, splashMaterial);
  splash.frustumCulled = false;
  scene.add(splash);

  return { uniforms };
}
