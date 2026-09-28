/**
 * The gate's clock: a synthetic "posting rhythm" with no audio behind it.
 *
 * Borrowed in spirit from Mixdeck's demo pulse. The gate page cannot play
 * sound and has nothing to analyse, so the scenes run on a fixed tempo:
 * a beat grid, a backbeat on 2 and 4, hats on the off-eighths, four beats
 * to a bar and four bars to a phrase. Scenes read the events and the
 * envelopes and never keep their own timers, so everything on the page
 * moves in the same time.
 *
 * - `beat`, `downbeat`, `phraseStart`: crossings that happened this frame.
 * - `hit[0..2]`: kick (every beat), snare (beats 2 and 4), hat (off-eighths).
 * - `env[0..2]`: 1 on the hit, decaying to 0 over half a beat. Motion follows
 *   these, so nothing lights on a clock; it lights on an event.
 * - `phase`: 0 at the last beat rising to 1 at the next, for eased travel.
 *
 * Pure state, no DOM, so it can be stepped in a test.
 */

export const DEFAULT_BPM = 112;
export const BEATS_PER_BAR = 4;
export const BARS_PER_PHRASE = 4;
/** Beats for an envelope to fall from 1 to 0. */
export const ENV_RELEASE_BEATS = 0.5;

export interface GatePulse {
  bpm: number;
  beatSeconds: number;
  /** Seconds since the pulse started. */
  time: number;
  /** Whole beats elapsed. */
  beatCount: number;
  /** 0..3 within the bar. */
  barBeat: number;
  /** 0..1 through the current beat. */
  phase: number;
  beat: boolean;
  downbeat: boolean;
  phraseStart: boolean;
  /** Kick, snare, hat landed this frame. */
  hit: [boolean, boolean, boolean];
  /** Kick, snare, hat envelopes, 1 on the hit and decaying. */
  env: [number, number, number];
  /** Whether the off-eighth hat has fired inside the current beat. */
  hatFired: boolean;
}

export function createGatePulse(bpm = DEFAULT_BPM): GatePulse {
  return {
    bpm,
    beatSeconds: 60 / bpm,
    time: 0,
    beatCount: 0,
    barBeat: 0,
    phase: 0,
    beat: false,
    downbeat: false,
    phraseStart: false,
    hit: [false, false, false],
    env: [0, 0, 0],
    hatFired: false,
  };
}

/** Advance the clock by `dt` seconds. Events are true only on the frame they land. */
export function stepGatePulse(p: GatePulse, dt: number): void {
  const before = Math.floor(p.time / p.beatSeconds);
  p.time += dt;
  const after = Math.floor(p.time / p.beatSeconds);
  p.phase = (p.time - after * p.beatSeconds) / p.beatSeconds;

  const release = ENV_RELEASE_BEATS * p.beatSeconds;
  for (let i = 0; i < 3; i++) p.env[i] = Math.max(0, p.env[i] - dt / release);
  p.hit = [false, false, false];
  p.beat = false;
  p.downbeat = false;
  p.phraseStart = false;

  if (after > before) {
    // A frame can only carry one crossing; a long stall skips the rest.
    p.beatCount = after;
    p.barBeat = after % BEATS_PER_BAR;
    p.beat = true;
    p.downbeat = p.barBeat === 0;
    p.phraseStart = p.downbeat && (after / BEATS_PER_BAR) % BARS_PER_PHRASE === 0;
    p.hit[0] = true;
    p.env[0] = 1;
    if (p.barBeat === 1 || p.barBeat === 3) {
      p.hit[1] = true;
      p.env[1] = 1;
    }
    p.hatFired = false;
  }

  if (!p.hatFired && p.phase >= 0.5) {
    p.hatFired = true;
    p.hit[2] = true;
    p.env[2] = 1;
  }
}

/** Ease-out for travel that should land on the next beat. */
export function easeOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) * (1 - x) * (1 - x);
}
