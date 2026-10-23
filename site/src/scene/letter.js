import * as THREE from 'three';

function envelopeTexture(fontFamily) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 336;
  const ctx = canvas.getContext('2d');
  const paper = ctx.createRadialGradient(256, 168, 40, 256, 168, 330);
  paper.addColorStop(0, '#d9ceb2');
  paper.addColorStop(1, '#a8987a');
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, 512, 336);
  // Rain spots and grave dirt.
  for (let i = 0; i < 140; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 336;
    const r = 2 + Math.random() * (i < 20 ? 22 : 6);
    ctx.fillStyle = i < 20 ? 'rgba(110, 90, 60, 0.18)' : 'rgba(90, 80, 70, 0.12)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(80, 66, 46, 0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(6, 8);
  ctx.lineTo(256, 190);
  ctx.lineTo(506, 8);
  ctx.stroke();
  ctx.fillStyle = 'rgba(40, 34, 30, 0.82)';
  ctx.font = `italic 34px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.fillText('for later', 256, 268);
  ctx.strokeStyle = 'rgba(40, 34, 30, 0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(176, 284);
  ctx.lineTo(336, 284);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

export function createLetter({ fontFamily }) {
  const width = 0.15;
  const depth = 0.098;
  const geometry = new THREE.PlaneGeometry(width, depth, 14, 10);
  geometry.rotateX(-Math.PI / 2);
  // Rain-soaked paper slumps a little at the corners.
  const pos = geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / (width / 2);
    const z = pos.getZ(i) / (depth / 2);
    pos.setY(i, -0.004 * (x * x + z * z) + 0.0015 * Math.sin(x * 3.1 + z * 2.0));
  }
  geometry.computeVertexNormals();

  const letter = new THREE.Group();
  const paper = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      map: envelopeTexture(fontFamily),
      roughness: 0.62,
      side: THREE.DoubleSide,
      // Paper never goes fully black, even turned away from the moon.
      emissive: 0x2a251c,
      emissiveIntensity: 0.35,
    }),
  );
  paper.castShadow = true;
  paper.receiveShadow = true;
  letter.add(paper);

  const seal = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0125, 0.0135, 0.004, 20),
    new THREE.MeshStandardMaterial({ color: 0x6b0f12, roughness: 0.32, metalness: 0.05 }),
  );
  seal.position.set(0, 0.0015, 0.0115);
  seal.castShadow = true;
  letter.add(seal);
  return letter;
}
