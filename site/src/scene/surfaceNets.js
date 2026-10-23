// Naive surface nets: one vertex per grid cell the surface crosses, one quad per crossed edge.
// Smoother than marching cubes for organic shapes, and simple enough to own.

export function surfaceNets(sdf, min, max, cell) {
  const nx = Math.ceil((max[0] - min[0]) / cell) + 1;
  const ny = Math.ceil((max[1] - min[1]) / cell) + 1;
  const nz = Math.ceil((max[2] - min[2]) / cell) + 1;
  const field = new Float32Array(nx * ny * nz);
  const at = (i, j, k) => i + nx * (j + ny * k);

  for (let k = 0; k < nz; k++) {
    const z = min[2] + k * cell;
    for (let j = 0; j < ny; j++) {
      const y = min[1] + j * cell;
      for (let i = 0; i < nx; i++) {
        field[at(i, j, k)] = sdf(min[0] + i * cell, y, z);
      }
    }
  }

  const cellVertex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cellAt = (i, j, k) => i + (nx - 1) * (j + (ny - 1) * k);
  const positions = [];
  const corners = new Float32Array(8);
  const EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = field[at(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
          corners[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let n = 0;
        for (const [a, b] of EDGES) {
          const va = corners[a];
          const vb = corners[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          sx += (a & 1) + ((b & 1) - (a & 1)) * t;
          sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t;
          sz += ((a >> 2) & 1) + (((b >> 2) & 1) - ((a >> 2) & 1)) * t;
          n++;
        }
        cellVertex[cellAt(i, j, k)] = positions.length / 3;
        positions.push(
          min[0] + (i + sx / n) * cell,
          min[1] + (j + sy / n) * cell,
          min[2] + (k + sz / n) * cell,
        );
      }
    }
  }

  const indices = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c);
    else indices.push(a, b, c, a, c, d);
  };

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const inside = field[at(i, j, k)] < 0;
        if (i < nx - 1 && j > 0 && k > 0 && j < ny - 1 && k < nz - 1) {
          if (inside !== field[at(i + 1, j, k)] < 0) {
            quad(
              cellVertex[cellAt(i, j - 1, k - 1)],
              cellVertex[cellAt(i, j, k - 1)],
              cellVertex[cellAt(i, j, k)],
              cellVertex[cellAt(i, j - 1, k)],
              !inside,
            );
          }
        }
        if (j < ny - 1 && i > 0 && k > 0 && i < nx - 1 && k < nz - 1) {
          if (inside !== field[at(i, j + 1, k)] < 0) {
            quad(
              cellVertex[cellAt(i - 1, j, k - 1)],
              cellVertex[cellAt(i - 1, j, k)],
              cellVertex[cellAt(i, j, k)],
              cellVertex[cellAt(i, j, k - 1)],
              !inside,
            );
          }
        }
        if (k < nz - 1 && i > 0 && j > 0 && i < nx - 1 && j < ny - 1) {
          if (inside !== field[at(i, j, k + 1)] < 0) {
            quad(
              cellVertex[cellAt(i - 1, j - 1, k)],
              cellVertex[cellAt(i, j - 1, k)],
              cellVertex[cellAt(i, j, k)],
              cellVertex[cellAt(i - 1, j, k)],
              !inside,
            );
          }
        }
      }
    }
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
