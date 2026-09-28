/**
 * The gate's three scenes, as pure state driven by the gate pulse.
 *
 * Each scene keeps its own state and is stepped once a frame with the
 * pulse; drawing lives in components/layout/gate-scene.tsx. The rule from
 * Mixdeck's visualizer applies: nothing moves on a clock, everything moves
 * on an event (a beat, a backbeat, a hat), and every event lights a shape
 * the eye can follow rather than a scatter.
 *
 * - Reactions: hearts, comment bubbles, shares and plays rise from the
 *   bottom on every beat, a bigger burst on the downbeat and a wall of them
 *   on a phrase start, the way reactions stream up a live.
 * - Levels: five platform columns that jump on the kick and fall like an
 *   equalizer, with a peak marker that walks across on the backbeat.
 * - Rings: concentric dashed follower rings that advance one dash per beat
 *   (neighbours turn opposite ways) and light as a wave from each kick
 *   passes through them.
 *
 * Shapes only. The gate is shown before the PIN, so it never draws a number.
 */

import { BEATS_PER_BAR, easeOut, type GatePulse } from "./pulse";

export type SceneName = "reactions" | "levels" | "rings";
export const SCENES: SceneName[] = ["reactions", "levels", "rings"];

/** Platform order and colours as drawn on the navy gate. TikTok and Threads
 *  are near-black in the dashboard palette, so they get their light accents. */
export const PLATFORM_COLORS = ["#ff4d8d", "#5ee7e0", "#ff4747", "#f4f6fb", "#3f9dff"] as const;
export const PLATFORM_NAMES = ["Instagram", "TikTok", "YouTube", "Threads", "LinkedIn"] as const;
export const N_PLATFORMS = PLATFORM_COLORS.length;

// Small deterministic PRNG so a test can replay a scene.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Reactions --------------------------------------------------------------

export type ReactionKind = 0 | 1 | 2 | 3; // heart, comment, share, play
export const MAX_REACTIONS = 180;

export interface Reaction {
  kind: ReactionKind;
  /** Normalised 0..1 across the width. */
  x: number;
  /** Normalised 0..1 down the height; starts just below 1. */
  y: number;
  /** Rise speed in heights per second. */
  vy: number;
  /** Sway amplitude in widths and its phase. */
  sway: number;
  swayPhase: number;
  /** Size relative to the shorter side. */
  size: number;
  color: number;
  age: number;
  life: number;
  spin: number;
}

export interface ReactionsState {
  items: Reaction[];
  rand: () => number;
}

export function createReactions(seed = 7): ReactionsState {
  return { items: [], rand: mulberry32(seed) };
}

function spawnReaction(s: ReactionsState, xCentre: number, spread: number, big: boolean): void {
  if (s.items.length >= MAX_REACTIONS) return;
  const r = s.rand;
  s.items.push({
    kind: Math.floor(r() * 4) as ReactionKind,
    x: xCentre + (r() - 0.5) * spread,
    y: 1.04 + r() * 0.06,
    vy: 0.16 + r() * 0.14 + (big ? 0.08 : 0),
    sway: 0.006 + r() * 0.014,
    swayPhase: r() * Math.PI * 2,
    size: (big ? 0.042 : 0.026) + r() * 0.018,
    color: Math.floor(r() * N_PLATFORMS),
    age: 0,
    life: 3.2 + r() * 1.6,
    spin: (r() - 0.5) * 0.9,
  });
}

export function stepReactions(s: ReactionsState, p: GatePulse, dt: number): void {
  if (p.phraseStart) {
    for (let i = 0; i < 16; i++) spawnReaction(s, 0.5, 0.9, i % 3 === 0);
  } else if (p.downbeat) {
    for (let i = 0; i < 7; i++) spawnReaction(s, 0.5, 0.7, i % 4 === 0);
  } else if (p.beat) {
    // Off-downbeats come from a side that alternates, so the stream leans.
    const side = p.barBeat === 2 ? 0.5 : p.barBeat === 1 ? 0.3 : 0.7;
    for (let i = 0; i < 3; i++) spawnReaction(s, side, 0.35, false);
  }
  if (p.hit[2]) spawnReaction(s, 0.2 + s.rand() * 0.6, 0.1, false);

  const keep: Reaction[] = [];
  for (const it of s.items) {
    it.age += dt;
    if (it.age >= it.life) continue;
    it.y -= it.vy * dt * (1 + 0.6 * p.env[0]);
    it.x += Math.sin(it.age * 2.2 + it.swayPhase) * it.sway * dt * 6;
    if (it.y > -0.1) keep.push(it);
  }
  s.items = keep;
}

/** 0..1 opacity over a reaction's life: quick in, long hold, soft out. */
export function reactionAlpha(r: Reaction): number {
  const t = r.age / r.life;
  if (t < 0.08) return t / 0.08;
  if (t > 0.7) return Math.max(0, 1 - (t - 0.7) / 0.3);
  return 1;
}

// --- Levels -----------------------------------------------------------------

export const LEVEL_SEGMENTS = 22;

export interface LevelsState {
  /** 0..1 per platform column. */
  level: Float32Array;
  /** Held peak per column, falling slowly. */
  peak: Float32Array;
  /** Which column the backbeat marker sits on. */
  marker: number;
  /** Time since the marker moved, for its flash. */
  markerAge: number;
  rand: () => number;
}

export function createLevels(seed = 11): LevelsState {
  return {
    level: new Float32Array(N_PLATFORMS),
    peak: new Float32Array(N_PLATFORMS),
    marker: 0,
    markerAge: 10,
    rand: mulberry32(seed),
  };
}

export function stepLevels(s: LevelsState, p: GatePulse, dt: number): void {
  const fall = dt / (1.7 * p.beatSeconds);
  const peakFall = dt / (3 * p.beatSeconds);
  for (let i = 0; i < N_PLATFORMS; i++) {
    s.level[i] = Math.max(0, s.level[i] - fall);
    s.peak[i] = Math.max(s.level[i], s.peak[i] - peakFall);
  }
  if (p.beat) {
    // The downbeat lifts every column; other beats lift a few, so the
    // shape of the bar reads across the row.
    for (let i = 0; i < N_PLATFORMS; i++) {
      const lift = p.downbeat ? 0.6 + s.rand() * 0.4 : 0.25 + s.rand() * 0.5;
      if (p.phraseStart) s.level[i] = 1;
      else s.level[i] = Math.max(s.level[i], lift);
      s.peak[i] = Math.max(s.peak[i], s.level[i]);
    }
  }
  if (p.hit[1]) {
    s.marker = (s.marker + 1) % N_PLATFORMS;
    s.markerAge = 0;
  }
  if (p.hit[2]) {
    const i = Math.floor(s.rand() * N_PLATFORMS);
    s.level[i] = Math.min(1, s.level[i] + 0.18);
  }
  s.markerAge += dt;
}

// --- Rings ------------------------------------------------------------------

export const N_RINGS = 6;
export const RING_DASHES = 18;
export const MAX_WAVES = 8;
/** Beats for a wave to travel from the centre to the outer ring. */
export const WAVE_BEATS = 1;

export interface Wave {
  /** 0 at the centre, 1 at the outer ring. */
  r: number;
  /** 1 for a downbeat, 0.6 for a beat; a phrase start is white. */
  strength: number;
  white: boolean;
}

export interface RingsState {
  waves: Wave[];
  /** Beat count when each ring last advanced, so it eases out from there. */
  dashStep: number;
}

export function createRings(): RingsState {
  return { waves: [], dashStep: 0 };
}

export function stepRings(s: RingsState, p: GatePulse, dt: number): void {
  if (p.beat) {
    s.dashStep = p.beatCount;
    if (s.waves.length >= MAX_WAVES) s.waves.shift();
    s.waves.push({ r: 0, strength: p.downbeat ? 1 : 0.6, white: p.phraseStart });
  }
  const speed = dt / (WAVE_BEATS * p.beatSeconds);
  s.waves = s.waves.filter((w) => (w.r += speed) < 1.25);
}

/** Rotation of ring `i` in dashes: one dash per beat, eased, alternating direction. */
export function ringOffset(s: RingsState, p: GatePulse, i: number): number {
  const dir = i % 2 === 0 ? 1 : -1;
  const eased = s.dashStep + easeOut(p.phase);
  return dir * eased * (1 + 0.15 * i);
}

/** How lit ring `i` (radius 0..1) is by the waves passing it, 0..1. */
export function ringLight(s: RingsState, radius: number): { amount: number; white: boolean } {
  let amount = 0;
  let white = false;
  for (const w of s.waves) {
    const d = Math.abs(w.r - radius);
    if (d < 0.12) {
      const a = (1 - d / 0.12) * w.strength;
      if (a > amount) {
        amount = a;
        white = w.white;
      }
    }
  }
  return { amount, white };
}

// --- Sequencing -------------------------------------------------------------

export interface GateScenes {
  scene: SceneName;
  /** Bars spent in the current scene; a cut waits for six, so scenes last two phrases. */
  barsInScene: number;
  reactions: ReactionsState;
  levels: LevelsState;
  rings: RingsState;
}

export function createScenes(first: SceneName = "reactions"): GateScenes {
  return {
    scene: first,
    barsInScene: 0,
    reactions: createReactions(),
    levels: createLevels(),
    rings: createRings(),
  };
}

export const MIN_BARS_PER_SCENE = 6;

export function nextScene(current: SceneName): SceneName {
  return SCENES[(SCENES.indexOf(current) + 1) % SCENES.length];
}

/** Step every scene (so a cut lands on a scene already in motion) and cut on a phrase. */
export function stepScenes(g: GateScenes, p: GatePulse, dt: number): void {
  if (p.downbeat) g.barsInScene += 1;
  if (p.phraseStart && g.barsInScene >= MIN_BARS_PER_SCENE) {
    g.scene = nextScene(g.scene);
    g.barsInScene = 0;
  }
  stepReactions(g.reactions, p, dt);
  stepLevels(g.levels, p, dt);
  stepRings(g.rings, p, dt);
}

/** Beats in a bar, re-exported for drawing code that sizes by the bar. */
export const BAR = BEATS_PER_BAR;
