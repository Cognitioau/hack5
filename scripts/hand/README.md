# Grave hands

The hand that bursts through the page is matted video footage, not live vector
art or a 3D render. There are three takes; each grab plays one at random, never
the one that played last.

- `assets/grave-hand-{0,1,2}.bin`: each take's frames as WebP files packed back
  to back (48, 62 and 50 frames at 24 fps; 1.5, 1.6 and 1.7 MB). They are 2×
  the 260 px display size, so they stay sharp on retina screens.
- `src/ui/grave-sprite.ts`: frame size, hole, beats and the grip point of every
  frame. Generated; do not edit.
- `takes.json`: where each take came from, which of its frames are kept, and
  its beats. The publish script and `tests/unit/grave.test.ts` both read it.

The pack is not web-accessible. The content script asks for one hand with
`HAND_SPRITE {hand}`, and the background returns its bytes. The page splits
them at the RIFF headers and decodes only a small window of frames around the
one on screen with `createImageBitmap`, closing the rest. No URL reaches the
page, so its image CSP cannot block the hand.

## Source

All three takes were generated on Higgsfield, from one clean plate.

1. **Reference render:** a Blender render of a white wall with a punched
   hole, and no hand, fixes the framing.
2. **Plate:** Nano Banana 2 (2K, 1:1) turned that render into a photograph
   (media `1a29a177-bf97-48d8-a986-47c2e73892f0`, the `plate` in
   `takes.json`).
3. **Takes:** Seedance 2.5 drafts, 5 s, 1:1, 640×640 at 24 fps, with no
   audio. The plate is both the start and the end image, so each take begins
   and ends on the empty hole. The job ids are in `takes.json`.

Takes 0 and 2 used this prompt. Take 0's version ends "The final second is the
empty hole, exactly as at the start."; take 2's stops at "empty hole.":

> Locked-off static camera, perfectly still; the framing never changes: a white
> plaster wall seen head-on with a punched hole in it. For the first half
> second nothing moves. Then a gaunt, rotting zombie hand bursts out of the
> dark hole straight toward the camera, fast and violent: grey-green mottled
> skin, bony knuckles, cracked dirty fingernails, fingers hooked like claws,
> palm facing the lens, the forearm emerging behind it. It lunges at the
> viewer, then whips over and slams down flat against the wall just above the
> hole with a hard impact: the back of the hand pressed flat on the white wall,
> fingers splayed wide, the forearm reaching up out of the hole. The fingertips
> dig in and drag, nails scraping the paint, and the fingers curl and clench
> into a tight fist. Then the fist yanks back down into the hole in one sharp
> motion and vanishes into the darkness. The final second is the empty hole,
> exactly as at the start. Soft daylight from the upper left; the hand casts a
> soft realistic shadow on the wall. Photoreal, sharp, natural motion blur, no
> camera shake, no zoom, nothing else appears.

Take 1:

> Static tripod shot, camera locked, no movement at all. A white plaster wall
> faces the camera with a ragged punched hole near the bottom. Suddenly a
> decayed zombie hand shoots out of the black hole toward the lens, clawed
> fingers spread, palm-first, grey-green rotting skin stretched over bones,
> filthy broken nails. In one continuous motion it slaps down hard and flat
> onto the white wall above the hole, palm pressed against the wall, fingers
> spread, wrist and forearm still coming out of the hole. It holds for a beat,
> then the fingers scrape inward across the wall and close into a clenched
> fist, grabbing. The fist rips back into the hole and is gone. The wall ends
> exactly as it began, empty hole, no new damage. Soft window light from the
> upper left, soft contact shadow under the hand. Realistic, high detail,
> real-time speed, crisp motion.

A fourth take from the first prompt was generated and dropped.

## Regenerate

Download each take's MP4 from the Higgsfield job in `takes.json`, in order, as
`.cache/hand-takes/t0.mp4` to `t2.mp4`. Then:

```sh
PY=/Applications/Blender.app/Contents/Resources/5.2/python/bin/python3.13  # any Python with numpy
for i in 0 1 2; do
  "$PY" -I scripts/hand/matte.py ".cache/hand-takes/t$i.mp4" ".cache/hand-matte/t$i" \
    "$(node -p "require('./scripts/hand/takes.json').takes[$i].edit")"
done
node scripts/hand/publish-hands.mjs .cache/hand-matte/t0 .cache/hand-matte/t1 .cache/hand-matte/t2
npx biome format --write src/ui/grave-sprite.ts
```

This needs ffmpeg and cwebp on the path.

## How the scripts work

- **`matte.py`** divides every frame by a model of the bare wall: a quadratic
  fitted to the clean first frame, rescaled per frame so exposure drift
  cancels. Skin, the hole and broken plaster become an opaque hand. The wall's
  shading becomes black at partial alpha, so the hand's shadow falls on a
  light page and vanishes on a dark one. Edge pixels have the wall's share
  removed, so a dark page shows no pale fringe. It also records the hole, and
  a grip point per frame: the head of whatever stays joined to the hole.
- **`edit`** (in `takes.json`) picks source frames. `49-75:2` keeps every
  second frame, which quickens the slow drag. The leading `0` and trailing
  `120` keep the empty hole at both ends.
- **`beats`** are indexes into the edited frames: `slam` (palm flat on the
  wall), `take` (fingers closing on the words) and `fist` (shut). The effect
  lands the fist on the passage and holds it there until the save settles.
  `beats.py` prints per-frame motion to find them.
- **`publish-hands.mjs`** scales every frame to `pack` (0.8125) with
  premultiplied alpha, so the transparent wall's colour never bleeds into the
  hand's edge. It encodes each frame with `cwebp -q 80 -alpha_q 100` and writes
  the packs and `grave-sprite.ts`. After the fist it keeps the previous grip
  wherever the matte jumps to the hole's rim, and it fails if any beat has no
  grip.

To add or swap a take, generate it from the same plate, find its edit and
beats, and add it to `takes.json`. `tests/unit/grave.test.ts` then checks the
new hand along with the others: its pack, its beats against `takes.json`, the
hole staying on screen in every viewport, and the fist landing on the passage.
