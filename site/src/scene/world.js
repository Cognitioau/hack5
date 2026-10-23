import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { fbm2, mulberry32, NOISE_GLSL } from './noise.js';
import { createVegetation, floatGeometry } from './vegetation.js';

// The grave runs along Z: headstone at the head (-Z), mound toward the camera (+Z).
export const GRAVE = { x: 0, z: -0.25, halfWidth: 0.5, halfLength: 0.98, height: 0.24 };
export const HEADSTONE = { x: 0.02, z: -1.36 };
// Kept in step with HOLE and LETTER_OFFSET in timeline.js: the soil is smoothed where the hand
// breaks out and where the letter lies, so neither sits on a clod.
const HOLE_AT = { x: -0.07, z: 0.04 };
const LETTER_AT = { x: -0.07 + 0.118, z: 0.04 + 0.072 };
const CORNER = 0.2;
// The neon accent: a sickly green that lives under the grave.
export const GLOW_COLOR = new THREE.Color(0.3, 1.0, 0.06);

const smooth = (x, a, b) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

// Signed distance to the grave's rounded rectangle, in metres (negative inside), with a ragged
// edge so the spade-cut boundary is not a perfect rectangle.
export function graveEdge(x, z) {
  const px = Math.abs(x - GRAVE.x) - GRAVE.halfWidth + CORNER;
  const pz = Math.abs(z - GRAVE.z) - GRAVE.halfLength + CORNER;
  const d = Math.hypot(Math.max(px, 0), Math.max(pz, 0)) + Math.min(Math.max(px, pz), 0) - CORNER;
  return d + (fbm2(x * 3.1 + 7, z * 3.1) - 0.5) * 0.09 + (fbm2(x * 11, z * 11 + 5) - 0.5) * 0.03;
}

function hash(ix, iz, k) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(k, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Heaped clods: a union of squashed half-ellipsoids scattered one per grid cell.
function clods(x, z, cell, k, rise) {
  const gx = Math.floor(x / cell);
  const gz = Math.floor(z / cell);
  let best = 0;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const cx = gx + i;
      const cz = gz + j;
      const px = (cx + 0.1 + 0.8 * hash(cx, cz, k)) * cell;
      const pz = (cz + 0.1 + 0.8 * hash(cx, cz, k + 1)) * cell;
      const r = cell * (0.42 + 0.55 * hash(cx, cz, k + 2));
      const a = hash(cx, cz, k + 3) * Math.PI;
      const dx = x - px;
      const dz = z - pz;
      const u = dx * Math.cos(a) + dz * Math.sin(a);
      const v = (-dx * Math.sin(a) + dz * Math.cos(a)) * (1.2 + hash(cx, cz, k + 4) * 0.8);
      const d2 = (u * u + v * v) / (r * r);
      if (d2 < 1) best = Math.max(best, Math.pow(1 - d2, 0.6) * r * rise * (0.6 + 0.6 * hash(cx, cz, k + 5)));
    }
  }
  return best;
}

function padFalloff(x, z) {
  const dl = Math.hypot(x - LETTER_AT.x, z - LETTER_AT.z);
  const dh = Math.hypot(x - HOLE_AT.x, z - HOLE_AT.z);
  return Math.max(Math.exp(-Math.pow(dl / 0.1, 4)), Math.exp(-Math.pow(dh / 0.075, 4)));
}

export function heightAt(x, z) {
  const dist = Math.hypot(x, z + 0.4);
  const far = smooth(dist, 2.5, 14);
  let h = (fbm2(x * 0.11 + 4, z * 0.11) - 0.5) * 0.5 * far + far * far * 0.6;
  h += (fbm2(x * 1.3, z * 1.3) - 0.5) * 0.05;
  const d = graveEdge(x, z);
  if (d < 0.2) {
    const inward = -d;
    // Heaped spoil: steep sides at the angle of repose, a slumped crown on top.
    const body = GRAVE.height * (0.78 * smooth(inward, -0.03, 0.26) + 0.17 * smooth(inward, 0.1, 0.5));
    const cover = smooth(inward, -0.12, 0.03) * (1 - padFalloff(x, z));
    const lumps = clods(x, z, 0.055, 11, 0.3) + clods(x, z, 0.03, 23, 0.36) * 0.7;
    const swell = (fbm2(x * 4.5 + 2, z * 4.5) - 0.5) * 0.04 * smooth(inward, 0, 0.2);
    h += body + lumps * cover + swell;
  }
  return h;
}

export function normalAt(x, z, target = new THREE.Vector3()) {
  const e = 0.01;
  const dx = heightAt(x + e, z) - heightAt(x - e, z);
  const dz = heightAt(x, z + e) - heightAt(x, z - e);
  return target.set(-dx, 2 * e, -dz).normalize();
}

// Polar grid centred on the grave: about 1 cm spacing on the mound, metres at the horizon.
function groundGeometry(lowQuality) {
  const segments = lowQuality ? 300 : 560;
  const radii = [0];
  const inner = lowQuality ? 85 : 135;
  for (let i = 1; i <= inner; i++) radii.push((1.32 * i) / inner);
  let r = 1.32;
  while (r < 110) {
    r *= lowQuality ? 1.06 : 1.035;
    radii.push(r);
  }
  const cx = GRAVE.x;
  const cz = GRAVE.z;
  const positions = [];
  const soil = [];
  const indices = [];
  const push = (x, z) => {
    positions.push(x, heightAt(x, z), z);
    const d = graveEdge(x, z);
    // Soil inside the cut, plus the clods that spilled over its edge.
    let s = 1 - smooth(d, -0.006, 0.01);
    if (d > 0 && d < 0.14) s = Math.max(s, Math.min(1, clods(x, z, 0.03, 23, 0.45) * 300) * (1 - smooth(d, 0.04, 0.14)));
    soil.push(s);
  };
  push(cx, cz);
  for (let ring = 1; ring < radii.length; ring++) {
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      push(cx + Math.cos(a) * radii[ring], cz + Math.sin(a) * radii[ring]);
    }
  }
  for (let s = 0; s < segments; s++) indices.push(0, 1 + ((s + 1) % segments), 1 + s);
  for (let ring = 1; ring < radii.length - 1; ring++) {
    const a0 = 1 + (ring - 1) * segments;
    const b0 = 1 + ring * segments;
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      indices.push(a0 + s, a0 + s1, b0 + s, a0 + s1, b0 + s1, b0 + s);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aSoil', new THREE.Float32BufferAttribute(soil, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function groundMaterial(textures, uniforms) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0, envMapIntensity: 0.45 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uSoil: { value: textures.soil },
      uSoilN: { value: textures.soilN },
      uSoilA: { value: textures.soilA },
      uGrass: { value: textures.grass },
      uGrassN: { value: textures.grassN },
      uGlowColor: { value: GLOW_COLOR },
    });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec4 uHole;
        uniform float uTremble;
        uniform float uTime;
        attribute float aSoil;
        varying vec3 vWorld;
        varying float vSoil;
        float zbCrater(vec2 p) {
          vec2 d = p - uHole.xy;
          float r = length(d);
          float ang = atan(d.y, d.x);
          float lip = 0.6 + 0.4 * sin(ang * 5.0 + 1.3) * sin(ang * 3.0);
          float pit = -0.05 * exp(-pow(r / 0.055, 2.0));
          float rim = 0.03 * lip * exp(-pow((r - 0.085) / 0.032, 2.0));
          return uHole.z * (pit + rim);
        }`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vSoil = aSoil;
        vec2 zbP = (modelMatrix * vec4(position, 1.0)).xz;
        float zbE = 0.004;
        float zbH = zbCrater(zbP);
        float zbHx = zbCrater(zbP + vec2(zbE, 0.0)) - zbCrater(zbP - vec2(zbE, 0.0));
        float zbHz = zbCrater(zbP + vec2(0.0, zbE)) - zbCrater(zbP - vec2(0.0, zbE));
        float zbNear = exp(-pow(length(zbP - uHole.xy) / 0.2, 2.0));
        transformed.y += zbH + uTremble * zbNear * 0.006 * sin(uTime * 60.0 + zbP.x * 90.0) * sin(uTime * 47.0 + zbP.y * 70.0);
        objectNormal = normalize(objectNormal + vec3(-zbHx, 0.0, -zbHz) / (2.0 * zbE));`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    // objectNormal is read before begin_vertex in the stock shader, so move the normal block after it.
    shader.vertexShader = shader.vertexShader
      .replace('#include <beginnormal_vertex>', '')
      .replace('#include <defaultnormal_vertex>', '')
      .replace('#include <normal_vertex>', '')
      .replace('#include <begin_vertex>', '#include <beginnormal_vertex>\n#include <begin_vertex>')
      .replace(
        '#include <project_vertex>',
        '#include <defaultnormal_vertex>\n#include <normal_vertex>\n#include <project_vertex>',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uSoil;
        uniform sampler2D uSoilN;
        uniform sampler2D uSoilA;
        uniform sampler2D uGrass;
        uniform sampler2D uGrassN;
        uniform vec4 uHole;
        uniform float uGlow;
        uniform float uTime;
        uniform vec3 uGlowColor;
        varying vec3 vWorld;
        varying float vSoil;
        ${NOISE_GLSL}
        // Two rotated, offset lookups blended by noise hide the tiling of a single scan.
        const mat2 zbR1 = mat2(0.8, -0.6, 0.6, 0.8);
        const mat2 zbR2 = mat2(0.28, 0.96, -0.96, 0.28);
        vec3 zbNrm(sampler2D t, vec2 uv) { return texture2D(t, uv).xyz * 2.0 - 1.0; }
        float zbSoilM;
        float zbDisp;
        float zbPuddle;
        float zbB;
        float zbBg;
        vec2 zbUv1;
        vec2 zbUv2;
        vec2 zbUg1;
        vec2 zbUg2;
        vec4 zbArm;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec2 zbP = vWorld.xz;
        zbUv1 = zbP * 0.95;
        zbUv2 = zbR1 * zbP * 0.83 + vec2(0.37, 0.71);
        zbUg1 = zbP * 0.42;
        zbUg2 = zbR2 * zbP * 0.35 + vec2(0.5, 0.21);
        zbB = smoothstep(0.38, 0.62, zbNoise(vec3(zbP * 1.6, 0.5)));
        zbBg = smoothstep(0.38, 0.62, zbNoise(vec3(zbP * 0.7, 3.5)));
        zbArm = mix(texture2D(uSoilA, zbUv1), texture2D(uSoilA, zbUv2), zbB);
        zbDisp = zbArm.b;
        vec3 zbSoilC = mix(texture2D(uSoil, zbUv1).rgb, texture2D(uSoil, zbUv2).rgb, zbB);
        vec3 zbGrassC = mix(texture2D(uGrass, zbUg1).rgb, texture2D(uGrass, zbUg2).rgb, zbBg);
        // A ragged, crisp spade line between fresh soil and the old ground.
        zbSoilM = smoothstep(0.4, 0.6, vSoil + (zbNoise(vec3(zbP * 45.0, 1.0)) - 0.5) * 0.35);

        // Fresh soil: rain-dark, the leaf litter muted so it reads as turned earth.
        float zbL = dot(zbSoilC, vec3(0.3, 0.59, 0.11));
        zbSoilC *= min(1.0, 0.1 / max(zbL, 1e-3));
        zbL = dot(zbSoilC, vec3(0.3, 0.59, 0.11));
        zbSoilC = mix(vec3(zbL), zbSoilC, 0.7) * vec3(1.0, 0.86, 0.74);
        zbSoilC *= mix(0.55, 1.0, smoothstep(0.15, 0.6, zbDisp));
        float zbHoleR = length(zbP - uHole.xy);
        zbSoilC *= 1.0 - uHole.z * 0.8 * exp(-pow(zbHoleR / 0.06, 2.0));

        // Old ground: dead leaves and moss, desaturated toward the moonlit palette.
        float zbLg = dot(zbGrassC, vec3(0.3, 0.59, 0.11));
        // Clamp the scan's bright clover so the turf reads as one dark mat, not a pattern.
        zbGrassC *= min(1.0, 0.07 / max(zbLg, 1e-3));
        zbLg = dot(zbGrassC, vec3(0.3, 0.59, 0.11));
        zbGrassC = mix(vec3(0.06, 0.058, 0.045), mix(vec3(zbLg), zbGrassC, 0.6), 0.55) * vec3(0.62, 0.66, 0.55);
        float zbVar = zbFbm(vec3(zbP * 0.35, 2.0));
        zbGrassC *= mix(0.7, 1.15, zbVar);
        // Standing water collects in the low ground.
        float zbPn = zbFbm(vec3(zbP * 0.55, 9.0)) + (zbNoise(vec3(zbP * 6.0, 4.0)) - 0.5) * 0.06;
        zbPuddle = smoothstep(0.6, 0.625, zbPn) * (1.0 - zbSoilM) * smoothstep(0.25, 0.6, length(zbP - vec2(0.0, -0.3)) - 0.9);
        zbGrassC *= 1.0 - zbPuddle * 0.65;
        diffuseColor.rgb = mix(zbGrassC, zbSoilC, zbSoilM);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float zbRs = mix(0.58, 0.92, zbArm.g) * mix(0.75, 1.0, smoothstep(0.1, 0.45, zbDisp));
        float zbRg = 0.9;
        roughnessFactor = mix(mix(zbRg, 0.05, zbPuddle), zbRs, zbSoilM);`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        // Old turf takes only a dull sheen; the fresh soil and the puddles stay glossy.
        float zbSpec = mix(0.3, 1.0, max(zbSoilM, zbPuddle));
        reflectedLight.directSpecular *= zbSpec;
        reflectedLight.indirectSpecular *= zbSpec;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec3 zbS1 = zbNrm(uSoilN, zbUv1);
          vec3 zbS2 = zbNrm(uSoilN, zbUv2);
          zbS2.xy = zbS2.xy * zbR1;
          vec3 zbSD = zbNrm(uSoilN, vWorld.xz * 3.7 + 0.3);
          vec3 nS = mix(zbS1, zbS2, zbB);
          nS = vec3((nS.xy + zbSD.xy * 0.12) * 0.75, nS.z);
          vec3 zbG1 = zbNrm(uGrassN, zbUg1);
          vec3 zbG2 = zbNrm(uGrassN, zbUg2);
          zbG2.xy = zbG2.xy * zbR2;
          vec3 nG = mix(zbG1, zbG2, zbBg);
          nG.xy *= mix(0.35, 0.0, zbPuddle);
          vec3 nT = normalize(mix(nG, nS, zbSoilM));
          vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          vec3 tW = normalize(vec3(1.0, 0.0, 0.0) - nW * nW.x);
          vec3 bW = cross(tW, nW);
          vec3 world = normalize(tW * nT.x + bW * nT.y + nW * nT.z);
          normal = normalize((viewMatrix * vec4(world, 0.0)).xyz);
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // Something down there glows: green seeps up through the cracks between the clods.
          vec2 zbQ = vWorld.xz;
          float zbR = length(zbQ - uHole.xy);
          float zbReach = 0.1 + 0.15 * uGlow;
          float zbNearG = exp(-pow(zbR / zbReach, 2.0));
          float zbN1 = zbFbm(vec3(zbQ * 7.0, 2.0));
          float zbN2 = zbFbm(vec3(zbQ * 15.0, 5.0));
          float zbC1 = 1.0 - smoothstep(0.0, fwidth(zbN1) * 1.5 + 0.008, abs(zbN1 - 0.5));
          float zbC2 = 1.0 - smoothstep(0.0, fwidth(zbN2) * 1.5 + 0.006, abs(zbN2 - 0.5));
          float zbCrack = max(zbC1, zbC2 * 0.7) * smoothstep(0.6, 0.3, zbDisp);
          float zbSeep = smoothstep(0.2, 0.04, zbDisp);
          float zbG = zbNearG * zbSoilM * (zbCrack + zbSeep * 0.6);
          float zbPit = uHole.z * exp(-pow(zbR / 0.05, 2.0));
          totalEmissiveRadiance += uGlowColor * (zbG * (0.035 + 0.6 * uGlow + 2.4 * uGlow * uGlow) + zbPit * (0.3 + 5.0 * uGlow));
        }`,
      );
  };
  return material;
}

// Planar UVs per face direction, in metres, so every stone shape takes the scan at true scale.
function boxUVs(geometry, scale) {
  const pos = geometry.getAttribute('position');
  const nor = geometry.getAttribute('normal');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    let u;
    let v;
    if (az >= ax && az >= ay) {
      u = pos.getX(i);
      v = pos.getY(i);
    } else if (ax >= ay) {
      u = pos.getZ(i);
      v = pos.getY(i);
    } else {
      u = pos.getX(i);
      v = pos.getZ(i);
    }
    uv[i * 2] = u * scale + 0.31;
    uv[i * 2 + 1] = v * scale + 0.17;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

function stoneMaterial(textures, { tint = 1, engraving = null } = {}) {
  const material = new THREE.MeshStandardMaterial({
    map: textures.stone,
    normalMap: textures.stoneN,
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughnessMap: textures.stoneA,
    aoMap: textures.stoneA,
    aoMapIntensity: 1,
    roughness: 0.95,
    envMapIntensity: 0.4,
    vertexColors: false,
    color: new THREE.Color(0.78 * tint, 0.8 * tint, 0.84 * tint),
  });
  if (engraving) material.defines = { ZB_ENGRAVE: '' };
  material.onBeforeCompile = (shader) => {
    if (engraving) shader.uniforms.uEngrave = { value: engraving };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldS;\nvarying vec3 vLocal;\nvarying vec3 vLocalN;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vLocal = position;
        vLocalN = objectNormal;
        vec4 zbWs = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          zbWs = instanceMatrix * zbWs;
        #endif
        vWorldS = (modelMatrix * zbWs).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWorldS;
        varying vec3 vLocal;
        varying vec3 vLocalN;
        #ifdef ZB_ENGRAVE
          uniform sampler2D uEngrave;
        #endif
        float zbMoss;
        vec4 zbEng;
        ${NOISE_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        zbEng = vec4(0.0);
        #ifdef ZB_ENGRAVE
          vec2 zbEuv = vec2(vLocal.x / 0.5 + 0.5, (vLocal.y - 0.56) / 0.625 + 0.5);
          float zbFront = step(0.6, vLocalN.z) * step(0.0, zbEuv.x) * step(zbEuv.x, 1.0) * step(0.0, zbEuv.y) * step(zbEuv.y, 1.0);
          zbEng = texture2D(uEngrave, zbEuv) * zbFront;
        #endif
        // Soften the scan's lichen speckle into broad weathering.
        float zbSl = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
        diffuseColor.rgb *= min(1.0, 0.16 / max(zbSl, 1e-3));
        zbSl = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
        vec3 zbTint = diffuse;
        #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
          zbTint *= vColor.rgb;
        #endif
        diffuseColor.rgb = mix(vec3(0.2) * zbTint, diffuseColor.rgb, 0.45) * mix(0.85, 1.15, zbSl);
        // Rain streaks run down from the top; moss creeps up from the wet ground.
        float zbStreak = smoothstep(0.45, 0.75, zbNoise(vec3(vWorldS.x * 38.0, vWorldS.y * 1.4, vWorldS.z * 38.0)));
        diffuseColor.rgb *= 1.0 - zbStreak * 0.3;
        float zbMn = zbFbm(vWorldS * 9.0);
        float zbBase = 1.0 - smoothstep(0.0, 0.26, vLocal.y + (zbMn - 0.5) * 0.22);
        vec3 zbWn = normalize(vLocalN);
        float zbTop = smoothstep(0.55, 0.9, zbWn.y) * smoothstep(0.5, 0.65, zbMn);
        zbMoss = clamp(max(zbBase * smoothstep(0.35, 0.5, zbMn + 0.1), zbTop), 0.0, 1.0);
        vec3 zbMossC = mix(vec3(0.07, 0.09, 0.035), vec3(0.16, 0.2, 0.07), zbFbm(vWorldS * 31.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, zbMossC, zbMoss * 0.92);
        diffuseColor.rgb *= mix(1.0, 0.6, zbBase);
        // Grime packs the carved letters.
        diffuseColor.rgb *= 1.0 - zbEng.r * 0.62;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.55 + roughnessFactor * 0.35, 0.95, zbMoss);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        #ifdef ZB_ENGRAVE
          normal = zbPerturb(-vViewPosition, normal, -zbEng.g * 0.006, faceDirection);
        #endif`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= 1.0 - zbEng.g * 0.6;
        reflectedLight.directDiffuse *= 1.0 - zbEng.r * 0.25;`,
      );
  };
  return material;
}

function archShape(width, height) {
  const w = width / 2;
  const shoulder = height - w * 0.9;
  const shape = new THREE.Shape();
  shape.moveTo(-w, -0.3);
  shape.lineTo(w, -0.3);
  shape.lineTo(w, shoulder);
  shape.quadraticCurveTo(w, height, 0, height);
  shape.quadraticCurveTo(-w, height, -w, shoulder);
  shape.lineTo(-w, -0.3);
  return shape;
}

// A dressed stone with a broad weathered bevel; edges nudged by noise so nothing is machine-true.
function headstoneGeometry(width, height, depth, { bevel = 0.022, seed = 1, wear = 0.004 } = {}) {
  const geometry = new THREE.ExtrudeGeometry(archShape(width - bevel * 2, height - bevel), {
    depth: depth - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 5,
    curveSegments: 40,
  });
  geometry.translate(0, 0, -(depth - bevel * 2) / 2);
  const pos = geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = fbm2(x * 22 + seed, y * 22 + z * 9) - 0.5;
    const r = Math.hypot(x, y - height * 0.5) || 1;
    pos.setXYZ(i, x + (x / r) * n * wear, y + ((y - height * 0.5) / r) * n * wear, z + n * wear * 0.5 * Math.sign(z));
  }
  return boxUVs(geometry, 0.7);
}

function crossGeometry() {
  const upright = new RoundedBoxGeometry(0.11, 1.25, 0.1, 3, 0.018);
  upright.translate(0, 0.32, 0);
  const arm = new RoundedBoxGeometry(0.5, 0.1, 0.1, 3, 0.018);
  arm.translate(0, 0.68, 0);
  return boxUVs(mergeGeometries([upright, arm]), 1.1);
}

function slabGeometry() {
  const g = new RoundedBoxGeometry(0.55, 0.85, 0.12, 3, 0.025);
  g.translate(0, 0.12, 0);
  return boxUVs(g, 1.1);
}

function obeliskGeometry() {
  const base = new RoundedBoxGeometry(0.42, 0.3, 0.42, 2, 0.02);
  base.translate(0, -0.05, 0);
  const shaft = new THREE.CylinderGeometry(0.09, 0.15, 1.3, 4, 1);
  shaft.rotateY(Math.PI / 4);
  shaft.translate(0, 0.75, 0);
  const tip = new THREE.ConeGeometry(0.09 * Math.SQRT2, 0.16, 4);
  tip.rotateY(Math.PI / 4);
  tip.translate(0, 1.48, 0);
  return boxUVs(mergeGeometries([base, shaft.toNonIndexed(), tip.toNonIndexed()].map((g) => (g.index ? g.toNonIndexed() : g))), 1.1);
}

// The epitaph, drawn white on black: red is the cut, green a blurred copy that shapes its V-groove.
function engravingTexture(fontFamily) {
  const W = 1024;
  const H = 1280;
  const draw = (blur) => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (blur) ctx.filter = `blur(${blur}px)`;
    const lines = [
      { text: 'R · I · P', size: 116, y: 300, spacing: 20 },
      { text: 'THE TABS YOU', size: 88, y: 580, spacing: 8 },
      { text: 'MEANT TO READ', size: 88, y: 700, spacing: 8 },
      { text: 'they rise again', size: 68, y: 900, spacing: 4, italic: true },
    ];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    for (const l of lines) {
      ctx.font = `${l.italic ? 'italic ' : ''}${l.size}px ${fontFamily}`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${l.spacing}px`;
      ctx.fillText(l.text, W / 2, l.y);
    }
    ctx.fillRect(352, 424, 320, 7);
    return ctx.getImageData(0, 0, W, H).data;
  };
  const sharp = draw(0);
  const soft = draw(5);
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    // Canvas rows run top-down; texture rows run bottom-up.
    const row = Math.floor(i / W);
    const j = ((H - 1 - row) * W + (i % W)) * 4;
    data[j] = sharp[i * 4];
    data[j + 1] = Math.min(255, soft[i * 4] * 1.6);
    data[j + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

// Stand a scanned trunk upright: its longest axis becomes the height.
function uprightTrunk(root) {
  let geometry = null;
  root.traverse((o) => {
    if (o.isMesh && !geometry) {
      o.updateWorldMatrix(true, false);
      geometry = floatGeometry(o.geometry).applyMatrix4(o.matrixWorld);
    }
  });
  geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  if (size.x >= size.y && size.x >= size.z) geometry.rotateZ(Math.PI / 2);
  else if (size.z >= size.y) geometry.rotateX(Math.PI / 2);
  // The broken, branching end goes up.
  geometry.computeBoundingBox();
  const pos = geometry.getAttribute('position');
  const { min, max } = geometry.boundingBox;
  const spread = (lo, hi) => {
    let a = Infinity;
    let b = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const k = (pos.getY(i) - min.y) / (max.y - min.y);
      if (k >= lo && k <= hi) {
        a = Math.min(a, pos.getX(i) + pos.getZ(i));
        b = Math.max(b, pos.getX(i) + pos.getZ(i));
      }
    }
    return b - a;
  };
  if (spread(0, 0.3) > spread(0.7, 1)) geometry.rotateX(Math.PI);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  geometry.scale(1 / (box.max.y - box.min.y), 1 / (box.max.y - box.min.y), 1 / (box.max.y - box.min.y));
  geometry.computeVertexNormals();
  return geometry;
}

// Bare, kinked limbs for the scanned trunks, in the trunk's unit-height space.
function limbs(rand) {
  const parts = [];
  const up = new THREE.Vector3(0, 1, 0);
  const grow = (start, dir, length, radius, depth) => {
    let from = start.clone();
    let heading = dir.clone();
    const kinks = 3;
    for (let k = 0; k < kinks; k++) {
      const seg = length / kinks;
      const r0 = radius * (1 - (k / kinks) * 0.45);
      const r1 = radius * (1 - ((k + 1) / kinks) * 0.45);
      const g = new THREE.CylinderGeometry(r1, r0, seg, 5, 1, true);
      g.translate(0, seg / 2, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, heading));
      g.translate(from.x, from.y, from.z);
      parts.push(g);
      from = from.clone().addScaledVector(heading, seg);
      heading = heading
        .clone()
        .add(new THREE.Vector3((rand() - 0.5) * 0.7, (rand() - 0.35) * 0.4, (rand() - 0.5) * 0.7))
        .normalize();
    }
    if (depth === 0 || radius < 0.0025) return;
    const children = 2 + (rand() < 0.4 ? 1 : 0);
    for (let c = 0; c < children; c++) {
      const next = heading
        .clone()
        .add(new THREE.Vector3((rand() - 0.5) * 1.6, (rand() - 0.1) * 0.8, (rand() - 0.5) * 1.6))
        .normalize();
      grow(from, next, length * (0.55 + rand() * 0.2), radius * 0.62, depth - 1);
    }
  };
  const count = 3 + Math.floor(rand() * 2);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand() * 0.8;
    const y = 0.3 + rand() * 0.55;
    const dir = new THREE.Vector3(Math.cos(a), 0.55 + rand() * 0.6, Math.sin(a)).normalize();
    grow(new THREE.Vector3(Math.cos(a) * 0.02, y, Math.sin(a) * 0.02), dir, 0.26 + rand() * 0.18, 0.016, 3);
  }
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

// Loose clods of the same wet soil, strewn over the heap and spilling past its edge.
function clodScatter(textures, rand, { lowQuality }) {
  const variants = [0, 1, 2].map((k) => {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const pos = g.getAttribute('position');
    const uv = new Float32Array(pos.count * 2);
    const ox = rand() * 4;
    const oz = rand() * 4;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const n = 0.55 + 0.9 * fbm2(x * 2.2 + k * 3.1, z * 2.2 + y * 2.7);
      const flat = y < 0 ? 0.3 : 0.55;
      pos.setXYZ(i, x * n, y * n * flat, z * n * (0.8 + k * 0.15));
      uv[i * 2] = ox + x * 0.04;
      uv[i * 2 + 1] = oz + z * 0.04 + y * 0.02;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
  });
  const material = new THREE.MeshStandardMaterial({
    map: textures.soil,
    normalMap: textures.soilN,
    normalScale: new THREE.Vector2(0.8, 0.8),
    roughness: 0.72,
    flatShading: true,
    envMapIntensity: 0.35,
    color: new THREE.Color(0.95, 0.85, 0.78),
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      float zbL = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
      diffuseColor.rgb *= min(1.0, 0.07 / max(zbL, 1e-3));`,
    );
  };
  const count = lowQuality ? 220 : 560;
  const lists = variants.map(() => []);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  let placed = 0;
  for (let tries = 0; placed < count && tries < count * 20; tries++) {
    const x = GRAVE.x + (rand() * 2 - 1) * (GRAVE.halfWidth + 0.12);
    const z = GRAVE.z + (rand() * 2 - 1) * (GRAVE.halfLength + 0.12);
    const d = graveEdge(x, z);
    if (d > 0.1 || (d > 0 && rand() < 0.6)) continue;
    if (Math.hypot(x - HOLE_AT.x, z - HOLE_AT.z) < 0.17) continue;
    if (Math.hypot(x - LETTER_AT.x, z - LETTER_AT.z) < 0.12) continue;
    const size = 0.006 + Math.pow(rand(), 2.6) * 0.026;
    p.set(x, heightAt(x, z) - size * 0.25, z);
    e.set((rand() - 0.5) * 0.6, rand() * Math.PI * 2, (rand() - 0.5) * 0.6);
    q.setFromEuler(e);
    s.set(size, size * (0.8 + rand() * 0.4), size);
    lists[Math.floor(rand() * variants.length)].push(m.compose(p, q, s).clone());
    placed++;
  }
  return variants.map((g, i) => {
    const mesh = new THREE.InstancedMesh(g, material, lists[i].length);
    lists[i].forEach((mat, j) => mesh.setMatrixAt(j, mat));
    mesh.castShadow = !lowQuality;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    return mesh;
  });
}

export function createWorld(scene, textures, { lowQuality, fontFamily }) {
  const rand = mulberry32(1031);
  const uniforms = {
    uHole: { value: new THREE.Vector4(0, 0, 0, 0) },
    uTremble: { value: 0 },
    uTime: { value: 0 },
    uGlow: { value: 0 },
  };

  const ground = new THREE.Mesh(groundGeometry(lowQuality), groundMaterial(textures, uniforms));
  ground.receiveShadow = true;
  scene.add(ground);

  const groundY = heightAt(HEADSTONE.x, HEADSTONE.z);
  const stone = stoneMaterial(textures, { tint: 1.0, engraving: engravingTexture(fontFamily) });
  const headstone = new THREE.Mesh(headstoneGeometry(0.62, 0.98, 0.14, { bevel: 0.024, seed: 3 }), stone);
  headstone.position.set(HEADSTONE.x, groundY - 0.05, HEADSTONE.z);
  headstone.rotation.set(-0.045, 0.05, 0.03);
  headstone.castShadow = true;
  headstone.receiveShadow = true;
  scene.add(headstone);

  // A plinth gives the stone its weight; it has settled into the ground at a slight tilt.
  const plinthMat = stoneMaterial(textures, { tint: 0.85 });
  const plinth = new THREE.Mesh(boxUVs(new RoundedBoxGeometry(0.8, 0.16, 0.3, 3, 0.03), 1.1), plinthMat);
  plinth.position.set(HEADSTONE.x, groundY - 0.035, HEADSTONE.z + 0.01);
  plinth.rotation.set(-0.02, 0.05, 0.025);
  plinth.castShadow = true;
  plinth.receiveShadow = true;
  scene.add(plinth);

  // Older graves fill the dark in uneven rows, sunk and leaning; fog does the rest.
  const shapes = [
    { geometry: headstoneGeometry(0.55, 0.85, 0.12, { bevel: 0.018, seed: 7, wear: 0.006 }), weight: 0.42 },
    { geometry: crossGeometry(), weight: 0.24 },
    { geometry: slabGeometry(), weight: 0.28 },
    { geometry: obeliskGeometry(), weight: 0.06 },
  ];
  const farStone = stoneMaterial(textures, { tint: 0.8 });
  const placements = shapes.map(() => []);
  const tints = shapes.map(() => []);
  for (let row = 0; row < 9; row++) {
    const z = -3.0 - row * 2.3 + (rand() - 0.5) * 0.6;
    for (let x = -13; x <= 13; x += 1.5 + rand() * 0.9) {
      if (rand() < 0.25) continue;
      const px = x + (rand() - 0.5) * 0.5;
      if (row === 0 && Math.abs(px) < 1.0) continue;
      const pick = rand();
      let type = 0;
      let acc = 0;
      for (let i = 0; i < shapes.length; i++) {
        acc += shapes[i].weight;
        if (pick < acc) {
          type = i;
          break;
        }
      }
      const scale = 0.8 + rand() * 0.45;
      const tilt = rand() < 0.2 ? 0.28 : 0.12;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(px, heightAt(px, z) - 0.04 - rand() * 0.16, z),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler((rand() - 0.5) * tilt * 1.4, (rand() - 0.5) * 0.5, (rand() - 0.5) * tilt * 1.6),
        ),
        new THREE.Vector3(scale, scale * (0.85 + rand() * 0.3), scale),
      );
      placements[type].push(m);
      const g = 0.55 + rand() * 0.5;
      tints[type].push(new THREE.Color(g, g * (0.98 + rand() * 0.04), g * (0.97 + rand() * 0.06)));
    }
  }
  shapes.forEach((shape, i) => {
    const mesh = new THREE.InstancedMesh(shape.geometry, farStone, placements[i].length);
    placements[i].forEach((m, j) => {
      mesh.setMatrixAt(j, m);
      mesh.setColorAt(j, tints[i][j]);
    });
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    scene.add(mesh);
  });

  // Dead trunks stood on end: broken snags against the fog.
  const bark = new THREE.MeshStandardMaterial({ color: 0x17140f, roughness: 1 });
  const trunks = textures.trees.map(uprightTrunk);
  const trees = [
    { x: -5.2, z: -9.5, h: 7.0, ry: 0.4, v: 0 },
    { x: 2.8, z: -12.5, h: 8.0, ry: 2.1, v: 1 },
    { x: -8.5, z: -6.5, h: 6.5, ry: 4.0, v: 1 },
    { x: 7.5, z: -9.5, h: 7.0, ry: 1.0, v: 0 },
    { x: -12, z: -15, h: 8.0, ry: 2.6, v: 0 },
    { x: 12, z: -17, h: 7.5, ry: 5.1, v: 1 },
  ];
  for (const t of trees) {
    const tree = new THREE.Mesh(trunks[t.v], bark);
    tree.add(new THREE.Mesh(limbs(mulberry32(Math.round(t.h * 1000))), bark));
    tree.scale.set(t.h * 0.6, t.h, t.h * 0.6);
    tree.position.set(t.x, heightAt(t.x, t.z) - 0.1, t.z);
    tree.rotation.set((rand() - 0.5) * 0.12, t.ry, (rand() - 0.5) * 0.12);
    scene.add(tree);
  }

  for (const mesh of clodScatter(textures, rand, { lowQuality })) scene.add(mesh);

  const vegetation = createVegetation(scene, textures.plants, uniforms, { lowQuality, rand, heightAt, graveEdge });

  return { uniforms, headstone, ground, vegetation };
}
