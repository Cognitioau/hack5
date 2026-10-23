import * as THREE from 'three';

// Poly Haven (CC0) scans: mud_forest for the fresh grave soil, brown_mud_leaves_01 for the old
// ground, lichen_rock for the stones; the plants and dead trunks are Poly Haven models.
// Phones get the 1K textures; desktops get 2K.
const TEXTURES = {
  soil: ['soil_diff', true],
  soilN: ['soil_nor', false],
  // Red: ambient occlusion, green: roughness, blue: displacement height.
  soilA: ['soil_arm', false],
  grass: ['ground_diff', true],
  grassN: ['ground_nor', false, '1k'],
  stone: ['stone_diff', true],
  stoneN: ['stone_nor', false],
  stoneA: ['stone_arm', false],
};

const PLANTS = ['grass_medium_01', 'grass_medium_02', 'weed_plant_02', 'nettle_plant'];
const TREES = ['dead_tree_trunk', 'dead_tree_trunk_02'];

export async function loadAssets(renderer, { low }) {
  const anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), low ? 4 : 16);
  const textureLoader = new THREE.TextureLoader();
  const texture = ([name, srgb, fixedRes]) =>
    textureLoader.loadAsync(`/textures/${name}_${fixedRes ?? (low ? '1k' : '2k')}.webp`).then((t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = anisotropy;
      return t;
    });

  const keys = Object.keys(TEXTURES);
  const texturesLoaded = Promise.all(keys.map((k) => texture(TEXTURES[k])));
  // The loader and decoder ship as their own chunk, fetched alongside the textures.
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/libs/meshopt_decoder.module.js'),
  ]);
  const gltfLoader = new GLTFLoader();
  gltfLoader.setMeshoptDecoder(MeshoptDecoder);
  const model = (name) => gltfLoader.loadAsync(`/models/${name}.glb`).then((g) => g.scene);
  // The big grass set is the heaviest download; phones make do with the small one.
  const plantNames = low ? PLANTS.filter((n) => n !== 'grass_medium_01') : PLANTS;

  const [textures, plants, trees] = await Promise.all([
    texturesLoaded,
    Promise.all(plantNames.map(model)),
    Promise.all(TREES.map(model)),
  ]);
  const out = {};
  keys.forEach((k, i) => (out[k] = textures[i]));
  out.plants = Object.fromEntries(plantNames.map((n, i) => [n, plants[i]]));
  out.trees = trees;
  return out;
}
