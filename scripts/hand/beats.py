"""Per-frame motion energy and difference-from-first-frame for a take, to find
its beats. Runs on Blender's numpy:  python3 -I beats.py TAKE.mp4"""

import subprocess
import sys

import numpy as np

path = sys.argv[1]
size = int(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width",
                           "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip())
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                     capture_output=True).stdout
frames = np.frombuffer(raw, np.uint8).reshape(-1, size, size).astype(np.float32) / 255
first = frames[0]
for n, f in enumerate(frames):
    motion = 0.0 if n == 0 else float(np.mean(np.abs(f - frames[n - 1])))
    changed = float(np.mean(np.abs(f - first) > 0.12))
    print(f"{n:3d} motion {motion * 1000:6.1f} changed {changed * 100:5.1f}% " + "#" * int(motion * 2000))
