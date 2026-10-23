import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fbm2, mulberry32, NOISE_GLSL } from './noise.js';

// The grave runs along Z: headstone at the head (-Z), mound toward the camera (+Z).
export const GRAVE = { x: 0, z: -0.25, halfWidth: 0.5, halfLength: 0.98, height: 0.24 };
export const HEADSTONE = { x: 0.02, z: -1.36 };

function moundMask(x, z) {
  const u = (x - GRAVE.x) / GRAVE.halfWidth;
  const v = (z - GRAVE.z) / GRAVE.halfLength;
  const r = Math.pow(Math.pow(Math.abs(u), 2.6) + Math.pow(Math.abs(v), 2.6), 1 / 2.6);
  return Math.max(0, 1 - r);
}

export function heightAt(x, z) {
  const dist = Math.hypot(x, z + 0.4);
  const far = THREE.MathUtils.smoothstep(dist, 2.5, 14);
  let h = (fbm2(x * 0.11 + 4, z * 0.11) - 0.5) * 0.5 * far + far * far * 0.6;
  h += (fbm2(x * 1.3, z * 1.3) - 0.5) * 0.05;
  const m = moundMask(x, z);
  if (m > 0) {
    const r = 1 - m;
    const dome = Math.pow(1 - r * r, 1.5) * GRAVE.height;
    const clods = (fbm2(x * 9, z * 9) - 0.45) * 0.05 * Math.min(1, m * 4);
    h += dome + clods;
  }
  return h;
}

export function normalAt(x, z, target = new THREE.Vector3()) {
  const e = 0.01;
  const dx = heightAt(x + e, z) - heightAt(x - e, z);
  const dz = heightAt(x, z + e) - heightAt(x, z - e);
  return target.set(-dx, 2 * e, -dz).normalize();
}

// Polar grid centred on the grave: about 1.3 cm spacing on the mound, metres at the horizon.
function groundGeometry(lowQuality) {
  const segments = lowQuality ? 260 : 420;
  const radii = [0];
  const inner = lowQuality ? 70 : 100;
  for (let i = 1; i <= inner; i++) radii.push((1.3 * i) / inner);
  let r = 1.3;
  while (r < 110) {
    r *= lowQuality ? 1.06 : 1.04;
    radii.push(r);
  }
  const cx = GRAVE.x;
  const cz = GRAVE.z;
  const positions = [];
  const indices = [];
  positions.push(cx, heightAt(cx, cz), cz);
  for (let ring = 1; ring < radii.length; ring++) {
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const x = cx + Math.cos(a) * radii[ring];
      const z = cz + Math.sin(a) * radii[ring];
      positions.push(x, heightAt(x, z), z);
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
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function groundMaterial(textures, uniforms) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uSoil: { value: textures.soil },
      uSoilN: { value: textures.soilN },
      uGrass: { value: textures.grass },
      uGrassN: { value: textures.grassN },
      uGrave: { value: new THREE.Vector4(GRAVE.x, GRAVE.z, GRAVE.halfWidth, GRAVE.halfLength) },
    });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec4 uHole;
        uniform float uTremble;
        uniform float uTime;
        varying vec3 vWorld;
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
      .replace(
        '#include <begin_vertex>',
        '#include <beginnormal_vertex>\n#include <begin_vertex>',
      )
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
        uniform sampler2D uGrass;
        uniform sampler2D uGrassN;
        uniform vec4 uGrave;
        uniform vec4 uHole;
        varying vec3 vWorld;
        ${NOISE_GLSL}
        float zbMound(vec2 p) {
          vec2 q = abs((p - uGrave.xy) / uGrave.zw);
          float r = pow(pow(q.x, 2.6) + pow(q.y, 2.6), 1.0 / 2.6);
          return 1.0 - smoothstep(0.88, 1.06, r + (zbNoise(vec3(p * 6.0, 1.0)) - 0.5) * 0.18);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec2 zbUvS = vWorld.xz * 1.1;
        vec2 zbUvG = vWorld.xz * 0.55;
        float zbM = zbMound(vWorld.xz);
        float zbVar = zbFbm(vec3(vWorld.xz * 0.35, 2.0));
        vec3 zbSoil = texture2D(uSoil, zbUvS).rgb * vec3(0.5, 0.44, 0.4);
        vec3 zbGrass = texture2D(uGrass, zbUvG).rgb * mix(vec3(0.42, 0.44, 0.36), vec3(0.6, 0.55, 0.42), zbVar);
        float zbHoleR = length(vWorld.xz - uHole.xy);
        zbSoil *= 1.0 - uHole.z * 0.75 * exp(-pow(zbHoleR / 0.06, 2.0));
        diffuseColor.rgb = mix(zbGrass, zbSoil, zbM);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.88, 0.8, zbM);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec3 nS = texture2D(uSoilN, zbUvS).xyz * 2.0 - 1.0;
          vec3 nG = texture2D(uGrassN, zbUvG).xyz * 2.0 - 1.0;
          vec3 nT = normalize(mix(nG * vec3(0.8, 0.8, 1.0), nS * vec3(1.4, 1.4, 1.0), zbM));
          vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          vec3 tW = normalize(vec3(1.0, 0.0, 0.0) - nW * nW.x);
          vec3 bW = cross(tW, nW);
          vec3 world = normalize(tW * nT.x + bW * nT.y + nW * nT.z);
          normal = normalize((viewMatrix * vec4(world, 0.0)).xyz);
        }`,
      );
  };
  return material;
}

function stoneMaterial(textures, { tint = 1, repeat = 1.4 } = {}) {
  const diff = textures.stone.clone();
  const nor = textures.stoneN.clone();
  for (const t of [diff, nor]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.needsUpdate = true;
  }
  const material = new THREE.MeshStandardMaterial({
    map: diff,
    normalMap: nor,
    normalScale: new THREE.Vector2(1.2, 1.2),
    roughness: 0.62,
    color: new THREE.Color(0.62 * tint, 0.64 * tint, 0.66 * tint),
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldS;\nvarying float vLocalY;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vLocalY = position.y;
        vec4 zbWs = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          zbWs = instanceMatrix * zbWs;
        #endif
        vWorldS = (modelMatrix * zbWs).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorldS;\nvarying float vLocalY;\n${NOISE_GLSL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float zbLichen = smoothstep(0.55, 0.75, zbFbm(vWorldS * 7.0));
        float zbDamp = 1.0 - smoothstep(0.0, 0.35, vLocalY);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.19, 0.12), zbLichen * 0.55);
        diffuseColor.rgb *= mix(1.0, 0.45, zbDamp * smoothstep(0.3, 0.7, zbFbm(vWorldS * 4.0 + 2.0)));`,
      );
  };
  return material;
}

function archShape(width, height) {
  const w = width / 2;
  const shoulder = height - w * 0.9;
  const shape = new THREE.Shape();
  shape.moveTo(-w, 0);
  shape.lineTo(w, 0);
  shape.lineTo(w, shoulder);
  shape.quadraticCurveTo(w, height, 0, height);
  shape.quadraticCurveTo(-w, height, -w, shoulder);
  shape.lineTo(-w, 0);
  return shape;
}

function headstoneGeometry(width, height, depth) {
  const geometry = new THREE.ExtrudeGeometry(archShape(width, height), {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.012,
    bevelSegments: 3,
    curveSegments: 18,
  });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

function crossGeometry() {
  const upright = new THREE.BoxGeometry(0.11, 0.95, 0.1);
  upright.translate(0, 0.47, 0);
  const arm = new THREE.BoxGeometry(0.5, 0.1, 0.1);
  arm.translate(0, 0.68, 0);
  return mergeGeometries([upright, arm]);
}

function slabGeometry() {
  const g = new THREE.BoxGeometry(0.55, 0.55, 0.12, 1, 1, 1);
  g.translate(0, 0.27, 0);
  return g;
}

// The epitaph is drawn into a canvas and laid on the stone as an engraving.
function engravingTexture(fontFamily) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 640;
  const ctx = canvas.getContext('2d');
  const lines = [
    { text: 'R · I · P', size: 58, y: 150, spacing: 10 },
    { text: 'THE TABS YOU', size: 44, y: 290, spacing: 4 },
    { text: 'MEANT TO READ', size: 44, y: 350, spacing: 4 },
    { text: 'they rise again', size: 34, y: 450, spacing: 2, italic: true },
  ];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const l of lines) {
    ctx.font = `${l.italic ? 'italic ' : ''}${l.size}px ${fontFamily}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${l.spacing}px`;
    // A lit lower lip and a dark cut sell the engraving under raking moonlight.
    ctx.fillStyle = 'rgba(235, 235, 240, 0.35)';
    ctx.fillText(l.text, 256, l.y + 2.5);
    ctx.fillStyle = 'rgba(8, 8, 10, 0.96)';
    ctx.fillText(l.text, 256, l.y);
  }
  ctx.strokeStyle = 'rgba(14, 14, 18, 0.75)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(176, 214);
  ctx.lineTo(336, 214);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function deadTree(rand, height) {
  const parts = [];
  const grow = (start, dir, length, radius, depth) => {
    const end = start.clone().addScaledVector(dir, length);
    const g = new THREE.CylinderGeometry(radius * 0.68, radius, length, 6, 1, true);
    g.translate(0, length / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    g.translate(start.x, start.y, start.z);
    parts.push(g);
    if (depth === 0 || radius < 0.012) return;
    const children = depth > 2 ? 2 : 2 + Math.floor(rand() * 2);
    for (let c = 0; c < children; c++) {
      const next = dir
        .clone()
        .add(new THREE.Vector3((rand() - 0.5) * 1.5, (rand() - 0.2) * 0.7, (rand() - 0.5) * 1.5))
        .normalize();
      grow(end, next, length * (0.62 + rand() * 0.2), radius * 0.66, depth - 1);
    }
  };
  grow(new THREE.Vector3(0, -0.2, 0), new THREE.Vector3(0.05, 1, 0.02).normalize(), height * 0.42, height * 0.045, 5);
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

function grassBlades(count, rand, uniforms) {
  const blade = new THREE.PlaneGeometry(0.012, 1, 1, 4);
  blade.translate(0, 0.5, 0);
  const pos = blade.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setX(i, pos.getX(i) * (1 - y * 0.92));
    pos.setZ(i, y * y * 0.06);
  }
  blade.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0x4a4836,
    roughness: 0.75,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vTip;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 zbBase = instanceMatrix[3].xyz;
        float zbSway = sin(uTime * 1.7 + zbBase.x * 3.0 + zbBase.z * 2.0) * 0.5 + sin(uTime * 4.1 + zbBase.x * 9.0) * 0.2;
        transformed.x += zbSway * 0.14 * position.y * position.y;
        vTip = position.y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vTip;')
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.rgb *= mix(0.22, 1.0, vTip);',
      );
  };
  const mesh = new THREE.InstancedMesh(blade, material, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const color = new THREE.Color();
  let placed = 0;
  let guard = 0;
  while (placed < count && guard++ < count * 20) {
    const angle = rand() * Math.PI * 2;
    const radius = 0.6 + Math.pow(rand(), 1.6) * 5.5;
    const x = GRAVE.x + Math.cos(angle) * radius * 1.1;
    const z = GRAVE.z + 0.4 + Math.sin(angle) * radius;
    if (Math.abs(x - GRAVE.x) < 0.6 && Math.abs(z - GRAVE.z) < 1.08) continue;
    if (Math.abs(x - HEADSTONE.x) < 0.42 && Math.abs(z - HEADSTONE.z) < 0.16) continue;
    if (Math.hypot(x - 0.5, z - 1.3) < 0.7) continue;
    const clump = 0.12 + rand() * 0.22 + (radius < 2.4 ? 0.06 : 0);
    p.set(x, heightAt(x, z) - 0.01, z);
    q.setFromEuler(new THREE.Euler((rand() - 0.5) * 0.5, rand() * Math.PI * 2, (rand() - 0.5) * 0.5));
    s.set(0.8 + rand() * 0.8, clump, 1);
    m.compose(p, q, s);
    mesh.setMatrixAt(placed, m);
    color.setHSL(0.12 + rand() * 0.05, 0.14 + rand() * 0.12, 0.2 + rand() * 0.14);
    mesh.setColorAt(placed, color);
    placed++;
  }
  mesh.count = placed;
  mesh.receiveShadow = true;
  return mesh;
}

export function createWorld(scene, textures, { lowQuality, fontFamily }) {
  const rand = mulberry32(1031);
  const uniforms = {
    uHole: { value: new THREE.Vector4(0, 0, 0, 0) },
    uTremble: { value: 0 },
    uTime: { value: 0 },
  };

  for (const t of [textures.soil, textures.soilN, textures.grass, textures.grassN]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
  }

  const ground = new THREE.Mesh(groundGeometry(lowQuality), groundMaterial(textures, uniforms));
  ground.receiveShadow = true;
  scene.add(ground);

  const stone = stoneMaterial(textures, { tint: 1.05, repeat: 1.2 });
  const headstone = new THREE.Mesh(headstoneGeometry(0.62, 0.98, 0.13), stone);
  headstone.position.set(HEADSTONE.x, heightAt(HEADSTONE.x, HEADSTONE.z) - 0.06, HEADSTONE.z);
  headstone.rotation.set(-0.035, 0.05, 0.025);
  headstone.castShadow = true;
  headstone.receiveShadow = true;
  scene.add(headstone);

  const engraving = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.625),
    new THREE.MeshStandardMaterial({
      map: engravingTexture(fontFamily),
      transparent: true,
      depthWrite: false,
      roughness: 0.8,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    }),
  );
  engraving.position.set(0, 0.56, 0.065 + 0.0125);
  headstone.add(engraving);

  // Older graves fill the dark in uneven rows; fog does the rest.
  const shapes = [
    { geometry: headstoneGeometry(0.55, 0.85, 0.12), weight: 0.45 },
    { geometry: crossGeometry(), weight: 0.3 },
    { geometry: slabGeometry(), weight: 0.25 },
  ];
  const farStone = stoneMaterial(textures, { tint: 0.75, repeat: 1 });
  const placements = shapes.map(() => []);
  for (let row = 0; row < 9; row++) {
    const z = -3.0 - row * 2.3 + (rand() - 0.5) * 0.6;
    for (let x = -13; x <= 13; x += 1.5 + rand() * 0.9) {
      if (rand() < 0.25) continue;
      const px = x + (rand() - 0.5) * 0.5;
      if (row === 0 && Math.abs(px) < 1.0) continue;
      const pick = rand();
      const type = pick < shapes[0].weight ? 0 : pick < shapes[0].weight + shapes[1].weight ? 1 : 2;
      const scale = 0.8 + rand() * 0.45;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(px, heightAt(px, z) - 0.05, z),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler((rand() - 0.5) * 0.18, (rand() - 0.5) * 0.4, (rand() - 0.5) * 0.22),
        ),
        new THREE.Vector3(scale, scale * (0.85 + rand() * 0.3), scale),
      );
      placements[type].push(m);
    }
  }
  shapes.forEach((shape, i) => {
    const mesh = new THREE.InstancedMesh(shape.geometry, farStone, placements[i].length);
    placements[i].forEach((m, j) => mesh.setMatrixAt(j, m));
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    scene.add(mesh);
  });

  const bark = new THREE.MeshStandardMaterial({ color: 0x14110f, roughness: 1 });
  const trees = [
    { x: -5.0, z: -3.4, h: 5.6, ry: 0.4 },
    { x: 4.4, z: -7.5, h: 6.5, ry: 2.1 },
    { x: -8.5, z: -14, h: 7.5, ry: 4.0 },
    { x: 9.5, z: -17, h: 6.0, ry: 1.0 },
  ];
  for (const t of trees) {
    const tree = new THREE.Mesh(deadTree(mulberry32(Math.round(t.h * 1000)), t.h), bark);
    tree.position.set(t.x, heightAt(t.x, t.z), t.z);
    tree.rotation.y = t.ry;
    scene.add(tree);
  }

  const grass = grassBlades(lowQuality ? 2500 : 7000, rand, uniforms);
  scene.add(grass);

  return { uniforms, headstone, ground };
}
