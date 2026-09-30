'use client';

import { useEffect, useRef } from 'react';
import {
  cellsFromLuminance,
  clamp01,
  pairParticles,
  particleAt,
  perspective,
  timelineAt,
  type Particle,
} from '@/lib/ascii-morph';

/**
 * The sign-in page's loop: a robot drawn in ASCII bursts towards the
 * viewer and settles as the Valliance star, which bursts back into the
 * robot, and round again. Each direction has its own pairing, so the
 * return is a fresh burst rather than a rewind. The pictures are drawn at a
 * fixed world size, sampled into a glyph grid, and flown by the pure
 * functions in `lib/ascii-morph`. The canvas covers the viewport so the
 * burst can sweep behind the card; a placeholder of the picture's size holds
 * its place in the layout and tells the canvas where to draw.
 */

const COLS = 72;
const ROWS = 36;
/** One cell of the world, in CSS pixels at full width; a monospace glyph is about 0.6 as wide as tall. */
const CELL_W = 5;
const CELL_H = 8;
const WORLD_W = COLS * CELL_W;
const WORLD_H = ROWS * CELL_H;

/** How long each picture holds between morphs. */
const HOLD_MS = 1600;
const MORPH_MS = 2400;
const MAX_DELAY = 0.3;
/** Burst depth and focal length, in grid cells. */
const DEPTH = 34;
const FOCAL = 40;
/** Motion blur: earlier moments of the flight, drawn fainter behind the glyph. */
const GHOSTS = [
  { lag: 0.012, alpha: 0.35 },
  { lag: 0.024, alpha: 0.15 },
];

type Painter = (ctx: CanvasRenderingContext2D) => void;

/** Light from the top left, so the density ramp reads as form. */
function shade(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, '#fff');
  g.addColorStop(1, '#4a4a4a');
  return g;
}

function cutOut(ctx: CanvasRenderingContext2D, draw: () => void) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  draw();
  ctx.fill();
  ctx.restore();
}

/** The robot is drawn on a 336 by 220 sketch, scaled to the world's height and centred. */
const ROBOT_W = 336;
const ROBOT_H = 220;

const paintRobot: Painter = (ctx) => {
  const scale = WORLD_H / ROBOT_H;
  ctx.translate((WORLD_W - ROBOT_W * scale) / 2, 0);
  ctx.scale(scale, scale);
  ctx.fillStyle = shade(ctx, 90, 10, 250, 210);
  ctx.beginPath();
  ctx.arc(168, 12, 7, 0, Math.PI * 2);
  ctx.rect(165, 12, 6, 20);
  ctx.roundRect(116, 30, 104, 66, 16);
  ctx.rect(106, 50, 12, 26);
  ctx.rect(218, 50, 12, 26);
  ctx.rect(157, 96, 22, 12);
  ctx.roundRect(104, 106, 128, 100, 14);
  ctx.roundRect(82, 112, 18, 76, 8);
  ctx.roundRect(236, 112, 18, 76, 8);
  ctx.fill();

  cutOut(ctx, () => {
    ctx.arc(143, 60, 12, 0, Math.PI * 2);
    ctx.moveTo(205, 60);
    ctx.arc(193, 60, 12, 0, Math.PI * 2);
    for (let x = 138; x < 198; x += 13) ctx.rect(x, 78, 8, 7);
    ctx.roundRect(134, 122, 68, 42, 6);
  });

  ctx.fillStyle = '#b5b5b5';
  ctx.beginPath();
  ctx.arc(146, 58, 5, 0, Math.PI * 2);
  ctx.moveTo(201, 58);
  ctx.arc(196, 58, 5, 0, Math.PI * 2);
  for (let x = 150; x <= 186; x += 18) {
    ctx.moveTo(x + 5, 143);
    ctx.arc(x, 143, 5, 0, Math.PI * 2);
  }
  ctx.fill();
};

/** The path from `StarMark`, on its 24px grid, scaled to fill the picture's height. */
const STAR_PATH =
  'M12 1.5C12 7.5 16.5 12 22.5 12 16.5 12 12 16.5 12 22.5 12 16.5 7.5 12 1.5 12 7.5 12 12 7.5 12 1.5Z';
const STAR_SCALE = (WORLD_H * 0.94) / 24;

const paintStar: Painter = (ctx) => {
  const cx = WORLD_W / 2;
  const cy = WORLD_H / 2;
  const g = ctx.createRadialGradient(cx - 18, cy - 18, 2, cx, cy, WORLD_H * 0.5);
  g.addColorStop(0, '#fff');
  g.addColorStop(0.35, '#d0d0d0');
  g.addColorStop(1, '#4a4a4a');
  ctx.fillStyle = g;
  // The path is scaled, not the context, so the gradient stays in world units.
  const star = new Path2D();
  star.addPath(
    new Path2D(STAR_PATH),
    new DOMMatrix()
      .translate(cx - 12 * STAR_SCALE, cy - 12 * STAR_SCALE)
      .scale(STAR_SCALE, STAR_SCALE),
  );
  ctx.fill(star);
};

/** Lifts partly covered edge cells so thin strokes survive the sampling. */
const EDGE_GAMMA = 0.7;

/** Draws a picture off screen and averages each cell's brightness. */
function rasterise(paint: Painter) {
  const canvas = document.createElement('canvas');
  canvas.width = WORLD_W;
  canvas.height = WORLD_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) return [];
  paint(ctx);
  const { data } = ctx.getImageData(0, 0, WORLD_W, WORLD_H);
  const lum = new Float32Array(COLS * ROWS);
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      let sum = 0;
      for (let y = row * CELL_H; y < (row + 1) * CELL_H; y += 1) {
        for (let x = col * CELL_W; x < (col + 1) * CELL_W; x += 1) {
          const i = (y * WORLD_W + x) * 4;
          sum += ((data[i] ?? 0) / 255) * ((data[i + 3] ?? 0) / 255);
        }
      }
      lum[row * COLS + col] = (sum / (CELL_W * CELL_H)) ** EDGE_GAMMA;
    }
  }
  return cellsFromLuminance(lum, COLS, ROWS);
}

interface Scene {
  ctx: CanvasRenderingContext2D;
  anchor: DOMRect;
  colour: string;
  particles: Particle[];
  dpr: number;
}

function drawGlyph(
  scene: Scene,
  particle: Particle,
  progress: number,
  frame: number,
  fade: number,
) {
  const p = particleAt(particle, progress, MAX_DELAY, frame);
  if (p.alpha <= 0) return;
  const { ctx, anchor, dpr } = scene;
  const s = anchor.width / WORLD_W;
  const cellW = CELL_W * s;
  const cellH = CELL_H * s;
  const k = perspective(p.z, FOCAL);
  const cx = anchor.left + anchor.width / 2;
  const cy = anchor.top + anchor.height / 2;
  const x = cx + ((p.x + 0.5) * cellW - anchor.width / 2) * k;
  const y = cy + ((p.y + 0.5) * cellH - anchor.height / 2) * k;
  ctx.globalAlpha = p.alpha * fade;
  ctx.setTransform(k * s * dpr, 0, 0, k * s * dpr, x * dpr, y * dpr);
  ctx.fillText(p.glyph, 0, 0);
}

function drawFrame(scene: Scene, progress: number, frame: number) {
  const { ctx } = scene;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = scene.colour;
  ctx.font = `${String(CELL_H)}px ui-monospace, Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const moving = progress > 0 && progress < 1;
  for (const particle of scene.particles) {
    if (moving) {
      for (const ghost of GHOSTS) {
        drawGlyph(scene, particle, clamp01(progress - ghost.lag), frame, ghost.alpha);
      }
    }
    drawGlyph(scene, particle, progress, frame, 1);
  }
}

export function AsciiMorph({ className }: { className?: string }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const anchorEl = anchorRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (anchorEl === null || canvas === null || ctx === undefined || ctx === null) return;

    const robot = rasterise(paintRobot);
    const star = rasterise(paintStar);
    const pair = (from: typeof robot, to: typeof robot, seed: number) =>
      pairParticles(from, to, { cols: COLS, rows: ROWS, maxDelay: MAX_DELAY, depth: DEPTH, seed });
    // Transition i runs from picture i to the next: robot to star, star to robot.
    const transitions = [pair(robot, star, 20260925), pair(star, robot, 20260926)];
    const colour = getComputedStyle(canvas).color;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let dpr = 1;
    // Reduced motion shows the star, the end of the first transition, and never moves.
    let index = 0;
    let progress = still ? 1 : 0;
    let frame = 0;
    let raf = 0;

    const render = () => {
      drawFrame(
        {
          ctx,
          anchor: anchorEl.getBoundingClientRect(),
          colour,
          particles: transitions[index] ?? [],
          dpr,
        },
        progress,
        frame,
      );
    };
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      render();
    };
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', render, { passive: true });

    if (!still) {
      const started = performance.now();
      const tick = (now: number) => {
        const at = timelineAt(now - started, HOLD_MS, MORPH_MS, transitions.length);
        // A held picture is already on the canvas; only a morph needs a new frame.
        const holding = at.progress === 0 && progress === 0 && at.index === index;
        index = at.index;
        progress = at.progress;
        frame += 1;
        if (!holding) render();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', render);
    };
  }, []);

  return (
    <div
      ref={anchorRef}
      aria-hidden
      className={className}
      style={{ aspectRatio: `${String(WORLD_W)} / ${String(WORLD_H)}` }}
    >
      <canvas
        ref={canvasRef}
        className="pointer-events-none fixed inset-0 -z-10 size-full text-brand"
      />
    </div>
  );
}
