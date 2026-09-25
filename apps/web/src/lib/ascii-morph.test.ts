import { describe, expect, it } from 'vitest';
import {
  RAMP,
  cellsFromLuminance,
  glyphFor,
  localProgress,
  pairParticles,
  particleAt,
  perspective,
  seededRandom,
  type Cell,
} from './ascii-morph';

const OPTIONS = { cols: 10, rows: 6, maxDelay: 0.3, depth: 20, seed: 7 };

function cell(col: number, row: number, glyph = 'X', lum = 0.8): Cell {
  return { col, row, glyph, lum };
}

describe('glyphFor', () => {
  it('leaves near-black cells empty', () => {
    expect(glyphFor(0)).toBeNull();
    expect(glyphFor(0.05)).toBeNull();
  });

  it('climbs the ramp with brightness and tops out at the densest glyph', () => {
    expect(glyphFor(0.1)).toBe(RAMP.charAt(0));
    expect(glyphFor(1)).toBe(RAMP.charAt(RAMP.length - 1));
    expect(RAMP.indexOf(glyphFor(0.4) ?? '')).toBeLessThan(RAMP.indexOf(glyphFor(0.8) ?? ''));
  });
});

describe('cellsFromLuminance', () => {
  it('keeps only the cells bright enough to draw, with their grid position', () => {
    const cells = cellsFromLuminance([0, 1, 0, 0, 0, 0.5], 3, 2);
    expect(cells.map(({ col, row }) => [col, row])).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it('refuses a grid whose size does not match its dimensions', () => {
    expect(() => cellsFromLuminance([1, 1, 1], 2, 2)).toThrow(/2 by 2 grid needs 4/);
  });
});

describe('seededRandom', () => {
  it('repeats the same sequence for the same seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('pairParticles', () => {
  it('makes one particle per cell of the larger picture and uses every cell of both', () => {
    const from = [cell(0, 0), cell(1, 0), cell(2, 0)];
    const to = [cell(5, 5), cell(6, 5)];
    const particles = pairParticles(from, to, OPTIONS);
    expect(particles).toHaveLength(3);
    expect(new Set(particles.map((p) => p.from))).toEqual(new Set(from));
    expect(new Set(particles.flatMap((p) => (p.to === null ? [] : [p.to])))).toEqual(new Set(to));
    expect(particles.filter((p) => p.to === null)).toHaveLength(1);
  });

  it('sends the centre of the picture first', () => {
    const centre = cell(4.5, 2.5);
    const corner = cell(0, 0);
    const particles = pairParticles([centre, corner], [cell(1, 1), cell(2, 2)], OPTIONS);
    const delayOf = (c: Cell) => particles.find((p) => p.from === c)?.delay ?? Number.NaN;
    expect(delayOf(centre)).toBe(0);
    expect(delayOf(corner)).toBeCloseTo(OPTIONS.maxDelay);
  });
});

describe('particleAt', () => {
  const [particle] = pairParticles([cell(1, 2, ';', 0.4)], [cell(8, 4, '$', 1)], OPTIONS);
  if (particle === undefined) throw new Error('pairParticles returned no particle');

  it('starts on its source cell with the source glyph', () => {
    const frame = particleAt(particle, 0, OPTIONS.maxDelay, 0);
    expect(frame).toMatchObject({ x: 1, y: 2, z: 0, glyph: ';' });
  });

  it('lands on its target cell with the target glyph', () => {
    const frame = particleAt(particle, 1, OPTIONS.maxDelay, 99);
    expect(frame.x).toBeCloseTo(8);
    expect(frame.y).toBeCloseTo(4);
    expect(frame.z).toBe(0);
    expect(frame.glyph).toBe('$');
  });

  it('flies towards the viewer mid-transition', () => {
    const mid = (1 + particle.delay / (1 - OPTIONS.maxDelay)) / 2;
    const frame = particleAt(particle, mid, OPTIONS.maxDelay, 5);
    expect(frame.z).toBeGreaterThan(0);
    expect(RAMP).toContain(frame.glyph);
  });

  it('fades a surplus particle out into the burst', () => {
    const [surplus] = pairParticles([cell(3, 3)], [], OPTIONS);
    if (surplus === undefined) throw new Error('pairParticles returned no particle');
    expect(particleAt(surplus, 1, OPTIONS.maxDelay, 0).alpha).toBe(0);
  });
});

describe('localProgress', () => {
  it('holds a delayed particle still and still lands it by the end', () => {
    const [p] = pairParticles([cell(0, 0)], [cell(1, 1)], OPTIONS);
    if (p === undefined) throw new Error('pairParticles returned no particle');
    expect(localProgress(p, p.delay / 2, OPTIONS.maxDelay)).toBe(0);
    expect(localProgress(p, 1, OPTIONS.maxDelay)).toBe(1);
  });
});

describe('perspective', () => {
  it('is 1 on the picture plane and grows as a point nears the viewer', () => {
    expect(perspective(0, 100)).toBe(1);
    expect(perspective(50, 100)).toBe(2);
  });

  it('stays finite at and beyond the focal plane', () => {
    expect(Number.isFinite(perspective(100, 100))).toBe(true);
    expect(perspective(150, 100)).toBe(20);
  });
});
