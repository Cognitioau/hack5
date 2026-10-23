import * as THREE from 'three';
import { NOISE_GLSL } from './noise.js';

export const MOON_DIR = new THREE.Vector3(-0.72, 0.2, -1).normalize();

// Shared by the sky dome and the moon overlay, so both agree on where the moon and clouds are.
const SKY_GLSL = /* glsl */ `
  uniform float uTime;
  uniform vec3 uMoonDir;
  ${NOISE_GLSL}
  // Craters: one per cell, a dark floor inside a bright rim.
  float craters(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float c = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 h = vec2(zbHash(vec3(i + g, 1.0)), zbHash(vec3(i + g, 7.0)));
        float r = 0.12 + 0.3 * zbHash(vec3(i + g, 3.0));
        float d = length(g + h - f) / r;
        c += smoothstep(1.15, 0.95, d) * smoothstep(0.6, 0.95, d) * 0.6 - smoothstep(0.95, 0.2, d) * 0.35;
      }
    }
    return c;
  }
  // Returns the moon's colour; disc coverage in w.
  vec4 moonAt(vec3 d) {
    vec3 side = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(side, uMoonDir);
    vec2 mp = vec2(dot(d, side), dot(d, up)) / 0.034;
    float mr = length(mp);
    float aa = fwidth(mr) * 1.2;
    float disc = (1.0 - smoothstep(1.0 - aa, 1.0 + aa, mr)) * step(0.0, dot(d, uMoonDir));
    vec2 sp = mp / sqrt(max(1.0 - min(mr * mr, 0.98), 0.02));
    float maria = smoothstep(0.42, 0.62, zbFbm(vec3(mp * 1.6 + vec2(3.1, 1.7), 4.0)));
    float detail = zbFbm(vec3(sp * 7.0, 2.0));
    float crater = craters(sp * 3.2) + craters(sp * 7.5 + 4.0) * 0.6;
    float albedo = mix(1.0, 0.5, maria) * (0.8 + detail * 0.38) + crater * 0.16;
    float limb = pow(max(1.0 - mr * mr, 0.0), 0.22);
    return vec4(vec3(1.0, 0.98, 0.93) * albedo * mix(0.55, 1.0, limb) * 0.88, disc);
  }
  // Cloud cover (x) and its moonlit rim (y): domain-warped fbm drifting slowly.
  vec2 cloudsAt(vec3 d) {
    float elev = clamp(d.y, -0.2, 1.0);
    vec2 cp = d.xz / (elev + 0.16) * 1.4;
    float t = uTime * 0.014;
    vec2 warp = vec2(zbFbm(vec3(cp * 0.7, t)), zbFbm(vec3(cp * 0.7 + 5.2, t))) - 0.5;
    float c = zbFbm(vec3(cp + warp * 1.6 + vec2(t * 1.2, t * 0.4), t * 0.5));
    c += (zbFbm(vec3(cp * 3.1 - vec2(t * 2.0, 0.0), 1.0)) - 0.5) * 0.35;
    c = smoothstep(0.42, 0.8, c) * smoothstep(-0.05, 0.12, elev);
    float rim = smoothstep(0.05, 0.45, c) * (1.0 - smoothstep(0.45, 0.95, c));
    return vec2(c, rim);
  }
`;

export function createSky(scene, fogColor, overlayScene) {
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
      uniform float uFlash;
      uniform float uBoltX;
      uniform vec3 uFog;
      varying vec3 vDir;
      ${SKY_GLSL}
      void main() {
        vec3 d = normalize(vDir);
        float elev = clamp(d.y, -0.2, 1.0);
        vec3 col = mix(uFog * 1.15, vec3(0.008, 0.011, 0.022), smoothstep(0.0, 0.5, elev));

        vec4 moon = moonAt(d);
        float ang = acos(clamp(dot(d, uMoonDir), -1.0, 1.0));
        float halo = exp(-ang * 7.0) * 0.4 + exp(-ang * 26.0) * 0.55 + exp(-ang * 90.0) * 0.5;
        vec2 cl = cloudsAt(d);
        float c = cl.x;
        vec3 cloudCol = vec3(0.028, 0.034, 0.05) + vec3(0.36, 0.4, 0.5) * halo * (0.25 + cl.y * 2.4);
        col += vec3(0.4, 0.47, 0.62) * halo * 0.3;
        col = mix(col, moon.rgb, moon.w * (1.0 - c * 0.8));
        col = mix(col, cloudCol, c * 0.94);

        // Lightning lights the cloud bank from inside, strongest around the bolt.
        float boltGlow = exp(-pow((d.x - uBoltX) * 2.2, 2.0));
        col += uFlash * (vec3(0.55, 0.6, 0.8) * (0.25 + c) + vec3(0.6, 0.65, 0.9) * boltGlow * c);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 64, 32), material);
  sky.renderOrder = -1;
  scene.add(sky);

  // Depth of field blurs the dome with everything else far away, so the moon's disc is drawn
  // again, sharp, after the blur: a quad on the dome that shares the sky's moon and clouds.
  const overlay = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vDir = normalize(w.xyz);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        ${SKY_GLSL}
        void main() {
          vec3 d = normalize(vDir);
          vec4 moon = moonAt(d);
          float c = cloudsAt(d).x;
          gl_FragColor = vec4(moon.rgb, moon.w * (1.0 - c * 0.85));
          #include <colorspace_fragment>
        }`,
    }),
  );
  const distance = 250;
  overlay.scale.setScalar(distance * Math.tan(0.034) * 2.4);
  overlay.position.copy(MOON_DIR).multiplyScalar(distance);
  overlay.lookAt(0, 0, 0);
  overlay.renderOrder = -1;
  overlay.frustumCulled = false;
  overlayScene?.add(overlay);
  return { uniforms, mesh: sky };
}
