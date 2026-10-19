# Grave hand render

The hand that bursts through the page is a pre-rendered frame atlas, not live
vector art. `grave_hand.py` builds it in headless Blender and
`publish-sprite.mjs` packs it into the extension:

- `assets/grave-hand.webp`: 20 frames (12 rise, 8 grab), about 210 KB.
- `src/ui/grave-sprite.ts`: frame size, wrist anchor, rig scale and the fist's
  grip point. Generated; do not edit.

## Source

The forearm and hand are cut from the MakeHuman 1.x base mesh, bound to its
default skeleton and weights. All three are CC0 (MakeHuman `license.txt`,
section C). They are fetched at a pinned commit and checked by hash:

| File | SHA-256 |
| --- | --- |
| `makehuman/data/3dobjs/base.obj` | `8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c` |
| `makehuman/data/rigs/default.mhskel` | `99f179bce0aa850b45d4191a1d0d234c5851f881c057439470ded3bddf729a24` |
| `makehuman/data/rigs/default_weights.mhw` | `0f3641d651ae3d00ad6b4ccee43142edb109d3bd909d27d9e4139ef1beed8625` |

## Regenerate

```sh
MH=.cache/makehuman && mkdir -p "$MH"
for f in 3dobjs/base.obj rigs/default.mhskel rigs/default_weights.mhw; do
  curl -sfL -o "$MH/$(basename "$f")" \
    "https://raw.githubusercontent.com/makehumancommunity/makehuman/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/makehuman/data/$f"
done
shasum -a 256 "$MH"/*   # compare with the table above
blender -b --factory-startup -P scripts/hand/grave_hand.py -- "$MH" .cache/hand-render frames
node scripts/hand/publish-sprite.mjs .cache/hand-render   # needs cwebp
npx biome format --write src/ui/grave-sprite.ts
```

`look` mode renders single poses for art direction instead of frames:
`… -- "$MH" .cache/hand-look look claw,fist -25`.

What the script does:

- **Shape:** lengthens the phalanges, wastes the flesh between the joints and
  leaves the knuckles proud.
- **Rig:** poses the real finger bones through a volume-preserving armature.
- **Surface and light:** shades rotting grey-green skin from rest-pose
  coordinates, so the texture never swims, under a cold moonlit rim.
- **Frame window:** reaches 17 cm below the wrist. This keeps the cut end of the
  forearm underground even at the rise's overshoot, which `tests/unit/grave.test.ts`
  guards.
