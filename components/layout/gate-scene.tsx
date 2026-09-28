"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { createGatePulse, stepGatePulse, type GatePulse } from "@/lib/gate/pulse";
import {
  LEVEL_SEGMENTS,
  N_PLATFORMS,
  N_RINGS,
  PLATFORM_COLORS,
  RING_DASHES,
  createScenes,
  nextScene,
  reactionAlpha,
  ringLight,
  ringOffset,
  stepScenes,
  type GateScenes,
  type SceneName,
} from "@/lib/gate/scenes";

/** Navy of the hero band every tab opens on; the gate is the same surface. */
export const GATE_BG = "#0a1628";
const BRAND = "#1e6fd9";

/** Live content-box size of an element, so the canvas fills whatever the layout leaves. */
function useSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
}

interface Frame {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  p: GatePulse;
}

function drawBackground({ ctx, w, h, p }: Frame): void {
  ctx.fillStyle = GATE_BG;
  ctx.fillRect(0, 0, w, h);
  // A brand-blue glow low in the frame that breathes with the kick.
  const r = Math.max(w, h) * 0.7;
  const g = ctx.createRadialGradient(w / 2, h * 0.8, 0, w / 2, h * 0.8, r);
  g.addColorStop(0, rgba(BRAND, 0.16 + 0.16 * p.env[0]));
  g.addColorStop(1, rgba(BRAND, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** A soft dark centre so the type sits on the scene rather than in it. */
function drawVignette({ ctx, w, h }: Frame): void {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.min(w, h) * 0.6);
  g.addColorStop(0, "rgba(10,22,40,0.78)");
  g.addColorStop(0.55, "rgba(10,22,40,0.45)");
  g.addColorStop(1, "rgba(10,22,40,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// Unit-size glyphs, drawn centred at the origin.
function heartPath(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.beginPath();
  ctx.moveTo(0, s * 0.35);
  ctx.bezierCurveTo(-s * 0.9, -s * 0.25, -s * 0.45, -s * 0.75, 0, -s * 0.3);
  ctx.bezierCurveTo(s * 0.45, -s * 0.75, s * 0.9, -s * 0.25, 0, s * 0.35);
  ctx.closePath();
}
function bubblePath(ctx: CanvasRenderingContext2D, s: number): void {
  const w = s * 1.15;
  const h = s * 0.8;
  const r = s * 0.22;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2 - s * 0.08, w, h, r);
  ctx.moveTo(-w * 0.2, h / 2 - s * 0.08);
  ctx.lineTo(-w * 0.32, h / 2 + s * 0.2);
  ctx.lineTo(w * 0.02, h / 2 - s * 0.08);
  ctx.closePath();
}
function planePath(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.beginPath();
  ctx.moveTo(s * 0.6, -s * 0.5);
  ctx.lineTo(-s * 0.6, 0);
  ctx.lineTo(-s * 0.1, s * 0.12);
  ctx.lineTo(s * 0.6, -s * 0.5);
  ctx.moveTo(-s * 0.1, s * 0.12);
  ctx.lineTo(-s * 0.05, s * 0.5);
  ctx.lineTo(s * 0.15, s * 0.22);
  ctx.closePath();
}
function playPath(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.beginPath();
  ctx.moveTo(-s * 0.3, -s * 0.42);
  ctx.lineTo(s * 0.45, 0);
  ctx.lineTo(-s * 0.3, s * 0.42);
  ctx.closePath();
}

function drawReactions(f: Frame, g: GateScenes): void {
  const { ctx, w, h } = f;
  const unit = Math.min(w, h);
  for (const it of g.reactions.items) {
    const a = reactionAlpha(it) * 0.92;
    if (a <= 0) continue;
    const s = it.size * unit;
    ctx.save();
    ctx.translate(it.x * w, it.y * h);
    ctx.rotate(Math.sin(it.age * 1.6) * it.spin * 0.5);
    const color = PLATFORM_COLORS[it.color];
    ctx.fillStyle = rgba(color, a);
    ctx.strokeStyle = rgba(color, a);
    ctx.lineWidth = Math.max(1.5, s * 0.14);
    ctx.lineJoin = "round";
    switch (it.kind) {
      case 0:
        heartPath(ctx, s);
        ctx.fill();
        break;
      case 1:
        bubblePath(ctx, s);
        ctx.fill();
        break;
      case 2:
        planePath(ctx, s);
        ctx.fill();
        break;
      default:
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.62, 0, Math.PI * 2);
        ctx.stroke();
        playPath(ctx, s * 0.7);
        ctx.fill();
    }
    ctx.restore();
  }
}

function drawLevels(f: Frame, g: GateScenes): void {
  const { ctx, w, h, p } = f;
  const s = g.levels;
  const total = Math.min(w * 0.9, 1100);
  const slot = total / N_PLATFORMS;
  const colW = slot * 0.6;
  const height = Math.min(h * 0.26, 230);
  const base = h - 96;
  const gap = 3;
  const segH = (height - gap * (LEVEL_SEGMENTS - 1)) / LEVEL_SEGMENTS;
  const left = (w - total) / 2 + (slot - colW) / 2;
  for (let i = 0; i < N_PLATFORMS; i++) {
    const x = left + i * slot;
    const color = PLATFORM_COLORS[i];
    const lit = Math.round(s.level[i] * LEVEL_SEGMENTS);
    // Only lit segments are drawn, so an idle column is just its baseline
    // and nothing sits behind the PIN cells between beats.
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(x, base + 2, colW, 1);
    for (let j = 0; j < lit; j++) {
      const y = base - (j + 1) * segH - j * gap;
      const top = j === lit - 1;
      ctx.fillStyle = rgba(top ? "#ffffff" : color, top ? 0.95 : 0.35 + 0.6 * (j / LEVEL_SEGMENTS));
      ctx.beginPath();
      ctx.roundRect(x, y, colW, segH, 2);
      ctx.fill();
    }
    // Held peak, a thin bar that falls slowly.
    const py = base - s.peak[i] * height;
    ctx.fillStyle = rgba(color, 0.9);
    ctx.fillRect(x, py - 1.5, colW, 3);
    // Platform dot under the column; the backbeat marker flashes one of them.
    const flash = i === s.marker ? Math.max(0, 1 - s.markerAge / (p.beatSeconds * 0.8)) : 0;
    ctx.beginPath();
    ctx.arc(x + colW / 2, base + 22, 4 + 5 * flash, 0, Math.PI * 2);
    ctx.fillStyle = rgba(color, 0.5 + 0.5 * flash);
    ctx.fill();
    if (flash > 0) {
      ctx.beginPath();
      ctx.arc(x + colW / 2, base + 22, 10 + 16 * (1 - flash), 0, Math.PI * 2);
      ctx.strokeStyle = rgba(color, 0.6 * flash);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

function drawRings(f: Frame, g: GateScenes): void {
  const { ctx, w, h, p } = f;
  const s = g.rings;
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.44;
  ctx.lineCap = "round";
  for (let i = 0; i < N_RINGS; i++) {
    const t = 0.16 + 0.84 * (i / (N_RINGS - 1));
    const radius = R * t;
    const color = PLATFORM_COLORS[i % N_PLATFORMS];
    const light = ringLight(s, t);
    const dashes = RING_DASHES + i * 6;
    const circ = 2 * Math.PI * radius;
    const dash = circ / dashes;
    ctx.setLineDash([dash * 0.55, dash * 0.45]);
    ctx.lineDashOffset = -ringOffset(s, p, i) * dash;
    ctx.lineWidth = 2 + 7 * light.amount;
    ctx.strokeStyle = light.white
      ? rgba("#ffffff", 0.45 + 0.55 * light.amount)
      : rgba(color, 0.3 + 0.7 * light.amount);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // Centre pulse on the kick.
  ctx.beginPath();
  ctx.arc(cx, cy, R * (0.05 + 0.05 * p.env[0]), 0, Math.PI * 2);
  ctx.fillStyle = rgba("#ffffff", 0.35 + 0.5 * p.env[0]);
  ctx.fill();
}

function drawScene(f: Frame, g: GateScenes): void {
  drawBackground(f);
  if (g.scene === "reactions") drawReactions(f, g);
  else if (g.scene === "levels") drawLevels(f, g);
  else drawRings(f, g);
  drawVignette(f);
}

interface GateSceneProps {
  children: React.ReactNode;
  /** Called on each scene cut, for a caption. */
  onScene?: (scene: SceneName) => void;
}

/**
 * Full-screen canvas behind the gate's content. Runs the pulse and the
 * scenes on requestAnimationFrame, cuts between scenes on phrase starts,
 * and exposes the kick envelope as `--kick` on the wrapper so the PIN
 * cells can glow with it in CSS. With reduced motion preferred it draws a
 * single settled frame and never animates.
 */
export function GateScene({ children, onScene }: GateSceneProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const { w, h } = useSize(wrap);
  // Kept in a ref so the loop never restarts when the parent re-renders.
  const onSceneRef = useRef(onScene);
  useEffect(() => {
    onSceneRef.current = onScene;
  }, [onScene]);

  useEffect(() => {
    const c = canvas.current;
    const el = wrap.current;
    if (!c || !el || w < 10 || h < 10) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const pulse = createGatePulse();
    const scenes = createScenes();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = performance.now();
    let lastScene: SceneName | null = null;

    const frame = (dt: number) => {
      stepGatePulse(pulse, dt);
      stepScenes(scenes, pulse, dt);
      if (scenes.scene !== lastScene) {
        lastScene = scenes.scene;
        el.dataset.scene = scenes.scene;
        onSceneRef.current?.(scenes.scene);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawScene({ ctx, w, h, p: pulse }, scenes);
      el.style.setProperty("--kick", pulse.env[0].toFixed(3));
    };

    if (still) {
      // Settle the Levels scene into a frame with something lit, then stop.
      scenes.scene = "levels";
      for (let i = 0; i < 40; i++) frame(1 / 30);
      frame(0);
      el.style.setProperty("--kick", "0");
      return;
    }

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      // Clamp so a background tab returning does not launch a wall of shapes.
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      frame(dt);
    };
    raf = requestAnimationFrame(loop);

    // Development only: let a check force the next cut without waiting a phrase.
    if (process.env.NODE_ENV === "development") {
      (window as unknown as { __bwpGate?: unknown }).__bwpGate = {
        cut: () => {
          scenes.scene = nextScene(scenes.scene);
          scenes.barsInScene = 0;
        },
        scene: () => scenes.scene,
        state: () => ({ pulse, scenes }),
      };
    }
    return () => cancelAnimationFrame(raf);
  }, [w, h]);

  return (
    <div
      ref={wrap}
      className="fixed inset-0 z-50 overflow-hidden text-white"
      style={{ backgroundColor: GATE_BG, ["--kick" as string]: 0 }}
      data-testid="gate"
    >
      <canvas ref={canvas} style={{ width: w, height: h }} className="block" aria-hidden />
      {children}
    </div>
  );
}
