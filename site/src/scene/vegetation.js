import * as THREE from 'three';

// glTF meshes arrive quantized (normalized int attributes); bake them to plain floats so they can
// be transformed freely.
export function floatGeometry(src) {
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) {
    const size = attr.itemSize;
    const out = new Float32Array(attr.count * size);
    const get = [attr.getX, attr.getY, attr.getZ, attr.getW];
    for (let i = 0; i < attr.count; i++) for (let c = 0; c < size; c++) out[i * size + c] = get[c].call(attr, i);
    g.setAttribute(name, new THREE.BufferAttribute(out, size));
  }
  if (src.index) g.setIndex(new THREE.BufferAttribute(src.index.array.slice(), 1));
  return g;
}

const SPEC = {
  grass_medium_01: { weight: 0.42, scale: [0.75, 1.2], tint: [0.62, 0.66, 0.5] },
  grass_medium_02: { weight: 0.3, scale: [0.85, 1.35], tint: [0.66, 0.66, 0.52] },
  weed_plant_02: { weight: 0.16, scale: [0.55, 0.95], tint: [0.5, 0.56, 0.42] },
  nettle_plant: { weight: 0.12, scale: [0.45, 0.75], tint: [0.7, 0.66, 0.55] },
};

function plantMaterial(source, uniforms, tint, lowQuality) {
  const material = new THREE.MeshStandardMaterial({
    map: source.map,
    alphaTest: 0.5,
    alphaToCoverage: !lowQuality,
    side: THREE.DoubleSide,
    roughness: 0.78,
    envMapIntensity: 0.5,
    color: new THREE.Color(...tint),
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vH;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 zbBase = instanceMatrix[3].xyz;
        float zbSway = sin(uTime * 1.6 + zbBase.x * 3.0 + zbBase.z * 2.0) * 0.6 + sin(uTime * 3.9 + zbBase.x * 9.0) * 0.25;
        float zbY = max(position.y, 0.0);
        transformed.x += zbSway * 0.07 * zbY * zbY;
        transformed.z += zbSway * 0.03 * zbY * zbY;
        vH = clamp(position.y / 0.32, 0.0, 1.0);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vH;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Graded toward the night palette, with the base of each clump in its own shade.
        float zbL = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
        diffuseColor.rgb = mix(vec3(zbL), diffuseColor.rgb, 0.6);
        diffuseColor.rgb *= mix(0.3, 1.0, smoothstep(0.0, 0.7, vH));`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        // Thin blades let the moon through from behind.
        totalEmissiveRadiance += diffuseColor.rgb * vec3(0.16, 0.19, 0.25) * smoothstep(0.1, 1.0, vH);`,
      );
  };
  return material;
}

// Grass clumps, weeds and nettles crowd the old ground and hug the edge of the fresh grave; the
// soil itself, the hand's path and the camera's foreground stay clear.
export function createVegetation(scene, plants, uniforms, { lowQuality, rand, heightAt, graveEdge }) {
  const variants = [];
  for (const [name, root] of Object.entries(plants)) {
    const spec = SPEC[name];
    root.updateMatrixWorld(true);
    let source = null;
    const geometries = [];
    root.traverse((o) => {
      if (!o.isMesh || /LOD[1-9]/i.test(o.name)) return;
      const g = floatGeometry(o.geometry).applyMatrix4(o.matrixWorld);
      g.computeBoundingBox();
      const b = g.boundingBox;
      g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
      geometries.push(g);
      source ??= o.material;
    });
    if (!geometries.length) continue;
    const material = plantMaterial(source, uniforms, spec.tint, lowQuality);
    const share = spec.weight / geometries.length;
    for (const geometry of geometries) variants.push({ name, geometry, material, share, spec, matrices: [] });
  }
  const total = variants.reduce((s, v) => s + v.share, 0);

  const count = lowQuality ? 900 : 3200;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  let placed = 0;
  for (let tries = 0; placed < count && tries < count * 40; tries++) {
    const a = rand() * Math.PI * 2;
    // Half hug the grave, half scatter evenly over the field.
    const field = tries % 3 !== 0;
    const r = field ? 0.6 + Math.sqrt(rand()) * 8.5 : 0.35 + Math.pow(rand(), 2.2) * 2;
    const x = Math.cos(a) * r * 1.15;
    const z = -0.1 + Math.sin(a) * r * 1.35;
    const d = graveEdge(x, z);
    if (d < 0.035) continue;
    // Thickest along the grave's edge, thinning into the dark.
    if (d > 0.35 && d < 1.2 && rand() < 0.3) continue;
    // Keep the face of the headstone readable and the lens clear.
    if (Math.abs(x - 0.02) < 0.5 && z < -1.12 && z > -1.62) continue;
    if (Math.hypot(x - 0.5, z - 1.6) < 0.85) continue;
    let pick = rand() * total;
    let v = variants[0];
    for (const candidate of variants) {
      pick -= candidate.share;
      if (pick <= 0) {
        v = candidate;
        break;
      }
    }
    const [lo, hi] = v.spec.scale;
    let scale = (lo + rand() * (hi - lo)) * (field && d > 0.6 ? 1.25 : 1);
    // Tall weeds only where they cannot hide the action.
    if (v.name === 'nettle_plant' && d < 0.2) scale *= 0.6;
    if (z > 0.6) scale *= 0.75;
    p.set(x, heightAt(x, z) - 0.015, z);
    e.set((rand() - 0.5) * 0.25, rand() * Math.PI * 2, (rand() - 0.5) * 0.25);
    q.setFromEuler(e);
    s.set(scale, scale * (0.85 + rand() * 0.3), scale);
    v.matrices.push(m.compose(p, q, s).clone());
    placed++;
  }

  const meshes = [];
  for (const v of variants) {
    if (!v.matrices.length) continue;
    const mesh = new THREE.InstancedMesh(v.geometry, v.material, v.matrices.length);
    v.matrices.forEach((mat, i) => mesh.setMatrixAt(i, mat));
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    scene.add(mesh);
    meshes.push(mesh);
  }
  return { meshes, count: placed };
}
