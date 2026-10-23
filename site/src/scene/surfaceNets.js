// Naive surface nets: one vertex per grid cell the surface crosses, one quad per crossed edge.
// Smoother than marching cubes for organic shapes, and simple enough to own.
//
// The field is sampled in a narrow band. A block of block³ samples is first tested at its centre;
// when the surface cannot reach the block (|d| beyond the block's half-diagonal times the field's
// Lipschitz bound) every sample in it takes that one value, which has the right sign. Only blocks
// the surface may cross are sampled in full, so a fine grid costs roughly its surface, not its volume.

export function surfaceNets(sdf, min, max, cell, { block = 3, lipschitz = 1.6 } = {}) {
  const nx = Math.ceil((max[0] - min[0]) / cell) + 1;
  const ny = Math.ceil((max[1] - min[1]) / cell) + 1;
  const nz = Math.ceil((max[2] - min[2]) / cell) + 1;
  const field = new Float32Array(nx * ny * nz);
  const sxy = nx * ny;

  const bnx = Math.ceil(nx / block);
  const bny = Math.ceil(ny / block);
  const bnz = Math.ceil(nz / block);
  const reach = ((block - 1) * 0.5 * Math.sqrt(3) + 0.5) * cell * lipschitz + cell;
  let sampled = 0;
  for (let bk = 0; bk < bnz; bk++) {
    const k0 = bk * block;
    const k1 = Math.min(k0 + block, nz);
    for (let bj = 0; bj < bny; bj++) {
      const j0 = bj * block;
      const j1 = Math.min(j0 + block, ny);
      for (let bi = 0; bi < bnx; bi++) {
        const i0 = bi * block;
        const i1 = Math.min(i0 + block, nx);
        const c = sdf(
          min[0] + (i0 + (block - 1) * 0.5) * cell,
          min[1] + (j0 + (block - 1) * 0.5) * cell,
          min[2] + (k0 + (block - 1) * 0.5) * cell,
        );
        sampled++;
        const far = c > reach || c < -reach;
        for (let k = k0; k < k1; k++) {
          const z = min[2] + k * cell;
          for (let j = j0; j < j1; j++) {
            const y = min[1] + j * cell;
            let at = i0 + nx * j + sxy * k;
            if (far) {
              for (let i = i0; i < i1; i++) field[at++] = c;
            } else {
              for (let i = i0; i < i1; i++) field[at++] = sdf(min[0] + i * cell, y, z);
              sampled += i1 - i0;
            }
          }
        }
      }
    }
  }

  const cx = nx - 1;
  const cxy = (nx - 1) * (ny - 1);
  const cellVertex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  let positions = new Float32Array(1 << 16);
  let vertexCount = 0;
  const corners = new Float32Array(8);
  const EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];
  const offsets = [0, 1, nx, nx + 1, sxy, sxy + 1, sxy + nx, sxy + nx + 1];

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      let base = nx * j + sxy * k;
      for (let i = 0; i < nx - 1; i++, base++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = field[base + offsets[c]];
          corners[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let n = 0;
        for (let e = 0; e < 24; e += 2) {
          const a = EDGES[e];
          const b = EDGES[e + 1];
          const va = corners[a];
          const vb = corners[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          sx += (a & 1) + ((b & 1) - (a & 1)) * t;
          sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t;
          sz += ((a >> 2) & 1) + (((b >> 2) & 1) - ((a >> 2) & 1)) * t;
          n++;
        }
        if (vertexCount * 3 + 3 > positions.length) {
          const grown = new Float32Array(positions.length * 2);
          grown.set(positions);
          positions = grown;
        }
        cellVertex[i + cx * j + cxy * k] = vertexCount;
        positions[vertexCount * 3] = min[0] + (i + sx / n) * cell;
        positions[vertexCount * 3 + 1] = min[1] + (j + sy / n) * cell;
        positions[vertexCount * 3 + 2] = min[2] + (k + sz / n) * cell;
        vertexCount++;
      }
    }
  }

  let indices = new Uint32Array(1 << 17);
  let indexCount = 0;
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (indexCount + 6 > indices.length) {
      const grown = new Uint32Array(indices.length * 2);
      grown.set(indices);
      indices = grown;
    }
    if (flip) {
      indices[indexCount++] = a;
      indices[indexCount++] = c;
      indices[indexCount++] = b;
      indices[indexCount++] = a;
      indices[indexCount++] = d;
      indices[indexCount++] = c;
    } else {
      indices[indexCount++] = a;
      indices[indexCount++] = b;
      indices[indexCount++] = c;
      indices[indexCount++] = a;
      indices[indexCount++] = c;
      indices[indexCount++] = d;
    }
  };
  const cellAt = (i, j, k) => i + cx * (j + (ny - 1) * k);

  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const at = i + nx * j + sxy * k;
        const inside = field[at] < 0;
        if (inside !== field[at + 1] < 0) {
          quad(cellVertex[cellAt(i, j - 1, k - 1)], cellVertex[cellAt(i, j, k - 1)], cellVertex[cellAt(i, j, k)], cellVertex[cellAt(i, j - 1, k)], !inside);
        }
        if (inside !== field[at + nx] < 0) {
          quad(cellVertex[cellAt(i - 1, j, k - 1)], cellVertex[cellAt(i - 1, j, k)], cellVertex[cellAt(i, j, k)], cellVertex[cellAt(i, j, k - 1)], !inside);
        }
        if (inside !== field[at + sxy] < 0) {
          quad(cellVertex[cellAt(i - 1, j - 1, k)], cellVertex[cellAt(i, j - 1, k)], cellVertex[cellAt(i, j, k)], cellVertex[cellAt(i - 1, j, k)], !inside);
        }
      }
    }
  }

  return {
    positions: positions.slice(0, vertexCount * 3),
    indices: indices.slice(0, indexCount),
    sampled,
  };
}
