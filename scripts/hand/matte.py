"""Matte a generated take against its own wall.

Each frame is divided by a smooth model of the bare wall (a quadratic fitted
to the clean first frame, rescaled per frame so exposure drift cancels),
giving N: 1 where the wall is untouched, below 1 in shadow, the hand's own
colour where it is. One straight-alpha RGBA layer then reproduces it over any
page:

    out = a*N + (1-a)*s*page

with `a` the opaque hand (hiding text under it) and `s` the wall's shading,
which the layer carries as black at alpha 1-s. Over a white page this is the
footage exactly, whatever `a` is; `a` only decides what happens over text.

That layer is then split in two: the hand itself, and the wall (its rim, the
hole, plaster, shadow, the marks the hand leaves). The page multiplies the
wall by its own colour before laying the hand over it, so on a dark page the
plaster is the page's dark plaster rather than a pale glow. Over white the
two composite back to the single layer exactly.

  python3 -I matte.py TAKE.mp4 OUT_DIR EDIT   (EDIT like "42-56,57-60,68-91:2")
  python3 -I matte.py HEAL.mp4 OUT_DIR EDIT --reverse --like TAKE_OUT_DIR

Needs numpy and ffmpeg; Blender's bundled Python has numpy. A take also needs
macOS 14 or later, for Vision's subject masks (lift.swift). Writes the picked
frames as OUT_DIR/h000.png (hand) and w000.png (wall) onwards and their
metadata as OUT_DIR/matte.json.

`--reverse` plays the clip backwards first, so EDIT counts from its last frame.
`--like` mattes it to overlay a take: cropped to that take's frame, its hole
moved onto the take's, and fading out over the last FEATHER px of the crop,
so what flies in from beyond the take's frame fades in rather than appearing
cut off. It has no hand: all of it is wall.
"""

import json
import os
import subprocess
import sys
import tempfile

import numpy as np

args = sys.argv[1:]
reverse = "--reverse" in args
like = args[args.index("--like") + 1] if "--like" in args else None
path, out, edit = [arg for at, arg in enumerate(args) if not arg.startswith("--") and (at == 0 or args[at - 1] != "--like")]
os.makedirs(out, exist_ok=True)
FEATHER = 24
LIFT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lift.swift")
probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                        "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip().split(",")
W, H = int(probe[0]), int(probe[1])
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                     capture_output=True).stdout
video = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)
if reverse:
    video = video[::-1]

picks = []
for part in edit.split(","):
    span, _, step = part.partition(":")
    a, _, b = span.partition("-")
    first, last, every = int(a), int(b or a), float(step or 1)
    # A fractional step (44-74:1.5) quickens a span by that much, alternating skips.
    picks += [int(first + k * every + 0.5) for k in range(int((last - first) / every) + 1)]


def smoothstep(lo, hi, x):
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def shifted(mask, radius, reduce):
    result = mask.copy()
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx * dx + dy * dy <= radius * radius and (dx or dy):
                result = reduce(result, np.roll(np.roll(mask, dy, 0), dx, 1))
    return result


def closed(mask, radius):
    return shifted(shifted(mask, radius, np.maximum), radius, np.minimum)


def opened(mask, radius):
    return shifted(shifted(mask, radius, np.minimum), radius, np.maximum)


def lum(rgb):
    return rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)


def blocks(mask, k, reduce):
    return reduce(mask.reshape(H // k, k, W // k, k), axis=(1, 3))


def grow(small, k):
    return np.repeat(np.repeat(small, k, 0), k, 1)


def blur(image, radius):
    """Box blur, twice, via cumulative sums."""
    for _ in range(2):
        for axis in (0, 1):
            pad = [(0, 0), (0, 0)]
            pad[axis] = (radius + 1, radius)
            c = np.cumsum(np.pad(image, pad, mode="edge"), axis)
            n = image.shape[axis]
            image = (np.take(c, np.arange(2 * radius + 1, 2 * radius + 1 + n), axis) - np.take(c, np.arange(n), axis)) / (2 * radius + 1)
    return image


def near(core, reach):
    """1 within `reach` px of the hand, fading out over the next `reach`."""
    k = 8
    small = blocks(core, k, np.any)
    small = shifted(small, max(reach // k, 1), np.maximum)
    return np.clip(blur(grow(small.astype(np.float32), k), reach // 2), 0, 1)


def flood(seed, mask):
    """The part of `mask` 4-connected to `seed`."""
    reached = seed & mask
    while True:
        spread = reached.copy()
        spread[1:] |= reached[:-1]
        spread[:-1] |= reached[1:]
        spread[:, 1:] |= reached[:, :-1]
        spread[:, :-1] |= reached[:, 1:]
        spread &= mask
        if (spread == reached).all():
            return reached
        reached = spread


def hull(mask):
    """The convex hull of `mask`, sampled every 4 px."""
    py, px = np.nonzero(mask[::4, ::4])
    points = sorted(set(zip((px * 4).tolist(), (py * 4).tolist())))
    if len(points) < 3:
        return mask

    def chain(points):
        kept = []
        for x, y in points:
            while len(kept) >= 2 and (kept[-1][0] - kept[-2][0]) * (y - kept[-2][1]) - (kept[-1][1] - kept[-2][1]) * (x - kept[-2][0]) <= 0:
                kept.pop()
            kept.append((x, y))
        return kept[:-1]

    corners = chain(points) + chain(points[::-1])
    inside = np.ones((H, W), bool)
    for (x0, y0), (x1, y1) in zip(corners, corners[1:] + corners[:1]):
        inside &= (x1 - x0) * (ys - y0) - (y1 - y0) * (xs - x0) >= 0
    return inside


def subjects(frames):
    """Vision's subject in each of `frames` (indexes into `video`), as 0..1 masks."""
    with tempfile.TemporaryDirectory() as scratch:
        # Vision sees the frames as ffmpeg writes them from the clip, which rounds
        # a little differently from the raw decode; the skin rule was tuned on these.
        subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-start_number", "0", os.path.join(scratch, "f%03d.png")],
                       check=True)
        source = {n: len(video) - 1 - n if reverse else n for n in frames}
        subprocess.run(["swift", LIFT, scratch, *(os.path.join(scratch, f"f{source[n]:03d}.png") for n in frames)],
                       check=True)
        masks = {}
        for n in frames:
            mask = np.zeros((H, W), np.float32)
            for name in os.listdir(scratch):
                if name.startswith(f"f{source[n]:03d}-"):
                    grey = subprocess.run(["ffmpeg", "-v", "error", "-i", os.path.join(scratch, name), "-f", "rawvideo",
                                           "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
                    mask = np.maximum(mask, np.frombuffer(grey, np.uint8).reshape(H, W) / 255)
            masks[n] = mask
        return masks


ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
u, v = xs / W - 0.5, ys / H - 0.5
basis = np.stack([np.ones_like(u), u, v, u * u, u * v, v * v], -1)

# The hole, from the first frame: its dark core and where the rim ends.
first = video[0].astype(np.float32) / 255
dark = lum(first) < 0.25
cy, cx = ys[dark].mean(), xs[dark].mean()
radius = float(np.sqrt(dark.sum() / np.pi))
grid = (slice(4, H, 8), slice(4, W, 8))
outside = (np.hypot(xs - cx, ys - cy) > radius * 2.2)[grid]


def fit(frame):
    """Quadratic fit of the bare wall, ignoring the hole and anything that is
    not wall."""
    samples = frame[grid].reshape(-1, 3)
    design = basis[grid].reshape(-1, 6)
    keep = outside.reshape(-1).copy()
    for _ in range(3):
        coef, *_ = np.linalg.lstsq(design[keep], samples[keep], rcond=None)
        residual = np.abs(design @ coef - samples).max(1)
        keep = outside.reshape(-1) & (residual < 0.025)
    return basis @ coef


# The camera is locked, so the wall's shape comes from the clean first frame;
# each frame only rescales it for exposure drift. (Refitting per frame fails
# when the hand fills most of it: the fit extrapolates from the corners.)
bare = fit(first)


def wall(frame):
    ratio = (frame[grid] / np.maximum(bare[grid], 1e-3)).reshape(-1, 3)
    ratio = ratio[outside.reshape(-1)]
    gain = np.ones(3, np.float32)
    for _ in range(2):
        still = np.abs(ratio / gain - 1).max(1) < 0.06
        if still.sum() > 50:
            gain = np.median(ratio[still], 0)
    return bare * gain


def normal(frame):
    return np.clip(frame / np.maximum(wall(frame), 1e-3), 0, 1.6)


# A take starts and ends on the empty hole: the wall as the hand finds it and
# as it leaves it, with the marks its fingers left.
before, after = normal(first), normal(video[-1].astype(np.float32) / 255)
border = np.zeros((H, W), bool)
border[[0, -1], :] = border[:, [0, -1]] = True
lifted = None if like else subjects(sorted({0, *picks}))
# The rim, as Vision sees it around the empty hole.
rim = None if like else shifted(lifted[0] > 0.5, 6, np.maximum)
# The arm reaches the wall only through the hole, so in the rim the hand lies
# between the hole's core and where the arm crosses out of the rim. Vision
# folds broken plaster beside the fist into its subject; pale, it would print
# cream on a dark page.
throat = np.hypot(xs - cx, ys - cy) < radius * 1.12
ring = None if like else (blur(rim.astype(np.float32), 8) > 0.01) & ~rim


def skin(n, N, s, tint):
    """The hand in source frame n: Vision's subject, less what is still the
    wall as it was before the hand came or as the hand leaves it (the rim,
    the hole, the print it presses into the plaster)."""
    still = (np.abs(N - before).max(-1) < 0.08) | (np.abs(N - after).max(-1) < 0.08)
    # Seedance's rim drifts from frame to frame, so in the rim pale plaster is
    # wall whether or not it still matches, and the rest is hand only where it
    # has clearly changed.
    plaster = rim & (s > 0.62) & (tint < 0.07)
    changed = np.abs(N - before).max(-1) > 0.15
    subject = lifted[n] > 0.5
    hand = subject & ~(still & (s > 0.6)) & ~plaster & (changed | ~rim)
    # Where the arm crosses the rim it can match the plate in thin lines, and
    # the hand's own marks and highlights can match the wall: close and fill.
    hand |= closed(hand, 6) & subject
    hand = opened(hand, 2)
    hand |= ~hand & ~flood(border, ~hand)
    hand &= ~rim | hull((hand & ring) | throat)
    return np.clip(blur(hand.astype(np.float32), 1), 0, 1)


hand_layers, wall_layers, meta, hands = [], [], [], []
touched = np.zeros((H, W), bool)
for n in picks:
    frame = video[n].astype(np.float32) / 255
    N = normal(frame)
    s = np.clip(lum(N), 0, 1)
    # Opaque where clearly not wall: very dark (the hole), tinted (skin), or
    # darker and textured (skin, broken plaster). A cast shadow is neutral and
    # smooth, and stays a shade: opaque, it would print grey on a dark page.
    tint = N.max(-1) - N.min(-1)
    mean = blur(s, 2)
    texture = np.sqrt(np.maximum(blur(s * s, 2) - mean * mean, 0))
    core = (1 - s > 0.45) | (tint > 0.07) | ((1 - s > 0.2) & (texture > 0.025))
    # Highlights on knuckles and nails read as wall: close gaps up to ~12 px,
    # which leaves the wider gaps between fingers open.
    if like:
        # A heal's thin cracks are shading on the wall, not something in front
        # of it: drop them first, or where they meet the closing below fuses
        # them into a patch that would hide the page's text.
        core = shifted(core, 1, np.minimum)
    # A heal has no knuckles: closing only ~6 px gaps keeps its dust grit, not
    # a mass that hides the page.
    core = closed(core, 3 if like else 6)
    core = shifted(core, 1, np.minimum)  # drop single-pixel speckle
    # Edges (and the whole hand when it is out of focus near the lens) mix hand
    # and white wall: N = a*hand + (1-a). Coverage `a` is the pixel's darkening
    # against the nearby hand's; subtracting the wall's share leaves the hand
    # alone, so a dark page shows no pale fringe.
    inner = shifted(core, 3, np.minimum)
    weight = blur(inner.astype(np.float32), 6)
    nearby = np.where(weight > 0.01, blur(s * inner, 6) / np.maximum(weight, 1e-3), 0.5)
    zone = shifted(core, 10, np.maximum)
    a = np.where(inner, 1.0, np.where(zone, np.clip((1 - s) / np.maximum(1 - nearby, 0.15), 0, 1), 0.0)).astype(np.float32)
    shade = np.where(s > 0.985, 1.0, s)  # codec noise on bare wall
    # Beyond the edge, darkening is shadow. Shading only near the hand and
    # hole: the model dims the whole wall as the hand nears the lens, which
    # would print the frame's edge on the page.
    shade = np.where(zone, 1.0, 1 - near(core, 40) * (1 - shade))
    alpha = a + (1 - a) * (1 - shade)
    premultiplied = np.maximum(np.clip(N, 0, 1) - (1 - a)[..., None], 0)
    colour = np.where(alpha[..., None] > 1e-4, premultiplied / np.maximum(alpha, 1e-4)[..., None], 0)
    # The hand over the wall gives back `alpha` exactly, whatever share h of
    # each pixel is hand.
    h = np.zeros((H, W), np.float32) if like else skin(n, N, s, tint)
    over = alpha * h
    under = np.where(over < 0.999, alpha * (1 - h) / np.maximum(1 - over, 1e-3), 0)
    for layers, share in ((hand_layers, over), (wall_layers, under)):
        rgba = np.concatenate([colour, share[..., None]], -1)
        layers.append((np.clip(rgba, 0, 1) * 255 + 0.5).astype(np.uint8))
    hands.append(a > 0.5)
    touched |= (np.clip(alpha, 0, 1) * 255 + 0.5).astype(np.uint8) > 3
    meta.append(dict(source=n))


def attached(mask, seed):
    """The part of `mask` joined to `seed` (flooded on a 4x grid)."""
    k = 4
    open_ = blocks(mask, k, np.any)
    reached = open_ & blocks(seed & mask, k, np.any)
    while True:
        spread = reached.copy()
        spread[1:] |= reached[:-1]
        spread[:-1] |= reached[1:]
        spread[:, 1:] |= reached[:, :-1]
        spread[:, :-1] |= reached[:, 1:]
        spread &= open_
        if (spread == reached).all():
            return grow(reached, k) & mask
        reached = spread


if like:
    # Overlay the take: its crop, with this clip's hole moved onto the take's.
    take = json.load(open(os.path.join(like, "matte.json")))
    if take["source"] != [W, H]:
        raise SystemExit(f"{path} is {W}x{H}, the take is {take['source'][0]}x{take['source'][1]}")
    x0, y0 = take["crop"]
    x1, y1 = x0 + take["size"][0], y0 + take["size"][1]
    dx = round(x0 + take["hole"][0] - cx)
    dy = round(y0 + take["hole"][1] - cy)
    across, down = np.arange(x1 - x0) + 0.5, np.arange(y1 - y0) + 0.5
    inset = np.minimum(np.minimum(across, across[::-1])[None, :], np.minimum(down, down[::-1])[:, None])
    edge = smoothstep(0, FEATHER, inset)

    def placed(layer):
        moved = np.zeros_like(layer)
        moved[max(dy, 0):H + min(dy, 0), max(dx, 0):W + min(dx, 0)] = layer[max(-dy, 0):H - max(dy, 0), max(-dx, 0):W - max(dx, 0)]
        moved = moved[y0:y1, x0:x1].copy()
        moved[..., 3] = (moved[..., 3] * edge + 0.5).astype(np.uint8)
        return moved

    cx, cy = cx + dx, cy + dy
    print("shift", dx, dy)
else:
    # The grip: the head of the arm, which is whatever stays joined to the hole.
    # Marks the hand leaves on the wall come loose from it once the fingers lift,
    # and any still there at the last frame are excluded outright.
    mouth = np.hypot(xs - cx, ys - cy)
    left = shifted(hands[-1] & (mouth > radius * 1.25), 3, np.maximum)
    for hand, entry in zip(hands, meta):
        hand = attached(hand, mouth < radius * 1.6) & (mouth > radius * 1.25) & ~left
        entry["cover"] = round(float(hand.mean()) * 100, 2)
        rows = np.where(hand.sum(1) >= 15)[0]  # a real row of hand, not a stray speck
        if hand.sum() > 400 and len(rows):
            top = int(rows[0])
            head = hand & (ys < top + 70)  # the fist, or the fingers' reach
            entry.update(top=top, grip=[round(float(xs[head].mean()), 1), round(float(ys[head].mean()), 1)])

    # Crop to everything any frame touches, with a margin.
    rows, cols = np.where(touched.any(1))[0], np.where(touched.any(0))[0]
    pad = 6
    y0, y1 = max(rows[0] - pad, 0), min(rows[-1] + pad + 1, H)
    x0, x1 = max(cols[0] - pad, 0), min(cols[-1] + pad + 1, W)

    def placed(layer):
        return layer[y0:y1, x0:x1]
for prefix, layers in (("h", hand_layers), ("w", wall_layers)):
    stack = np.stack([placed(layer) for layer in layers])
    encoder = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{x1 - x0}x{y1 - y0}",
                               "-i", "-", "-start_number", "0", os.path.join(out, f"{prefix}%03d.png")], stdin=subprocess.PIPE)
    encoder.communicate(stack.tobytes())
for entry in meta:
    if "grip" in entry:
        entry["grip"] = [round(entry["grip"][0] - float(x0), 1), round(entry["grip"][1] - float(y0), 1)]
        entry["top"] -= int(y0)
json.dump(dict(size=[int(x1 - x0), int(y1 - y0)], source=[W, H], crop=[int(x0), int(y0)], fps=24,
               hole=[round(float(cx - x0), 1), round(float(cy - y0), 1)], holeRadius=round(radius, 1),
               frames=meta), open(os.path.join(out, "matte.json"), "w"), indent=1)
print("frames", len(meta), "crop", x0, y0, x1, y1, "hole", round(float(cx), 1), round(float(cy), 1), "r", round(radius, 1))
