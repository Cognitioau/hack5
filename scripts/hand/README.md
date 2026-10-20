# Grave hands

The hand that bursts through the page is matted video footage, not live vector
art or a 3D render. There are three takes; each grab plays one at random, never
the one that played last.

- `assets/grave-hand-{0,1,2}.bin`: each take's frames as WebP files packed back
  to back (48, 62 and 50 frames at 24 fps), then the 35 frames of the heal
  matted onto that take. They are 2× the 260 px display size, so they stay
  sharp on retina screens. Each frame holds two layers side by side: the hand
  on the left and the wall behind it (rim, hole, plaster, shadow) on the
  right.
- `src/ui/grave-sprite.ts`: frame size, hole, beats, the grip point of every
  frame and the heal's frame count. Generated; do not edit.
- `takes.json`: where each take and the heal came from, which of their frames
  are kept, and each take's beats. The publish script and
  `tests/unit/grave.test.ts` both read it.

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

### The heal

Once the hand has gone, the hole mends: footage of the wall bursting open into
the same hole plays backwards, so the plaster flies back in, the star of cracks
closes and the wall is whole.

1. **Wall:** Nano Banana 2 (2K, 1:1) repaired the plate, removing the hole, its
   crater and every crack, with the framing and light unchanged (`heal.wall`).
2. **Burst:** a Seedance 2.5 draft, 4 s, 1:1, 640×640 at 24 fps, with no audio,
   starting on the wall and ending on the plate, so it ends on the takes' own
   hole (within a pixel of where every take ends). The job id is `heal.job`.
   A second draft from a shorter prompt drifted in exposure and ended 4 px off
   the hole, and was dropped.

> Locked-off static camera, perfectly still; the framing never changes: a
> smooth white painted plaster wall seen head-on. For the first half second
> nothing moves. Then the wall is struck very hard from behind at the lower
> centre: the plaster bulges toward the camera, cracks shoot out from the
> impact point, and the wall bursts open. Jagged chunks of white plaster with
> grey broken edges and a little powdery dust are blown out toward the lens,
> tumbling, then fall down and out of the bottom of the frame. What is left is
> a ragged dark round hole with a crumbly grey crater rim and hairline cracks.
> Nothing comes through the hole: no hand, no fist, no object, only the
> breaking wall. The dust clears completely; the final second is the still
> wall with the empty hole. Soft daylight from the upper left. Photoreal,
> sharp, natural motion blur, real-time speed, no camera shake, no zoom.

## Regenerate

Download each take's MP4 from the Higgsfield job in `takes.json`, in order, as
`.cache/hand-takes/t0.mp4` to `t2.mp4`, and the heal's as
`.cache/hand-takes/heal.mp4`. Then:

```sh
PY=/Applications/Blender.app/Contents/Resources/5.2/python/bin/python3.13  # any Python with numpy
for i in 0 1 2; do
  "$PY" -I scripts/hand/matte.py ".cache/hand-takes/t$i.mp4" ".cache/hand-matte/t$i" \
    "$(node -p "require('./scripts/hand/takes.json').takes[$i].edit")"
  "$PY" -I scripts/hand/matte.py .cache/hand-takes/heal.mp4 ".cache/hand-matte/t$i-heal" \
    "$(node -p "require('./scripts/hand/takes.json').heal.edit")" --reverse --like ".cache/hand-matte/t$i"
done
node scripts/hand/publish-hands.mjs .cache/hand-matte/t0 .cache/hand-matte/t1 .cache/hand-matte/t2
npx biome format --write src/ui/grave-sprite.ts
```

This needs ffmpeg, cwebp and Swift on the path, and macOS 14 or later: the
takes' matte asks Apple's Vision framework (`lift.swift`) where the hand is.
The heal needs neither.

## How the scripts work

- **`matte.py`** divides every frame by a model of the bare wall: a quadratic
  fitted to the clean first frame, rescaled per frame so exposure drift
  cancels. Skin, the hole and broken plaster become opaque. The wall's
  shading becomes black at partial alpha, so the hand's shadow falls on a
  light page and vanishes on a dark one. Edge pixels have the wall's share
  removed, so a dark page shows no pale fringe. It also records the hole, and
  a grip point per frame: the head of whatever stays joined to the hole.
- **The hand and the wall** are then written as two layers (`h000.png` and
  `w000.png` onwards), because the page multiplies the wall by its own colour
  before laying the hand over it: on a dark page the rim, plaster and the
  marks the fingers leave turn dark instead of glowing cream. Over white the
  two give back the single layer exactly, so a light page is unchanged.
  `lift.swift` writes Vision's foreground subject for each frame; the hand is
  that subject less whatever still matches the empty hole at the start or the
  end, less pale plaster on the rim. Vision folds broken plaster beside the
  fist into its subject, so on the rim the hand is also kept to the convex
  hull of the hole's core and where the arm crosses out of the rim. A heal is
  all wall.
- **`edit`** (in `takes.json`) picks source frames. `49-75:2` keeps every
  second frame, which quickens the slow drag; a fractional step such as `:1.5`
  quickens a span by that much. The leading `0` and trailing `120` keep the
  empty hole at both ends.
- **`--reverse --like`** mattes the heal onto a take. `--reverse` plays the
  burst backwards, so the heal's `edit` counts from its last frame: it starts
  on the empty hole, quickens the dust and the flying plaster, and ends as
  the cracks close. `--like` crops it to that take's frame and moves its hole
  onto the take's (they differ by a pixel), and fades it out over the crop's
  last 24 px, so plaster flying in from beyond the take's frame fades in
  rather than appearing cut off. It also drops the heal's thin cracks before
  closing gaps: they are shading on the wall, and where they meet the closing
  would fuse them into a patch that hides the page's text.
- **`beats`** are indexes into the edited frames: `slam` (palm flat on the
  wall), `take` (fingers closing on the words) and `fist` (shut). The effect
  lands the fist on the passage and holds it there until the save settles.
  `beats.py` prints per-frame motion to find them.
- **`publish-hands.mjs`** scales every frame to `pack` (0.8125) with
  premultiplied alpha, so the transparent wall's colour never bleeds into the
  hand's edge, and packs each frame's hand and wall side by side. Each take's
  heal frames follow its own in the pack. It encodes each frame with
  `cwebp -q 80 -alpha_q 100` and writes
  the packs and `grave-sprite.ts`. After the fist it keeps the previous grip
  wherever the matte jumps to the hole's rim, and it fails if any beat has no
  grip.

To add or swap a take, generate it from the same plate, find its edit and
beats, and add it to `takes.json`. `tests/unit/grave.test.ts` then checks the
new hand along with the others: its pack, its beats against `takes.json`, the
hole staying on screen in every viewport, and the fist landing on the passage.
