import * as THREE from 'three';
import { NOISE_GLSL } from './noise.js';

export const MOON_DIR = new THREE.Vector3(-0.72, 0.2, -1).normalize();

export function createSky(scene, fogColor) {
  const uniforms = {
    uTime: { value: 0 },
    uFlash: { value: 0 },
    uBoltX: { value: 0.3 },
    uMoonDir: { value: MOON_DIR },
    uFog: { value: fogColor },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uFlash;
      uniform float uBoltX;
      uniform vec3 uMoonDir;
      uniform vec3 uFog;
      varying vec3 vDir;
      ${NOISE_GLSL}
      void main() {
        vec3 d = normalize(vDir);
        float elev = clamp(d.y, -0.2, 1.0);
        vec3 col = mix(uFog * 1.15, vec3(0.012, 0.016, 0.03), smoothstep(0.0, 0.45, elev));

        // Moon: a pale disc with darker maria, haloed by the wet air.
        float md = dot(d, uMoonDir);
        float ang = acos(clamp(md, -1.0, 1.0));
        vec3 side = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
        vec3 up = cross(side, uMoonDir);
        vec2 mp = vec2(dot(d, side), dot(d, up)) / 0.036;
        float disc = 1.0 - smoothstep(0.96, 1.0, length(mp));
        float maria = zbFbm(vec3(mp * 2.2, 4.0));
        vec3 moon = mix(vec3(1.35, 1.38, 1.45), vec3(0.75, 0.8, 0.9), smoothstep(0.45, 0.7, maria));
        float halo = exp(-ang * 9.0) * 0.55 + exp(-ang * 40.0) * 0.6;

        // Clouds drift across the moon; their edges catch its light.
        vec2 cp = d.xz / (elev + 0.18) * 1.6;
        float t = uTime * 0.018;
        float c = zbFbm(vec3(cp + vec2(t, t * 0.4), t * 0.5));
        c = smoothstep(0.38, 0.78, c + zbFbm(vec3(cp * 2.7 - vec2(t * 1.6, 0.0), 1.0)) * 0.25);
        float rim = smoothstep(0.25, 0.6, c) * (1.0 - smoothstep(0.6, 0.95, c));
        vec3 cloudCol = vec3(0.045, 0.055, 0.075) + vec3(0.32, 0.36, 0.45) * halo * (0.4 + rim * 2.0);

        col += vec3(0.42, 0.48, 0.62) * halo * 0.35;
        col = mix(col, moon, disc * (1.0 - c * 0.85));
        col = mix(col, cloudCol, c * smoothstep(-0.05, 0.12, elev) * 0.92);

        // Lightning lights the cloud bank from inside, strongest around the bolt.
        float boltGlow = exp(-pow((d.x - uBoltX) * 2.2, 2.0));
        col += uFlash * (vec3(0.55, 0.6, 0.8) * (0.25 + c) + vec3(0.6, 0.65, 0.9) * boltGlow * c);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 48, 24), material);
  sky.renderOrder = -1;
  scene.add(sky);
  return { uniforms, mesh: sky };
}
