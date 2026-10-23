// Value noise shared by the shaders (GLSL) and the CPU-side terrain (JS), so a clod that lands
// on the mound in JS meets the same surface the shader draws.

export const NOISE_GLSL = /* glsl */ `
float zbHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float zbNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(zbHash(i), zbHash(i + vec3(1, 0, 0)), f.x),
        mix(zbHash(i + vec3(0, 1, 0)), zbHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(zbHash(i + vec3(0, 0, 1)), zbHash(i + vec3(1, 0, 1)), f.x),
        mix(zbHash(i + vec3(0, 1, 1)), zbHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float zbFbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * zbNoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}
// Bump-mapped normal from a scalar height, after three.js's perturbNormalArb.
vec3 zbPerturb(vec3 surfPos, vec3 surfNorm, float height, float faceDirection) {
  vec3 sigmaX = dFdx(surfPos);
  vec3 sigmaY = dFdy(surfPos);
  vec3 r1 = cross(sigmaY, surfNorm);
  vec3 r2 = cross(surfNorm, sigmaX);
  float det = dot(sigmaX, r1) * faceDirection;
  vec3 grad = sign(det) * (dFdx(height) * r1 + dFdy(height) * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`;

function fract(x) {
  return x - Math.floor(x);
}

function hash(x, y, z) {
  x = fract(x * 0.3183099 + 0.1) * 17;
  y = fract(y * 0.3183099 + 0.1) * 17;
  z = fract(z * 0.3183099 + 0.1) * 17;
  return fract(x * y * z * (x + y + z));
}

export function noise3(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  let fx = x - ix;
  let fy = y - iy;
  let fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const lerp = (a, b, t) => a + (b - a) * t;
  return lerp(
    lerp(
      lerp(hash(ix, iy, iz), hash(ix + 1, iy, iz), fx),
      lerp(hash(ix, iy + 1, iz), hash(ix + 1, iy + 1, iz), fx),
      fy,
    ),
    lerp(
      lerp(hash(ix, iy, iz + 1), hash(ix + 1, iy, iz + 1), fx),
      lerp(hash(ix, iy + 1, iz + 1), hash(ix + 1, iy + 1, iz + 1), fx),
      fy,
    ),
    fz,
  );
}

export function fbm2(x, z, octaves = 4) {
  let a = 0.5;
  let s = 0;
  for (let i = 0; i < octaves; i++) {
    s += a * noise3(x, 0.5, z);
    x = x * 2.03 + 1.7;
    z = z * 2.03 + 3.1;
    a *= 0.5;
  }
  return s;
}

// Deterministic PRNG so the graveyard is laid out the same on every visit.
export function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
