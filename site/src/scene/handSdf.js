// The zombie hand's shape, as a signed distance field, and the bake that turns it into a skinned
// mesh: surface nets, a Newton projection, SDF normals, per-vertex cavity occlusion, material masks
// and skin weights. Plain JS with no three.js import, so it runs as-is inside the module worker.
//
// Bind pose, in metres: forearm along +Y with the wrist at the origin, palm facing +Z (the back of
// the hand is -Z), thumb toward -X. Each bone's frame has +Y along the bone and +Z toward the palm.

import { surfaceNets } from './surfaceNets.js';

export const FINGERS = [
  { base: [-0.03, 0.094, -0.002], len: [0.052, 0.031, 0.025], r: 0.0102, splay: 0.13, claw: 0.009 },
  { base: [-0.0095, 0.1, -0.002], len: [0.057, 0.034, 0.027], r: 0.0106, splay: 0.03, claw: 0.012 },
  { base: [0.011, 0.097, -0.002], len: [0.054, 0.032, 0.026], r: 0.0101, splay: -0.08, claw: 0 },
  { base: [0.029, 0.088, -0.002], len: [0.043, 0.025, 0.023], r: 0.009, splay: -0.2, claw: 0.007 },
];
export const THUMB = {
  base: [-0.022, 0.02, 0.006],
  dir: [-0.6, 0.66, 0.42],
  toward: [0.55, 0.45, 0.7],
  len: [0.041, 0.029, 0.028],
  r: 0.0128,
  claw: 0.008,
};
// Bone order in the skeleton: arm, hand, three per finger, three for the thumb.
export const BONE_COUNT = 17;
const ARM = 0;
const HAND = 1;
const fingerBone = (f, s) => 2 + f * 3 + s;
const thumbBone = (s) => 14 + s;
// The ring finger's tip has rotted down to the bone.
const STRIPPED_FINGER = 2;

const FOREARM_BOTTOM = -0.3;
// Beyond this the field only promises "at least this far", which keeps every sample cheap.
const FAR = 0.009;

const SKIN = 0;
const NAIL = 1;
const CLOTH = 2;
const BONE = 3;
const VEIN = 4;

// ---------------------------------------------------------------------------------------------
// Noise: seeded Perlin, so the hand is the same on every visit.

const PERM = new Uint8Array(512);
{
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = 0x2f6b9a1d;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}
function grad(h, x, y, z) {
  switch (h & 15) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x + z;
    case 5: return -x + z;
    case 6: return x - z;
    case 7: return -x - z;
    case 8: return y + z;
    case 9: return -y + z;
    case 10: return y - z;
    case 11: return -y - z;
    case 12: return x + y;
    case 13: return -x + y;
    case 14: return -y + z;
    default: return -y - z;
  }
}
export function perlin(x, y, z) {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const X = fx & 255;
  const Y = fy & 255;
  const Z = fz & 255;
  x -= fx;
  y -= fy;
  z -= fz;
  const u = x * x * x * (x * (x * 6 - 15) + 10);
  const v = y * y * y * (y * (y * 6 - 15) + 10);
  const w = z * z * z * (z * (z * 6 - 15) + 10);
  const A = PERM[X] + Y;
  const AA = PERM[A] + Z;
  const AB = PERM[A + 1] + Z;
  const B = PERM[X + 1] + Y;
  const BA = PERM[B] + Z;
  const BB = PERM[B + 1] + Z;
  const x1 = x - 1;
  const y1 = y - 1;
  const z1 = z - 1;
  const g000 = grad(PERM[AA], x, y, z);
  const g100 = grad(PERM[BA], x1, y, z);
  const g010 = grad(PERM[AB], x, y1, z);
  const g110 = grad(PERM[BB], x1, y1, z);
  const g001 = grad(PERM[AA + 1], x, y, z1);
  const g101 = grad(PERM[BA + 1], x1, y, z1);
  const g011 = grad(PERM[AB + 1], x, y1, z1);
  const g111 = grad(PERM[BB + 1], x1, y1, z1);
  const a = g000 + u * (g100 - g000);
  const b = g010 + u * (g110 - g010);
  const c = g001 + u * (g101 - g001);
  const d = g011 + u * (g111 - g011);
  const e = a + v * (b - a);
  const f = c + v * (d - c);
  return e + w * (f - e);
}

// ---------------------------------------------------------------------------------------------
// Small vector and primitive helpers. Points are [x, y, z] arrays; bone matrices are column-major.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};
function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
function point(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}
// Inverse of a rigid bone matrix, as a function from world to bone-local coordinates.
function toLocal(m) {
  const tx = m[12];
  const ty = m[13];
  const tz = m[14];
  return (x, y, z, out) => {
    const px = x - tx;
    const py = y - ty;
    const pz = z - tz;
    out[0] = m[0] * px + m[1] * py + m[2] * pz;
    out[1] = m[4] * px + m[5] * py + m[6] * pz;
    out[2] = m[8] * px + m[9] * py + m[10] * pz;
  };
}
function boxAround(points, r) {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let a = 0; a < 3; a++) {
      box[a] = Math.min(box[a], p[a] - r);
      box[a + 3] = Math.max(box[a + 3], p[a] + r);
    }
  }
  return box;
}

// Capsule whose radius runs linearly from ra at a to rb at b.
function capsule(a, b, ra, rb) {
  const bax = b[0] - a[0];
  const bay = b[1] - a[1];
  const baz = b[2] - a[2];
  const bb = bax * bax + bay * bay + baz * baz;
  const fn = (x, y, z) => {
    const pax = x - a[0];
    const pay = y - a[1];
    const paz = z - a[2];
    const h = Math.min(Math.max((pax * bax + pay * bay + paz * baz) / bb, 0), 1);
    const dx = pax - bax * h;
    const dy = pay - bay * h;
    const dz = paz - baz * h;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) - (ra + (rb - ra) * h);
  };
  return { fn, box: boxAround([a, b], Math.max(ra, rb)) };
}
function sphere(c, r) {
  return { fn: (x, y, z) => Math.hypot(x - c[0], y - c[1], z - c[2]) - r, box: boxAround([c], r) };
}
// Ellipsoid in a bone's frame (approximate distance, conservative enough for meshing).
function ellipsoid(m, offset, radii) {
  const local = toLocal(m);
  const q = [0, 0, 0];
  const rmin = Math.min(radii[0], radii[1], radii[2]);
  const fn = (x, y, z) => {
    local(x, y, z, q);
    return (Math.hypot((q[0] - offset[0]) / radii[0], (q[1] - offset[1]) / radii[1], (q[2] - offset[2]) / radii[2]) - 1) * rmin;
  };
  return { fn, box: boxAround([point(m, offset[0], offset[1], offset[2])], Math.max(radii[0], radii[1], radii[2])) };
}
function roundBox(c, half, r) {
  const fn = (x, y, z) => {
    const qx = Math.abs(x - c[0]) - half[0] + r;
    const qy = Math.abs(y - c[1]) - half[1] + r;
    const qz = Math.abs(z - c[2]) - half[2] + r;
    const ox = Math.max(qx, 0);
    const oy = Math.max(qy, 0);
    const oz = Math.max(qz, 0);
    return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
  };
  return { fn, box: [c[0] - half[0], c[1] - half[1], c[2] - half[2], c[0] + half[0], c[1] + half[1], c[2] + half[2]] };
}
// A claw: a capsule in the tip bone's frame, flattened into a curved plate (wide in x, thin in z)
// and snapped off raggedly at the end.
function claw(m, a, b, ra, rb, squash, seed) {
  const local = toLocal(m);
  const q = [0, 0, 0];
  const bax = b[0] - a[0];
  const bay = b[1] - a[1];
  const baz = b[2] - a[2];
  const bl = Math.hypot(bax, bay, baz);
  const bb = bl * bl;
  const fn = (x, y, z) => {
    local(x, y, z, q);
    const pax = q[0] - a[0];
    const pay = q[1] - a[1];
    const paz = q[2] - a[2];
    const along = (pax * bax + pay * bay + paz * baz) / bb;
    const h = Math.min(Math.max(along, 0), 1);
    // Curl the plate around the finger: its edges sit further palmward than its spine.
    const dx = (pax - bax * h) * squash;
    const dz = paz - baz * h - (pax - bax * h) * (pax - bax * h) * 22;
    const dy = pay - bay * h;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - (ra + (rb - ra) * h);
    const jag = (perlin(q[0] * 900 + seed, seed, q[2] * 300) * 0.9 + 0.2) * 0.0026;
    return Math.max(d, (along - 1) * bl + jag);
  };
  return { fn, box: boxAround([point(m, a[0], a[1], a[2]), point(m, b[0], b[1], b[2])], Math.max(ra, rb) / squash + 0.002) };
}

// ---------------------------------------------------------------------------------------------
// The anatomy. Every primitive belongs to one bone; that ownership becomes the skin weights.

function buildAnatomy(bones, cell) {
  const M = (b) => bones.subarray(b * 16, b * 16 + 16);
  const at = (b, x = 0, y = 0, z = 0) => point(M(b), x, y, z);
  const prims = [];
  const put = (owner, group, k, shape) => {
    prims.push({ owner, group, k, fn: shape.fn, box: shape.box });
    return shape;
  };
  // Features thinner than about a cell break up, so thin parts thicken on a coarse grid.
  const thin = (r) => Math.max(r, cell * 0.62);

  // Forearm: radius and ulna under a wasted muscle sheath, a knot of carpals at the wrist and the
  // styloid knobs standing out either side.
  put(ARM, SKIN, 0.008, capsule([-0.0115, FOREARM_BOTTOM, 0.001], [-0.0128, -0.02, 0.002], 0.0108, 0.0094));
  put(ARM, SKIN, 0.008, capsule([0.0105, FOREARM_BOTTOM, -0.003], [0.0136, -0.022, -0.0045], 0.0102, 0.0082));
  const sheath = capsule([0, FOREARM_BOTTOM, 0.001], [0, -0.016, 0.001], 0.0222, 0.0142);
  const sheathFn = (x, y, z) => sheath.fn(x, y, 0.001 + (z - 0.001) * 1.3);
  put(ARM, SKIN, 0.01, { fn: sheathFn, box: sheath.box });
  put(ARM, SKIN, 0.009, ellipsoid(M(ARM), [0, -0.001, 0.002], [0.0215, 0.0115, 0.0102]));
  put(ARM, SKIN, 0.007, sphere([0.0178, -0.018, -0.0045], 0.0052));
  put(ARM, SKIN, 0.007, sphere([-0.0188, -0.014, 0.0015], 0.0046));

  // Palm: a thin wasted slab, the metacarpals standing proud on the back with the hollows between
  // them, and shrunken pads at the heel of the hand.
  put(HAND, SKIN, 0.008, roundBox([0.001, 0.05, 0.0035], [0.022, 0.03, 0.0072], 0.0068));
  const knuckles = FINGERS.map((f, i) => at(fingerBone(i, 0)));
  knuckles.forEach((kn, i) => {
    const root = [kn[0] * 0.5, 0.008, 0.0005];
    // The bone itself, wrapped in the flesh of the palm.
    const flesh = capsule(root, add(kn, [0, -0.006, 0.001]), 0.0085, FINGERS[i].r * 0.9);
    put(HAND, SKIN, 0.008, { fn: (x, y, z) => flesh.fn(x, y, 0.001 + (z - 0.001) * 1.25), box: flesh.box });
    put(HAND, SKIN, 0.0045, capsule([kn[0] * 0.45, 0.014, -0.0035], add(kn, [0, -0.007, -0.0024]), 0.0042, 0.0052));
  });
  put(HAND, SKIN, 0.008, ellipsoid(rotZ(0.5), [-0.006, 0.034, 0.0095], [0.0158, 0.025, 0.0108]));
  put(HAND, SKIN, 0.006, ellipsoid(rotZ(0), [0.022, 0.04, 0.0085], [0.0085, 0.024, 0.0066]));

  // Digits: wasted shafts between knobbly, two-lobed joints, a shrivelled pad at the tip and a long,
  // split, curling nail. The ring finger has rotted to the bone instead.
  const digits = [
    ...FINGERS.map((spec, i) => ({ spec, bone: (s) => fingerBone(i, s), thumb: false, index: i })),
    { spec: THUMB, bone: thumbBone, thumb: true, index: 4 },
  ];
  const wounds = [];
  for (const d of digits) {
    const r = d.spec.r;
    const shaft = d.thumb ? [r * 0.9, r * 0.74, r * 0.68, r * 0.6] : [r * 0.76, r * 0.68, r * 0.63, r * 0.55];
    const joints = [at(d.bone(0)), at(d.bone(1)), at(d.bone(2)), at(d.bone(2), 0, d.spec.len[2], 0)];
    for (let s = 0; s < 3; s++) {
      const owner = d.bone(s);
      put(owner, SKIN, 0.0055, capsule(joints[s], joints[s + 1], shaft[s], shaft[s + 1]));
      if (s === 0 && !d.thumb) {
        // The knuckle on the back of the hand.
        put(owner, SKIN, 0.004, ellipsoid(M(owner), [0, 0.001, -0.0015], [r * 0.84, r * 0.74, r * 0.8]));
      } else if (s > 0) {
        // Interphalangeal joints: a little wider than the shafts, drawn out along the finger so
        // the knuckle swells into it rather than sitting on it like a bead.
        const kr = shaft[s - 1] * 1.04;
        put(owner, SKIN, 0.007, ellipsoid(M(owner), [0, 0.0005, -kr * 0.08], [kr * 1.08, kr * 1.5, kr * 0.92]));
      }
    }
    const tip = d.bone(2);
    const len = d.spec.len[2];
    const tr = shaft[3];
    if (d.index === STRIPPED_FINGER) {
      // Flesh gone from the last joint on: a bare phalanx with its knobbly tuft.
      put(tip, BONE, 0, capsule(at(tip, 0, 0.002, -0.0004), at(tip, 0, len * 0.8, -0.0008), thin(r * 0.3), thin(r * 0.235)));
      put(tip, BONE, 0, ellipsoid(M(tip), [0, len * 0.84, -0.0008], [thin(r * 0.33), thin(r * 0.25), thin(r * 0.26)]));
      put(tip, BONE, 0, ellipsoid(M(tip), [0, 0.0035, -0.0004], [thin(r * 0.42), thin(r * 0.3), thin(r * 0.36)]));
      const strip = ellipsoid(M(tip), [0, len * 0.86, 0], [r * 1.6, len * 0.62, r * 1.6]);
      wounds.push({
        kind: 'strip',
        box: strip.box,
        fn: (x, y, z) => strip.fn(x, y, z) + perlin(x * 520, y * 520 + 4.1, z * 520) * 0.0024,
      });
      continue;
    }
    // Pad of the fingertip, then the long nail it has grown into, curling over the end.
    put(tip, SKIN, 0.003, ellipsoid(M(tip), [0, len * 0.56, tr * 0.18], [tr * 0.92, len * 0.46, tr * 0.86]));
    const reach = d.spec.claw;
    const plate = thin(0.0013);
    put(
      tip,
      NAIL,
      0,
      claw(
        M(tip),
        [0, len * 0.4, -tr * 0.9],
        [0, len + reach, -tr * 0.35 + reach * 0.42],
        plate,
        thin(0.00085),
        plate / (tr * 0.74),
        d.index * 7.3,
      ),
    );
  }

  // Tendons and veins ride on the surface: their paths are dropped onto the bare shape first.
  const base = makeField(prims, [], cell, null);
  const toSurface = (p, lift) => {
    let q = p;
    for (let it = 0; it < 6; it++) {
      const e = 0.0004;
      const d = base(q[0], q[1], q[2]);
      const g = [
        base(q[0] + e, q[1], q[2]) - base(q[0] - e, q[1], q[2]),
        base(q[0], q[1] + e, q[2]) - base(q[0], q[1] - e, q[2]),
        base(q[0], q[1], q[2] + e) - base(q[0], q[1], q[2] - e),
      ];
      const gl = len3(g) || 1;
      q = sub(q, scale(g, (d - lift) / gl));
    }
    return q;
  };
  const tube = (owner, group, path, radius, rise, k, wiggle, seed) => {
    // Catmull-Rom through the control points, about one sample per 2.5 mm, with a little wander.
    const pts = [];
    for (let i = 0; i < path.length - 1; i++) {
      const p0 = path[Math.max(i - 1, 0)];
      const p1 = path[i];
      const p2 = path[i + 1];
      const p3 = path[Math.min(i + 2, path.length - 1)];
      const n = Math.max(2, Math.ceil(len3(sub(p2, p1)) / 0.0025));
      for (let s = 0; s < n; s++) {
        const t = s / n;
        const t2 = t * t;
        const t3 = t2 * t;
        const c = [0, 0, 0].map(
          (_, a) =>
            0.5 *
            (2 * p1[a] + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3),
        );
        const w = wiggle;
        pts.push([
          c[0] + perlin(c[1] * 90 + seed, seed, 0.3) * w,
          c[1],
          c[2] + perlin(c[1] * 90 + seed, seed + 3.7, 0.6) * w * 0.5,
        ]);
      }
    }
    pts.push(path[path.length - 1]);
    const placed = pts.map((p) => toSurface(p, rise - radius));
    for (let i = 0; i < placed.length - 1; i++) {
      const taper = 1 - 0.35 * Math.abs(i / (placed.length - 1) - 0.5) * 2;
      // A vein that crosses the wrist belongs to the forearm below it and to the hand above it;
      // owned whole by the arm, the back of the hand would stay behind when the wrist bends.
      const mid = (placed[i][1] + placed[i + 1][1]) * 0.5;
      const segOwner = owner === ARM || owner === HAND ? (mid < 0 ? ARM : HAND) : owner;
      put(segOwner, group, k, capsule(placed[i], placed[i + 1], radius * taper, radius * taper));
    }
  };

  // Extensor tendons fanning from the wrist to each knuckle, and the flexors at the inner wrist.
  knuckles.forEach((kn, i) => {
    const from = [kn[0] * 0.3, 0.004, -0.01];
    tube(HAND, SKIN, [from, lerp3(from, kn, 0.5), add(kn, [0, -0.008, -0.006])], thin(0.0016), 0.0011, 0.0016, 0.0008, i * 3.1);
  });
  for (const x of [-0.008, 0.0005, 0.0085]) {
    tube(ARM, SKIN, [[x * 0.8, -0.1, 0.02], [x, -0.05, 0.02], [x * 1.1, -0.012, 0.016]], thin(0.0019), 0.0012, 0.002, 0.0004, x * 300);
  }
  // Swollen veins: the dorsal network over the back of the hand, and up the inner forearm.
  const veins = [
    [[0.004, -0.11, -0.02], [0.006, -0.06, -0.02], [-0.002, -0.02, -0.016], [-0.011, 0.025, -0.012], [-0.02, 0.066, -0.01]],
    [[0.017, -0.07, -0.018], [0.016, -0.02, -0.016], [0.012, 0.03, -0.012], [0.021, 0.07, -0.01]],
    [[-0.011, 0.026, -0.012], [0.0, 0.036, -0.012], [0.012, 0.032, -0.012]],
    [[-0.012, -0.11, 0.02], [-0.006, -0.065, 0.022], [-0.009, -0.03, 0.02], [-0.017, -0.004, 0.014]],
    [[0.013, -0.1, 0.02], [0.01, -0.055, 0.022], [0.0045, -0.026, 0.02]],
  ];
  veins.forEach((path, i) => tube(path[0][1] < -0.02 ? ARM : HAND, VEIN, path, thin(0.0013), 0.0011, 0.0012, 0.0016, 11 + i * 5.3));

  // Raw patches where the skin has sloughed off: the inner wrist, and the back of the hand.
  const patch = (c, radii, depth, seed) => {
    const shape = ellipsoid(IDENTITY, c, radii);
    wounds.push({
      kind: 'flesh',
      depth,
      box: shape.box,
      fn: (x, y, z) =>
        shape.fn(x, y, z) +
        (perlin(x * 110 + seed, y * 110, z * 110) * 0.0075 +
          perlin(x * 330, y * 330 + seed, z * 330) * 0.0028 +
          perlin(x * 900, y * 900 + seed, z * 900) * 0.0009),
    });
  };
  patch([-0.006, -0.047, 0.02], [0.0125, 0.02, 0.014], 0.0016, 1.3);
  patch([0.019, 0.03, -0.011], [0.009, 0.013, 0.01], 0.0014, 5.9);
  patch([-0.019, -0.055, -0.012], [0.012, 0.016, 0.012], 0.002, 8.2);

  // What is left of a shirt sleeve: a rotten tube of cloth around the forearm, its top torn ragged.
  const cuff = capsule([0, FOREARM_BOTTOM, 0.001], [0, 0.02, 0.001], 0.0215, 0.0128);
  const sleeve = (x, y, z) => {
    const fold = perlin(x * 70, y * 34, z * 70) * 0.0028 + perlin(x * 210, y * 60, z * 210) * 0.0009;
    const shell = Math.abs(cuff.fn(x, y, 0.001 + (z - 0.001) * 1.22) - 0.0046 - fold) - Math.max(0.0014, cell * 0.7);
    const theta = Math.atan2(z, x);
    const top =
      -0.1 +
      perlin(Math.cos(theta) * 2.1, Math.sin(theta) * 2.1, 3.3) * 0.012 +
      Math.max(0, perlin(Math.cos(theta) * 7, Math.sin(theta) * 7, 8.1)) * 0.06;
    let d = Math.max(shell, y - top, -0.2 - y);
    // Moth-eaten holes.
    d = Math.max(d, (perlin(x * 95 + 2, y * 55, z * 95) - 0.56) * 0.012);
    return d;
  };
  put(ARM, CLOTH, 0, { fn: sleeve, box: [-0.036, -0.2, -0.032, 0.036, -0.03, 0.034] });

  return { prims, wounds };
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function rotZ(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

// Shrivelled skin: lumps, and creases running across the fingers and arm.
function skinDetail(x, y, z) {
  const warp = perlin(x * 45, y * 45, z * 45) * 2.2;
  const lumps = perlin(x * 140 + warp, y * 140, z * 140 - warp);
  const sag = perlin(x * 60 - warp, y * 90, z * 60);
  return lumps * 0.00045 + sag * 0.0005 + (y < -0.02 ? lumps * 0.0003 : 0);
}

// ---------------------------------------------------------------------------------------------
// The field: primitives bucketed on a coarse grid, joined per group, then carved by the wounds.

function makeField(prims, wounds, cell, partsOut) {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    for (let a = 0; a < 3; a++) {
      box[a] = Math.min(box[a], p.box[a]);
      box[a + 3] = Math.max(box[a + 3], p.box[a + 3]);
    }
  }
  const pad = FAR + 0.008;
  const min = [box[0] - pad, box[1] - pad, box[2] - pad];
  const max = [box[3] + pad, box[4] + pad, box[5] + pad];
  const B = 0.006;
  const gx = Math.ceil((max[0] - min[0]) / B);
  const gy = Math.ceil((max[1] - min[1]) / B);
  const gz = Math.ceil((max[2] - min[2]) / B);
  const lists = Array.from({ length: gx * gy * gz }, () => []);
  prims.forEach((p, index) => {
    const m = FAR + p.k + 0.0008;
    const lo = [0, 1, 2].map((a) => Math.max(0, Math.floor((p.box[a] - m - min[a]) / B)));
    const hi = [0, 1, 2].map((a) => Math.min([gx, gy, gz][a] - 1, Math.floor((p.box[a + 3] + m - min[a]) / B)));
    for (let k = lo[2]; k <= hi[2]; k++)
      for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) lists[i + gx * (j + gy * k)].push(index);
  });
  const starts = new Int32Array(lists.length + 1);
  for (let i = 0; i < lists.length; i++) starts[i + 1] = starts[i] + lists[i].length;
  const items = new Int32Array(starts[lists.length]);
  lists.forEach((l, i) => items.set(l, starts[i]));
  const fns = prims.map((p) => p.fn);
  const groups = Int8Array.from(prims.map((p) => p.group));
  const ks = Float32Array.from(prims.map((p) => p.k));
  const woundBoxes = wounds.map((w) => w.box.map((v, a) => v + (a < 3 ? -0.004 : 0.004)));
  const invB = 1 / B;

  const field = (x, y, z) => {
    const bi = Math.floor((x - min[0]) * invB);
    const bj = Math.floor((y - min[1]) * invB);
    const bk = Math.floor((z - min[2]) * invB);
    if (bi < 0 || bj < 0 || bk < 0 || bi >= gx || bj >= gy || bk >= gz) return FAR;
    const b = bi + gx * (bj + gy * bk);
    let skin = FAR;
    let nail = FAR;
    let cloth = FAR;
    let bone = FAR;
    let vein = FAR;
    for (let it = starts[b], end = starts[b + 1]; it < end; it++) {
      const i = items[it];
      const d = fns[i](x, y, z);
      switch (groups[i]) {
        case SKIN:
          skin = smin(skin, d, ks[i]);
          break;
        case VEIN:
          skin = smin(skin, d, ks[i]);
          if (d < vein) vein = d;
          break;
        case NAIL:
          if (d < nail) nail = d;
          break;
        case CLOTH:
          if (d < cloth) cloth = d;
          break;
        default:
          if (d < bone) bone = d;
      }
    }
    const bare = skin;
    const near = Math.abs(skin);
    if (near < 0.003) skin += skinDetail(x, y, z) * (near < 0.002 ? 1 : (0.003 - near) * 1000);
    let wound = 0;
    for (let w = 0; w < wounds.length; w++) {
      const wb = woundBoxes[w];
      if (x < wb[0] || y < wb[1] || z < wb[2] || x > wb[3] || y > wb[4] || z > wb[5]) continue;
      const wd = wounds[w].fn(x, y, z);
      if (wounds[w].kind === 'flesh') {
        // Skin gone, raw stringy flesh a couple of millimetres down, fibres running up the arm.
        const fibre = perlin(x * 420, y * 70, z * 420) * 0.00045 + perlin(x * 140, y * 140, z * 140) * 0.0005;
        const floor = bare + wounds[w].depth + fibre;
        // The torn edge of the skin lifts a little.
        const lip = wd > 0 ? -0.0006 * Math.exp(-((wd / 0.0016) ** 2)) : 0;
        skin = Math.min(Math.max(skin + lip, -wd), floor);
        wound = Math.max(wound, smoothstep(0.0012, -0.0006, wd));
      } else {
        skin = Math.max(skin, -wd);
        wound = Math.max(wound, smoothstep(0.0015, -0.0005, wd));
      }
    }
    let d = smin(skin, nail, 0.0011);
    if (bone < d) d = bone;
    if (cloth < d) d = cloth;
    if (partsOut) {
      partsOut[0] = skin;
      partsOut[1] = nail;
      partsOut[2] = cloth;
      partsOut[3] = bone;
      partsOut[4] = vein;
      partsOut[5] = wound;
    }
    return d < FAR ? d : FAR;
  };
  field.min = min;
  field.max = max;
  field.lists = { starts, items, gx, gy, gz, B, min };
  return field;
}

// ---------------------------------------------------------------------------------------------
// The bake.

export function generateHandGeometry({ cell, bones }) {
  const t0 = performance.now();
  const { prims, wounds } = buildAnatomy(bones, cell);
  const parts = new Float32Array(6);
  const sdf = makeField(prims, wounds, cell, null);
  const classify = makeField(prims, wounds, cell, parts);
  const t1 = performance.now();
  const block = Math.max(2, Math.floor(0.0045 / cell));
  const mesh = surfaceNets(sdf, sdf.min, sdf.max, cell, { block, lipschitz: 1.6 });
  const t2 = performance.now();
  const { positions, indices } = mesh;
  const count = positions.length / 3;
  const normals = new Float32Array(count * 3);
  const material = new Uint8Array(count * 4);
  const shading = new Uint8Array(count * 4);
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const e = cell * 0.35;
  const AO_STEPS = [0.0012, 0.0025, 0.0045, 0.0075];
  const AO_WEIGHTS = [0.32, 0.28, 0.24, 0.16];
  const boneDist = new Float32Array(BONE_COUNT);
  const order = new Int32Array(BONE_COUNT);
  const { starts, items, gx, gy, gz, B, min: lmin } = sdf.lists;
  const owners = Int32Array.from(prims.map((p) => p.owner));
  const fns = prims.map((p) => p.fn);
  const toByte = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

  for (let v = 0; v < count; v++) {
    let x = positions[v * 3];
    let y = positions[v * 3 + 1];
    let z = positions[v * 3 + 2];
    // Two Newton steps pull the vertex onto the true surface.
    let gx_ = 0;
    let gy_ = 0;
    let gz_ = 0;
    for (let step = 0; step < 2; step++) {
      const d = sdf(x, y, z);
      gx_ = (sdf(x + e, y, z) - sdf(x - e, y, z)) / (2 * e);
      gy_ = (sdf(x, y + e, z) - sdf(x, y - e, z)) / (2 * e);
      gz_ = (sdf(x, y, z + e) - sdf(x, y, z - e)) / (2 * e);
      const g2 = gx_ * gx_ + gy_ * gy_ + gz_ * gz_ || 1;
      const s = Math.max(-cell, Math.min(cell, d / Math.sqrt(g2))) / Math.sqrt(g2);
      x -= s * gx_;
      y -= s * gy_;
      z -= s * gz_;
    }
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    const gl = Math.hypot(gx_, gy_, gz_) || 1;
    const nx = gx_ / gl;
    const ny = gy_ / gl;
    const nz = gz_ / gl;
    normals[v * 3] = nx;
    normals[v * 3 + 1] = ny;
    normals[v * 3 + 2] = nz;

    // Cavity occlusion: how much of the space just off the surface the shape itself fills.
    let occ = 0;
    for (let s = 0; s < AO_STEPS.length; s++) {
      const h = AO_STEPS[s];
      const d = sdf(x + nx * h, y + ny * h, z + nz * h);
      occ += AO_WEIGHTS[s] * Math.min(Math.max((h - d) / h, 0), 1);
    }

    // Which material owns this point of the surface.
    classify(x, y, z);
    const [skin, nail, cloth, bone, vein, wound] = parts;
    const lo = Math.min(skin, nail, cloth, bone);
    const isNail = nail <= lo + 0.0003 ? 1 : 0;
    const isCloth = cloth <= lo + 0.0002 ? 1 : 0;
    const isBone = bone <= lo + 0.00025 ? 1 : 0;
    material[v * 4] = isNail * 255;
    material[v * 4 + 1] = toByte(isCloth || isBone ? 0 : wound);
    material[v * 4 + 2] = isBone * 255;
    material[v * 4 + 3] = isCloth * 255;
    shading[v * 4] = toByte(1 - occ);
    shading[v * 4 + 2] = toByte(1 - smoothstep(-0.0004, 0.0011, vein));
    // Thin enough for light to come through: a probe 1 cm in has already left the far side.
    let thin = 0;
    for (const h of [0.007, 0.01, 0.013]) thin += Math.min(Math.max(0.5 + sdf(x - nx * h, y - ny * h, z - nz * h) / 0.006, 0), 1);
    shading[v * 4 + 3] = toByte(thin / 3);

    // Skin weights: each bone's nearest primitive, softly.
    boneDist.fill(Infinity);
    const bi = Math.min(gx - 1, Math.max(0, Math.floor((x - lmin[0]) / B)));
    const bj = Math.min(gy - 1, Math.max(0, Math.floor((y - lmin[1]) / B)));
    const bk = Math.min(gz - 1, Math.max(0, Math.floor((z - lmin[2]) / B)));
    const b = bi + gx * (bj + gy * bk);
    for (let it = starts[b]; it < starts[b + 1]; it++) {
      const i = items[it];
      const d = fns[i](x, y, z);
      if (d < boneDist[owners[i]]) boneDist[owners[i]] = d;
    }
    for (let o = 0; o < BONE_COUNT; o++) order[o] = o;
    order.sort((a, c) => boneDist[a] - boneDist[c]);
    const nearest = boneDist[order[0]];
    let sum = 0;
    for (let w = 0; w < 4; w++) {
      const bw = order[w];
      const weight = Number.isFinite(boneDist[bw]) ? Math.exp(-Math.max(boneDist[bw] - nearest, 0) / 0.0042) : 0;
      skinIndex[v * 4 + w] = bw;
      skinWeight[v * 4 + w] = weight;
      sum += weight;
    }
    for (let w = 0; w < 4; w++) skinWeight[v * 4 + w] /= sum;
    // The arm/hand share of each vertex follows its height, bending smoothly across the wrist and
    // rigidly beyond it, so no skin on the hand follows the forearm (or the reverse) and folds into a
    // fin when the wrist bends.
    let shared = 0;
    let armSlot = -1;
    let handSlot = -1;
    for (let w = 0; w < 4; w++) {
      const bw = skinIndex[v * 4 + w];
      if (bw === ARM) armSlot = w;
      else if (bw === HAND) handSlot = w;
      else continue;
      shared += skinWeight[v * 4 + w];
    }
    if (shared > 0) {
      const toHand = smoothstep(-0.026, 0.026, y);
      const weakestOther = () => {
        let best = -1;
        for (let w = 0; w < 4; w++) {
          if (w === armSlot || w === handSlot) continue;
          if (best < 0 || skinWeight[v * 4 + w] < skinWeight[v * 4 + best]) best = w;
        }
        return best;
      };
      if (toHand < 1 && armSlot < 0) {
        armSlot = toHand === 0 && handSlot >= 0 ? handSlot : weakestOther();
        if (armSlot === handSlot) handSlot = -1;
        skinIndex[v * 4 + armSlot] = ARM;
      }
      if (toHand > 0 && handSlot < 0) {
        handSlot = toHand === 1 && armSlot >= 0 ? armSlot : weakestOther();
        if (handSlot === armSlot) armSlot = -1;
        skinIndex[v * 4 + handSlot] = HAND;
      }
      if (armSlot >= 0) skinWeight[v * 4 + armSlot] = shared * (1 - toHand);
      if (handSlot >= 0) skinWeight[v * 4 + handSlot] = shared * toHand;
      let total = 0;
      for (let w = 0; w < 4; w++) total += skinWeight[v * 4 + w];
      for (let w = 0; w < 4; w++) skinWeight[v * 4 + w] /= total;
    }
  }

  // Curvature from the mesh itself: how far each vertex sits below the average of its neighbours.
  const nsum = new Float32Array(count * 3);
  const ncount = new Uint16Array(count);
  for (let t = 0; t < indices.length; t += 3) {
    for (let c = 0; c < 3; c++) {
      const a = indices[t + c];
      const o = indices[t + ((c + 1) % 3)];
      nsum[a * 3] += positions[o * 3];
      nsum[a * 3 + 1] += positions[o * 3 + 1];
      nsum[a * 3 + 2] += positions[o * 3 + 2];
      nsum[o * 3] += positions[a * 3];
      nsum[o * 3 + 1] += positions[a * 3 + 1];
      nsum[o * 3 + 2] += positions[a * 3 + 2];
      ncount[a]++;
      ncount[o]++;
    }
  }
  for (let v = 0; v < count; v++) {
    const n = ncount[v] || 1;
    const lx = nsum[v * 3] / n - positions[v * 3];
    const ly = nsum[v * 3 + 1] / n - positions[v * 3 + 1];
    const lz = nsum[v * 3 + 2] / n - positions[v * 3 + 2];
    const k = (lx * normals[v * 3] + ly * normals[v * 3 + 1] + lz * normals[v * 3 + 2]) / (cell * 0.35);
    shading[v * 4 + 1] = toByte(0.5 + k * 0.5);
  }
  const t3 = performance.now();

  return {
    positions,
    normals,
    indices,
    skinIndex,
    skinWeight,
    material,
    shading,
    stats: {
      cell,
      vertices: count,
      triangles: indices.length / 3,
      prims: prims.length,
      sampled: mesh.sampled,
      ms: { build: t1 - t0, mesh: t2 - t1, bake: t3 - t2, total: t3 - t0 },
    },
  };
}
