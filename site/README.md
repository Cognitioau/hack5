# zombiebrain.si

The one-page site for the Zombie Brain Chrome extension: a live three.js graveyard in the rain, a nav that links to [Hackyard Yard #5](https://hackyard.tech/yards/yard-5), a download button and the install steps. Nothing else.

## The scene

A fresh grave at night. Rain falls, lightning flickers behind the stones, and depth of field holds the mound sharp while the graveyard melts into fog. Every 16 seconds the soil trembles, lightning strikes, and a zombie hand bursts through, finds the letter left on the grave, closes on it and drags it under. A fresh letter flutters down, and it starts again. That is the extension's story: you leave a passage and the hand buries it in your Obsidian graveyard.

Everything is generated in code except three CC0 texture sets:

| Module | What it does |
| --- | --- |
| `src/scene/hand.js` | Builds the hand at load: tapered phalanges, knuckle knobs, nails and a forearm as signed distance fields, meshed by surface nets (`surfaceNets.js`) and skinned to a 17-bone rig by distance to each bone. A noise shader adds mottled, bruised, filthy skin. |
| `src/scene/world.js` | Ground on a polar grid (dense at the grave), the mound and the hand's crater, the engraved headstone, rows of distant graves, dead trees and wind-blown grass. |
| `src/scene/sky.js` | Moon, drifting clouds and the lightning glow. |
| `src/scene/rain.js` | GPU rain streaks (drawn after depth of field so they stay crisp) and splash rings. |
| `src/scene/lightning.js` | Irregular strikes: pulsed light, a jagged bolt, and one strike timed to the burst. |
| `src/scene/timeline.js` | The 16-second choreography. It is stepped by a fixed `dt`, so `?t=7.4` replays to exactly that moment and holds it. |
| `src/scene/index.js` | Renderer, lights, camera framing (portrait screens pull back and recentre), postprocessing (depth of field, bloom, vignette, AgX tone mapping, grain), quality tiers and an automatic resolution drop below about 40 fps. |

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

Vercel builds this folder from GitHub. The project's **Root Directory** is `site`. `vercel.json` sets the Vite build and skips deployments for commits that do not touch `site/`.

The Download button points at `https://github.com/Cognitioau/hack5/releases/latest/download/zombie-brain.zip`, so publishing a new GitHub release with an asset named `zombie-brain.zip` updates the download without redeploying the site. Build the zip with `npm run package` in the repository root; it lands in `.cache/packages/`.

`public/poster.jpg` (loading backdrop) and `public/og.jpg` (share card) are frames rendered from the scene itself.

## Credits

- Textures: [Poly Haven](https://polyhaven.com) `forest_ground_04`, `forrest_ground_01` and `rock_boulder_dry`, CC0.
- [three.js](https://threejs.org) (MIT) and [postprocessing](https://github.com/pmndrs/postprocessing) (Zlib).
- Type: Big Shoulders Display, Geist and Geist Mono for the page, and IM Fell English (the Fell Types, revived by Igino Marini) for the headstone and the letter, all SIL Open Font License, served by Google Fonts.
- The zombie-brain mark (`public/favicon.svg`) is drawn for this site.
