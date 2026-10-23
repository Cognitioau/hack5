# zombiebrain.si

The one-page site for the Zombie Brain Chrome extension: a live three.js graveyard in the rain, a nav that links to [Hackyard Yard #5](https://hackyard.tech/yards/yard-5), a download button and the install steps. Nothing else.

## The scene

A fresh grave at night. Rain falls, lightning flickers behind the stones, and depth of field holds the mound sharp while the graveyard melts into fog. Every 16 seconds the soil trembles, lightning strikes, and a zombie hand bursts through, finds the letter left on the grave, closes on it and drags it under. A fresh letter flutters down, and it starts again. That is the extension's story: you leave a passage and the hand buries it in your Obsidian graveyard.

The hand, the sky, the rain and the lightning are generated in code. The soil, stone and plants are CC0 scans from Poly Haven.

| Module | What it does |
| --- | --- |
| `src/scene/hand.js` | The 17-bone rig and its poses. The mesh is built in a module worker (`hand.worker.js`), and on the main thread if a worker cannot start. |
| `src/scene/handSdf.js` | The hand's anatomy as signed distance fields (phalanges, tendons, nails, a torn sleeve, a forearm wound), meshed by surface nets (`surfaceNets.js`) with per-vertex cavity occlusion, material masks and skin weights. About 120k triangles on desktop and 46k on phones. |
| `src/scene/handMaterial.js` | Wet, rotting skin: mottled livid patches, veins, packed dirt, rain runnels, wrap lighting and light through thin fingers. |
| `src/scene/world.js` | The ground, the mound and the hand's crater, the engraved headstone, rows of distant graves, and the green glow that lives under the grave. |
| `src/scene/vegetation.js` and `assets.js` | Poly Haven grass, weeds, nettles and dead trunks, and the soil, ground and stone textures (2K on desktop, 1K on phones). |
| `src/scene/sky.js` | Moon, drifting clouds and the lightning glow. |
| `src/scene/rain.js` | GPU rain streaks (drawn after depth of field so they stay crisp) and splash rings. |
| `src/scene/lightning.js` | Irregular strikes: pulsed light, a jagged bolt, and one strike timed to the burst. |
| `src/scene/timeline.js` | The 16-second choreography. It is stepped by a fixed `dt`, so `?t=7.4` replays to exactly that moment and holds it. |
| `src/scene/index.js` | Renderer, lights, camera framing (portrait screens pull back and recentre), postprocessing (depth of field, bloom, vignette, AgX tone mapping, grain), quality tiers and an automatic resolution drop when frames run slower than about 28 fps. |

Reduced-motion visitors get the moment the hand has the letter, standing still, with a Play control. Browsers without WebGL 2 get the poster.

## Run it

```sh
cd site
npm ci
npm run dev        # http://localhost:5173
npm run build      # static output in site/dist
```

`?t=<seconds>` freezes the scene at a moment of the cycle (4.6 is the burst, 7.4 the grab, 8.4 the lift).

## Deploy

Vercel builds this folder from GitHub. The project's **Root Directory** is `site`. `vercel.json` sets the Vite build and cache headers.

The Download button points at `https://github.com/Cognitioau/hack5/releases/latest/download/zombie-brain.zip`, so publishing a new GitHub release with an asset named `zombie-brain.zip` updates the download without redeploying the site. Build the zip with `npm run package` in the repository root; it lands in `.cache/packages/`.

`public/poster.jpg` (loading backdrop) and `public/og.jpg` (share card) are frames rendered from the scene itself.

## Credits

- Textures and models: [Poly Haven](https://polyhaven.com), CC0. Textures `mud_forest`, `brown_mud_leaves_01` and `lichen_rock`; models `grass_medium_01`, `grass_medium_02`, `weed_plant_02`, `nettle_plant`, `dead_tree_trunk` and `dead_tree_trunk_02`.
- [three.js](https://threejs.org) (MIT) and [postprocessing](https://github.com/pmndrs/postprocessing) (Zlib).
- Type: Big Shoulders Display, Geist and Geist Mono for the page, and IM Fell English (the Fell Types, revived by Igino Marini) for the headstone and the letter, all SIL Open Font License, served by Google Fonts.
- The zombie-brain mark (`public/favicon.svg`) is drawn for this site.
