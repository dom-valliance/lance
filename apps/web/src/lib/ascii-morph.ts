/**
 * The maths behind the sign-in page's ASCII morph: a luminance grid
 * becomes glyph cells, the cells of two pictures are paired into
 * particles, and each particle's position at a moment of the transition
 * is a pure function of that moment. The canvas component draws; nothing
 * here touches the DOM, so every step is testable in node.
 */

/** Darkest to brightest. A cell dimmer than the first step draws nothing. */
export const RAMP = '.:;+xX$';

/** Coverage below this leaves a cell empty, which keeps the outline crisp. */
const EMPTY_BELOW = 0.08;

export interface Cell {
  col: number;
  row: number;
  glyph: string;
  /** 0 to 1; the canvas uses it for the glyph's opacity as well as its choice. */
  lum: number;
}

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface Particle {
  /** Where the particle starts, in grid units; null when it fades in from the burst. */
  from: Cell | null;
  /** Where it settles; null when it fades out into the burst. */
  to: Cell | null;
  /** The far point of the burst it passes through, in grid units. */
  burst: Point3;
  /** Fraction of the transition it waits before moving; the centre goes first. */
  delay: number;
  seed: number;
}

export interface ParticleFrame {
  x: number;
  y: number;
  z: number;
  alpha: number;
  glyph: string;
}

export function glyphFor(lum: number): string | null {
  if (lum < EMPTY_BELOW) return null;
  const index = Math.min(RAMP.length - 1, Math.floor(lum * RAMP.length));
  return RAMP.charAt(index);
}

/** Reads a row-major grid of luminance values into the cells that draw. */
export function cellsFromLuminance(lum: ArrayLike<number>, cols: number, rows: number): Cell[] {
  if (lum.length !== cols * rows) {
    throw new Error(
      `Luminance grid has ${String(lum.length)} values; a ${String(cols)} by ${String(rows)} grid needs ${String(cols * rows)}.`,
    );
  }
  const cells: Cell[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const value = lum[row * cols + col] ?? 0;
      const glyph = glyphFor(value);
      if (glyph !== null) cells.push({ col, row, glyph, lum: value });
    }
  }
  return cells;
}

/** Mulberry32: a small seeded generator, so a render is repeatable. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

export interface PairOptions {
  cols: number;
  rows: number;
  /** Largest stagger, as a fraction of the transition. */
  maxDelay: number;
  /** How far the burst throws a particle towards the viewer, in grid units. */
  depth: number;
  seed: number;
}

/**
 * Pairs every cell of the first picture with a cell of the second at
 * random, so the burst mixes the whole picture rather than sliding it.
 * The longer list sets the particle count; the surplus fades into or out
 * of the burst.
 */
export function pairParticles(from: Cell[], to: Cell[], options: PairOptions): Particle[] {
  const random = seededRandom(options.seed);
  const a = shuffle(from, random);
  const b = shuffle(to, random);
  const cx = (options.cols - 1) / 2;
  const cy = (options.rows - 1) / 2;
  const reach = Math.hypot(cx, cy) || 1;
  const count = Math.max(a.length, b.length);
  const particles: Particle[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = a[i] ?? null;
    const end = b[i] ?? null;
    const origin = start ?? end;
    const ox = origin === null ? cx : origin.col;
    const oy = origin === null ? cy : origin.row;
    const radius = Math.hypot(ox - cx, oy - cy) / reach;
    // Outward from the centre, with some spin so the burst is not a clean
    // radial fan; a particle at the dead centre picks a direction at random.
    const angle =
      radius === 0 ? random() * Math.PI * 2 : Math.atan2(oy - cy, ox - cx) + (random() - 0.5) * 0.9;
    const throwDistance = reach * (0.6 + random() * 0.9);
    particles.push({
      from: start,
      to: end,
      burst: {
        x: cx + Math.cos(angle) * throwDistance,
        y: cy + Math.sin(angle) * throwDistance,
        z: options.depth * (0.35 + random() * 0.65),
      },
      delay: radius * options.maxDelay,
      seed: Math.floor(random() * 2 ** 31),
    });
  }
  return particles;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** A particle's own progress: its delay spent, it still lands by the end. */
export function localProgress(particle: Particle, progress: number, maxDelay: number): number {
  return clamp01((progress - particle.delay) / (1 - maxDelay));
}

/** Frames a flying glyph holds before it scrambles to another. */
const SCRAMBLE_FRAMES = 3;

/**
 * Where a particle is at `progress` (0 to 1 over the transition). The path
 * is a cubic Bezier whose two control points sit on the burst point, so
 * the glyph leaves its cell, swings out through the burst and settles
 * without a stop in between. Depth peaks mid-flight; the glyph scrambles
 * while it moves and takes its target's glyph on landing.
 */
export function particleAt(
  particle: Particle,
  progress: number,
  maxDelay: number,
  frame: number,
): ParticleFrame {
  const v = localProgress(particle, progress, maxDelay);
  const t = easeInOutCubic(v);
  const { burst } = particle;
  const start = particle.from ?? { col: burst.x, row: burst.y };
  const end = particle.to ?? { col: burst.x, row: burst.y };
  const u = 1 - t;
  const pull = 3 * u * u * t + 3 * u * t * t;
  const x = u * u * u * start.col + pull * burst.x + t * t * t * end.col;
  const y = u * u * u * start.row + pull * burst.y + t * t * t * end.row;
  const z = burst.z * 4 * v * (1 - v);

  let alpha = 1;
  if (particle.from === null) alpha = t;
  if (particle.to === null) alpha = u;

  let glyph: string;
  if (v <= 0) glyph = particle.from?.glyph ?? RAMP.charAt(0);
  else if (v >= 1) glyph = particle.to?.glyph ?? RAMP.charAt(0);
  else {
    const tick = Math.floor(frame / SCRAMBLE_FRAMES);
    const pick = seededRandom(particle.seed + tick)();
    glyph = RAMP.charAt(Math.floor(pick * RAMP.length));
  }

  const lumFrom = particle.from?.lum ?? 1;
  const lumTo = particle.to?.lum ?? 1;
  const lum = lumFrom + (lumTo - lumFrom) * t;
  return { x, y, z, alpha: alpha * (0.35 + 0.65 * lum), glyph };
}

/** Perspective scale for a point `z` towards the viewer; `focal` in the same units. */
export function perspective(z: number, focal: number): number {
  return focal / Math.max(focal - z, focal * 0.05);
}

export interface TimelinePoint {
  /** The transition in play: from picture `index` to the next, wrapping round. */
  index: number;
  /** Progress through that transition, 0 while its first picture holds. */
  progress: number;
}

/**
 * Where an endless cycle through `count` pictures stands at `elapsed`
 * milliseconds. Each step holds its picture for `holdMs`, then morphs to
 * the next over `morphMs`; the last picture morphs back to the first.
 */
export function timelineAt(
  elapsed: number,
  holdMs: number,
  morphMs: number,
  count: number,
): TimelinePoint {
  const step = holdMs + morphMs;
  const into = ((elapsed % (step * count)) + step * count) % (step * count);
  const index = Math.floor(into / step);
  return { index, progress: clamp01((into - index * step - holdMs) / morphMs) };
}
