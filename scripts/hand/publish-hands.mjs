// Publishes the matted grave-hand takes into the extension: each take's frames,
// then its heal's, become assets/grave-hand-<n>.bin and their metadata
// src/ui/grave-sprite.ts.
//   node scripts/hand/publish-hands.mjs <matte-dir> <matte-dir> <matte-dir>
// The directories are matte.py output, one per take in scripts/hand/takes.json
// order, each with the heal matted onto it beside it as <matte-dir>-heal.
// Needs ffmpeg and cwebp.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { fps, pack, takes } = JSON.parse(
  await readFile(resolve(root, 'scripts/hand/takes.json'), 'utf8'),
);
const folders = process.argv.slice(2).map((folder) => resolve(folder));
if (folders.length !== takes.length)
  throw new Error(`Expected ${takes.length} matte directories, one per take`);

const round = (value) => Math.round(value * 10) / 10;
const hands = [];
for (const [index, folder] of folders.entries()) {
  const meta = JSON.parse(await readFile(join(folder, 'matte.json'), 'utf8'));
  if (meta.fps !== fps) throw new Error(`${folder} was matted at ${meta.fps} fps, not ${fps}`);
  const heal = JSON.parse(await readFile(join(`${folder}-heal`, 'matte.json'), 'utf8'));
  if (heal.size.join() !== meta.size.join() || heal.crop.join() !== meta.crop.join())
    throw new Error(`${folder}-heal is not matted onto ${folder}: pass --like to matte.py`);
  const { beats } = takes[index];
  const width = Math.round(meta.size[0] * pack);
  const height = Math.round(meta.size[1] * pack);
  const sx = width / meta.size[0];
  const sy = height / meta.size[1];
  const scratch = await mkdtemp(join(tmpdir(), 'grave-hand-'));
  try {
    // Downscale with premultiplied alpha, so the transparent wall's colour
    // never bleeds into the hand's edge. The heal's frames follow the take's.
    for (const [from, prefix] of [
      [folder, 'p'],
      [`${folder}-heal`, 'q'],
    ])
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-start_number',
        '0',
        '-i',
        join(from, 'm%03d.png'),
        '-vf',
        `format=rgba,premultiply=inplace=1,scale=${width}:${height}:flags=area,unpremultiply=inplace=1`,
        '-start_number',
        '0',
        join(scratch, `${prefix}%03d.png`),
      ]);
    const frames = (await readdir(scratch)).filter((name) => name.endsWith('.png')).sort();
    if (frames.length !== meta.frames.length + heal.frames.length)
      throw new Error(
        `${folder}: ${frames.length} frames on disk, ${meta.frames.length + heal.frames.length} in matte.json`,
      );
    const parts = [];
    for (const frame of frames) {
      const out = join(scratch, frame.replace('.png', '.webp'));
      execFileSync('cwebp', [
        '-quiet',
        '-q',
        '80',
        '-alpha_q',
        '100',
        '-m',
        '6',
        '-sharp_yuv',
        join(scratch, frame),
        '-o',
        out,
      ]);
      parts.push(await readFile(out));
    }
    await writeFile(resolve(root, `assets/grave-hand-${index}.bin`), Buffer.concat(parts));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  // The matte occasionally catches the hole's rim instead of the retreating
  // fist; such a jump keeps the previous grip.
  const grip = [];
  for (const [frame, entry] of meta.frames.entries()) {
    const previous = grip[frame - 1];
    const point = entry.grip ? { x: entry.grip[0], y: entry.grip[1] } : null;
    const jump =
      point && previous && frame > beats.fist
        ? Math.hypot(point.x - previous.x / sx, point.y - previous.y / sy) > 40
        : false;
    grip.push(jump ? previous : point && { x: round(point.x * sx), y: round(point.y * sy) });
  }
  for (const beat of ['slam', 'take', 'fist'])
    if (!grip[beats[beat]]) throw new Error(`${folder}: no grip at the ${beat} beat`);
  hands.push({
    path: `assets/grave-hand-${index}.bin`,
    frames: meta.frames.length,
    size: { width, height },
    source: round(meta.source[0] * sx),
    hole: {
      x: round(meta.hole[0] * sx),
      y: round(meta.hole[1] * sy),
      radius: round(meta.holeRadius * sx),
    },
    beats,
    grip,
    heal: heal.frames.length,
  });
}

const point = (value) => (value ? `{ x: ${value.x}, y: ${value.y} }` : 'null');
const entries = hands
  .map(
    (hand) => `  {
    path: '${hand.path}',
    frames: ${hand.frames},
    size: { width: ${hand.size.width}, height: ${hand.size.height} },
    source: ${hand.source},
    hole: { x: ${hand.hole.x}, y: ${hand.hole.y}, radius: ${hand.hole.radius} },
    beats: { slam: ${hand.beats.slam}, take: ${hand.beats.take}, fist: ${hand.beats.fist} },
    grip: [${hand.grip.map(point).join(', ')}],
    heal: ${hand.heal},
  },`,
  )
  .join('\n');
await writeFile(
  resolve(root, 'src/ui/grave-sprite.ts'),
  `/**
 * The grave hands, generated by scripts/hand/publish-hands.mjs from the matted
 * footage takes in scripts/hand/takes.json. Do not edit by hand.
 *
 * Each hand is its footage frames as WebP files packed back to back, played
 * at ${fps} frames a second, then its heal's. Points are in frame pixels;
 * \`source\` is the width of the uncropped footage frame, which the effect
 * sizes a hand by.
 */
export interface GraveHand {
  /** Packaged path, read by the background and handed to the page as bytes. */
  path: string;
  frames: number;
  size: { width: number; height: number };
  source: number;
  /** Centre of the punched hole and the radius of its dark core. */
  hole: { x: number; y: number; radius: number };
  /** Frames where the palm slaps down, the fingers close on the words, and the fist is shut. */
  beats: { slam: number; take: number; fist: number };
  /** Centre of the hand's head for each frame; null once it has gone back through the hole. */
  grip: readonly ({ x: number; y: number } | null)[];
  /**
   * Frames packed after the take's: the wall bursting open into the same hole,
   * played backwards, so the plaster flies back in and the hole heals.
   */
  heal: number;
}

export const GRAVE_FPS = ${fps};

export const GRAVE_HANDS: readonly GraveHand[] = [
${entries}
];
`,
);
for (const hand of hands)
  console.log(`${hand.path}: ${hand.frames} frames, ${hand.size.width}x${hand.size.height}`);
