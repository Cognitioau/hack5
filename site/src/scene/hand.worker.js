// Builds the zombie hand's mesh off the main thread and hands the arrays back without copying.
import { generateHandGeometry } from './handSdf.js';

self.onmessage = (event) => {
  const result = generateHandGeometry(event.data);
  const transfer = ['positions', 'normals', 'indices', 'skinIndex', 'skinWeight', 'material', 'shading'].map((key) => result[key].buffer);
  self.postMessage(result, transfer);
};
