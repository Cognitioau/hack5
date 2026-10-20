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

  python3 -I matte.py TAKE.mp4 OUT_DIR EDIT   (EDIT like "42-56,57-60,68-91:2")

Needs numpy and ffmpeg; Blender's bundled Python has numpy. Writes the picked
frames as OUT_DIR/m000.png onwards and their metadata as OUT_DIR/matte.json.
"""

import json
import os
import subprocess
import sys

import numpy as np

path, out, edit = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                        "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip().split(",")
W, H = int(probe[0]), int(probe[1])
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                     capture_output=True).stdout
video = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)

picks = []
for part in edit.split(","):
    span, _, step = part.partition(":")
    a, _, b = span.partition("-")
    picks += list(range(int(a), int(b or a) + 1, int(step or 1)))


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


layers, meta, hands = [], [], []
for n in picks:
    frame = video[n].astype(np.float32) / 255
    N = np.clip(frame / np.maximum(wall(frame), 1e-3), 0, 1.6)
    s = np.clip(lum(N), 0, 1)
    # Opaque where clearly not wall: very dark (the hole), tinted (skin), or
    # darker and textured (skin, broken plaster). A cast shadow is neutral and
    # smooth, and stays a shade: opaque, it would print grey on a dark page.
    tint = N.max(-1) - N.min(-1)
    mean = blur(s, 2)
    texture = np.sqrt(np.maximum(blur(s * s, 2) - mean * mean, 0))
    core = (1 - s > 0.45) | (tint > 0.07) | ((1 - s > 0.2) & (texture > 0.025))
    # Highlights on knuckles and nails read as wall: close gaps up to ~12 px,
    # which leaves the wider gaps between fingers open (on a dark page they
    # would print as white).
    core = shifted(shifted(core, 6, np.maximum), 6, np.minimum)
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
    s = np.where(s > 0.985, 1.0, s)  # codec noise on bare wall
    # Beyond the edge, darkening is shadow. Shading only near the hand and
    # hole: the model dims the whole wall as the hand nears the lens, which
    # would print the frame's edge on the page.
    s = np.where(zone, 1.0, 1 - near(core, 40) * (1 - s))
    alpha = a + (1 - a) * (1 - s)
    premultiplied = np.maximum(np.clip(N, 0, 1) - (1 - a)[..., None], 0)
    colour = np.where(alpha[..., None] > 1e-4, premultiplied / np.maximum(alpha, 1e-4)[..., None], 0)
    rgba = np.concatenate([colour, alpha[..., None]], -1)
    layers.append((np.clip(rgba, 0, 1) * 255 + 0.5).astype(np.uint8))
    hands.append(a > 0.5)
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
touched = np.zeros((H, W), bool)
for layer in layers:
    touched |= layer[..., 3] > 3
rows, cols = np.where(touched.any(1))[0], np.where(touched.any(0))[0]
pad = 6
y0, y1 = max(rows[0] - pad, 0), min(rows[-1] + pad + 1, H)
x0, x1 = max(cols[0] - pad, 0), min(cols[-1] + pad + 1, W)
stack = np.stack([layer[y0:y1, x0:x1] for layer in layers])
encoder = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{x1 - x0}x{y1 - y0}",
                            "-i", "-", "-start_number", "0", os.path.join(out, "m%03d.png")], stdin=subprocess.PIPE)
encoder.communicate(stack.tobytes())
for entry in meta:
    if "grip" in entry:
        entry["grip"] = [round(entry["grip"][0] - float(x0), 1), round(entry["grip"][1] - float(y0), 1)]
        entry["top"] -= int(y0)
json.dump(dict(size=[int(x1 - x0), int(y1 - y0)], source=[W, H], crop=[int(x0), int(y0)], fps=24,
               hole=[round(float(cx - x0), 1), round(float(cy - y0), 1)], holeRadius=round(radius, 1),
               frames=meta), open(os.path.join(out, "matte.json"), "w"), indent=1)
print("frames", len(layers), "crop", x0, y0, x1, y1, "hole", round(float(cx), 1), round(float(cy), 1), "r", round(radius, 1))
