import * as THREE from 'three';
import { NOISE_GLSL } from './noise.js';

// Rotting skin, raw flesh, bone, nail and cloth, picked per vertex by the masks the bake wrote
// (aMat: nail, wound, bone, cloth; aShade: occlusion, curvature, vein, thinness). Everything is
// lit, nothing glows: a green light from the grave tints it only through wrap and translucency.

const PARS = /* glsl */ `
varying vec3 vRest;
varying vec4 vMat;
varying vec4 vShade;
${NOISE_GLSL}
vec3 zSss = vec3(0.0);
float zThin = 0.0;
float zWrapAmt = 0.0;
`;

// Wrap lighting past the terminator and light seen through thin fingers, on top of the standard
// BRDF, so the hand reads as flesh rather than plastic under a hard moon and a glow from below.
const DIRECT = /* glsl */ `
void RE_Direct_Zombie( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  float ndl = dot( geometryNormal, directLight.direction );
  float wrap = max( 0.0, ( ndl + 0.5 ) / 1.5 ) - max( 0.0, ndl );
  float through = pow( saturate( dot( geometryViewDir, -directLight.direction ) ), 4.0 ) * zThin;
  float behind = saturate( -ndl ) * zThin;
  reflectedLight.directDiffuse += directLight.color * zSss * ( wrap * zWrapAmt + through * 0.22 + behind * 0.06 );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Zombie
`;

const COLOR = /* glsl */ `
float zNail = vMat.x;
float zWound = vMat.y;
float zBone = vMat.z;
float zCloth = vMat.w;
float zAO = vShade.x;
float zCav = vShade.y * 2.0 - 1.0;
float zVein = vShade.z;
zThin = smoothstep(0.15, 0.85, vShade.w);
vec3 zP = vRest;
// World size of a pixel, to fade out detail finer than the screen can show.
float zPx = max(length(fwidth(zP)), 1e-5);
float zFadeMid = 1.0 - smoothstep(0.35, 0.9, zPx * 300.0);
float zFadeHi = 1.0 - smoothstep(0.35, 0.9, zPx * 900.0);

float zBlot = zbFbm(zP * 34.0);
float zMottle = zbFbm(zP * 110.0 + 5.0);
float zSpeck = mix(0.5, zbNoise(zP * 700.0), zFadeHi);

// Skin: waxy grey-green dead flesh, mottled with livid purple-grey lividity, sallow green-yellow
// where it is stretched over knuckles and tendons, and pooled dark in the creases.
vec3 zCol = mix(vec3(0.19, 0.205, 0.165), vec3(0.3, 0.3, 0.245), smoothstep(0.3, 0.72, zMottle));
float zLivid = smoothstep(0.42, 0.62, zbFbm(zP * 27.0 + 3.0));
zCol = mix(zCol, vec3(0.25, 0.18, 0.24), zLivid * 0.8);
zCol = mix(zCol, vec3(0.2, 0.16, 0.2), smoothstep(0.55, 0.75, zbFbm(zP * 48.0 + 19.0)) * 0.5);
zCol = mix(zCol, vec3(0.34, 0.34, 0.16), clamp(smoothstep(0.02, 0.3, -zCav) * 0.7 + smoothstep(0.5, 0.7, zbFbm(zP * 21.0 + 11.0)) * 0.45, 0.0, 1.0) * (1.0 - zLivid * 0.6));
zCol = mix(zCol, vec3(0.2, 0.13, 0.13), (1.0 - zAO) * 0.45 + max(zCav, 0.0) * 0.3);
float zNecro = smoothstep(0.56, 0.78, zBlot) * 0.55 + smoothstep(0.17, 0.22, zP.y) * 0.35;
zCol = mix(zCol, vec3(0.14, 0.11, 0.105), clamp(zNecro, 0.0, 1.0) * 0.7);
zCol *= 0.9 + 0.2 * zSpeck;
// Dark veins: the swollen ones the bake raised, and a network under the skin, plainest on the
// back of the hand.
float zDorsal = smoothstep(-0.002, -0.008, zP.z) * step(-0.02, zP.y);
float zCap = 1.0 - smoothstep(0.0, 0.03, abs(zbNoise(zP * vec3(150.0, 55.0, 150.0) + zbNoise(zP * 40.0) * 2.0) - 0.5));
zCol = mix(zCol, vec3(0.1, 0.085, 0.13), zCap * (0.22 + 0.3 * zDorsal) * zFadeMid);
zCol = mix(zCol, vec3(0.07, 0.06, 0.1), zVein * 0.75);
// Torn skin: dark, clotted maroon flesh, a ragged rim of yellowed fat and lifted skin.
float zFibre = zbNoise(zP * vec3(900.0, 120.0, 900.0));
vec3 zFlesh = mix(vec3(0.075, 0.03, 0.022), vec3(0.16, 0.06, 0.042), zFibre * zFadeHi + (1.0 - zFadeHi) * 0.5);
zFlesh = mix(vec3(0.03, 0.01, 0.008), zFlesh, smoothstep(0.25, 0.85, zAO));
float zRim = smoothstep(0.1, 0.35, zWound) * smoothstep(0.75, 0.4, zWound);
zFlesh = mix(zFlesh, vec3(0.26, 0.22, 0.13), zRim * 0.65);
zFlesh = mix(zFlesh, vec3(0.06, 0.045, 0.03), smoothstep(0.55, 0.75, zbFbm(zP * 180.0 + 3.0)) * 0.6);
zCol = mix(zCol, zFlesh, smoothstep(0.1, 0.55, zWound));
// Bone: dull yellow-white, stained brown.
vec3 zBoneCol = mix(vec3(0.5, 0.46, 0.34), vec3(0.3, 0.24, 0.15), smoothstep(0.35, 0.75, zbFbm(zP * 160.0)));
zCol = mix(zCol, zBoneCol, zBone);
// Nails: black-brown horn with lengthwise streaks and cracks.
float zStreak = zbNoise(zP * vec3(1400.0, 90.0, 1400.0));
float zCrack = 1.0 - smoothstep(0.0, 0.05, abs(zbNoise(zP * vec3(420.0, 70.0, 420.0)) - 0.5));
vec3 zNailCol = mix(vec3(0.07, 0.055, 0.035), vec3(0.19, 0.15, 0.09), zStreak * zFadeHi + (1.0 - zFadeHi) * 0.4);
zNailCol *= 1.0 - zCrack * 0.7 * zFadeMid;
zCol = mix(zCol, zNailCol, zNail);
// Cloth: rotten, mud-soaked weave.
float zWeave = mix(0.5, sin(zP.x * 2600.0 + zP.z * 2600.0) * sin(zP.y * 2600.0) * 0.5 + 0.5, zFadeHi);
vec3 zClothCol = mix(vec3(0.055, 0.048, 0.04), vec3(0.13, 0.11, 0.085), zbFbm(zP * 60.0)) * (0.8 + 0.35 * zWeave);
zCol = mix(zCol, zClothCol, zCloth);
// Grave dirt: packed into every crease and under the nail edges, smeared in patches, and caked up
// the forearm where it lay in the soil, its edge ragged and streaked upward by the rain.
float zNailEdge = 1.0 - abs(zNail * 2.0 - 1.0);
float zCakeLine = -0.085 + (zbFbm(zP * vec3(70.0, 9.0, 70.0)) - 0.5) * 0.07 + (zbNoise(zP * vec3(210.0, 14.0, 210.0)) - 0.5) * 0.05;
float zCake = 1.0 - smoothstep(zCakeLine - 0.02, zCakeLine + 0.025, zP.y);
float zDirt = smoothstep(0.0, 0.5, zCav) * 0.8
  + smoothstep(0.85, 0.45, zAO) * 0.6
  + zNailEdge * 1.2
  + zCake * (0.45 + 0.55 * zbFbm(zP * 45.0))
  + smoothstep(0.52, 0.72, zbFbm(zP * 24.0 + 7.0)) * 0.55;
zDirt *= mix(0.5, 1.0, zbFbm(zP * 140.0)) * (1.0 - zWound * 0.7) * (1.0 - zCloth * 0.4) * (1.0 - zBone * 0.5);
zDirt = clamp(zDirt, 0.0, 1.0);
vec3 zDirtCol = mix(vec3(0.085, 0.066, 0.045), vec3(0.15, 0.118, 0.08), zMottle);
zCol = mix(zCol, zDirtCol, zDirt * 0.85);
// Crevices go dark.
zCol *= mix(0.5, 1.0, zAO);
diffuseColor.rgb = zCol;
// What the light picks up inside: a warm, bloodless undertone; deep red in torn flesh.
zSss = mix(vec3(0.34, 0.2, 0.13), vec3(0.2, 0.06, 0.04), zWound) * (1.0 - zNail) * (1.0 - zCloth) * (1.0 - zDirt * 0.6);
zWrapAmt = 0.3 * (1.0 - zNail) * (1.0 - zCloth);
`;

const ROUGHNESS = /* glsl */ `
// Rain-slick: wet over most of the skin, in runnels down the arm, matt only where dirt is caked dry.
float zRun = zbNoise(zP * vec3(160.0, 22.0, 160.0));
float zWet = clamp(smoothstep(0.35, 0.6, zbFbm(zP * 40.0 + 2.0)) + smoothstep(0.55, 0.8, zRun) * 0.6, 0.0, 1.0);
roughnessFactor = mix(0.5, 0.24, zWet);
roughnessFactor = mix(roughnessFactor, 0.72, smoothstep(0.4, 0.9, zDirt) * (1.0 - zWet * 0.6));
roughnessFactor = mix(roughnessFactor, 0.22, smoothstep(0.1, 0.6, zWound));
roughnessFactor = mix(roughnessFactor, 0.48, zBone);
roughnessFactor = mix(roughnessFactor, 0.28, zNail);
roughnessFactor = mix(roughnessFactor, 0.85, zCloth);
roughnessFactor = clamp(roughnessFactor + (zSpeck - 0.5) * 0.12, 0.12, 1.0);
`;

const NORMAL = /* glsl */ `
// Fine relief the mesh cannot carry: crinkled, shrunken skin, pores, flesh fibres, nail ridges and
// the cloth's weave. It breaks up the wet highlights.
vec3 zWp = zP + vec3(zbNoise(zP * 60.0), zbNoise(zP * 60.0 + 7.0), zbNoise(zP * 60.0 + 13.0)) * 0.006;
float zWr = zbNoise(zWp * vec3(300.0, 520.0, 300.0));
float zH = -(1.0 - smoothstep(0.0, 0.1, abs(zWr - 0.5))) * 0.00008 * zFadeHi;
zH += zbFbm(zWp * 220.0) * 0.00022 * zFadeMid;
zH += (zSpeck - 0.5) * 0.000025;
zH *= (1.0 - zNail) * (1.0 - zBone * 0.5) * (1.0 - zCloth);
zH += zWound * (zFibre - 0.5) * 0.00014 * zFadeHi;
zH += zNail * ((zStreak - 0.5) * 0.00004 - zCrack * 0.00007) * zFadeHi;
zH += zCloth * zWeave * 0.00006;
normal = zbPerturb(-vViewPosition, normal, zH, faceDirection);
`;

export function zombieSkinMaterial() {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec4 aMat;\nattribute vec4 aShade;\nvarying vec3 vRest;\nvarying vec4 vMat;\nvarying vec4 vShade;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = position;\nvMat = aMat;\nvShade = aShade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PARS}`)
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${DIRECT}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${COLOR}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${ROUGHNESS}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${NORMAL}`)
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        float zOcc = mix(0.2, 1.0, zAO * zAO);
        reflectedLight.indirectDiffuse *= zOcc;
        reflectedLight.indirectSpecular *= zOcc;
        reflectedLight.directSpecular *= mix(0.25, 1.0, zAO);`,
      );
  };
  material.customProgramCacheKey = () => 'zombie-hand-v3';
  return material;
}
