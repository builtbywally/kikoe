"use client";

import Engine from "@/lib/vendor/thinking-orbs";
import { useEffect, useRef } from "react";

// Kik's live orb, as the app draws it (renderer/room/orbs.js): the
// thinking-orbs engine on a canvas. One clock and one animation frame for
// every orb on the page; an orb off screen is skipped, the loop stops while
// the tab is hidden, and with reduced motion each orb is one still frame.

export type KikState = "idle" | "listening" | "thinking" | "speaking" | "asking";

const VERB: Record<KikState, string> = {
  idle: "breathing",
  listening: "listening",
  thinking: "working",
  speaking: "composing",
  asking: "connecting",
};

interface Live {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  preset: 20 | 64;
  mode: string;
  speed: number;
  opts: Record<string, unknown>;
  seen: boolean;
}

const live = new Set<Live>();
let raf = 0;
let reduced = false;

function paint(o: Live, t: number) {
  const css = o.canvas.clientWidth || o.preset;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const px = Math.round(css * dpr);
  if (o.canvas.width !== px) {
    o.canvas.width = px;
    o.canvas.height = px;
  }
  // The engine draws in its preset's box; scale that box to the canvas.
  const k = px / o.preset;
  o.ctx.setTransform(k, 0, 0, k, 0, 0);
  o.ctx.clearRect(0, 0, o.preset, o.preset);
  Engine.MODE_DRAWS[o.mode]?.(o.ctx, o.preset, t * o.speed, true, o.opts);
}

function tick() {
  raf = 0;
  const t = performance.now() / 1000;
  for (const o of live) if (o.seen) paint(o, t);
  if (live.size && !document.hidden && !reduced) raf = requestAnimationFrame(tick);
}

function run() {
  if (!raf && !document.hidden && !reduced) raf = requestAnimationFrame(tick);
}

let io: IntersectionObserver | null = null;
function observer() {
  io ??= new IntersectionObserver((entries) => {
    for (const e of entries)
      for (const o of live) if (o.canvas === e.target) o.seen = e.isIntersecting;
    run();
  });
  return io;
}

export function DotOrb({
  state = "idle",
  size = 64,
  className,
  label,
}: {
  state?: KikState;
  /** 20 for a pill or a card head, 64 for everything larger. */
  size?: 20 | 64;
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const orb = useRef<Live | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const o: Live = { canvas, ctx, preset: size, mode: "", speed: 1, opts: {}, seen: false };
    orb.current = o;
    live.add(o);
    observer().observe(canvas);
    document.addEventListener("visibilitychange", run);
    return () => {
      live.delete(o);
      io?.unobserve(canvas);
      orb.current = null;
    };
  }, [size]);

  useEffect(() => {
    const o = orb.current;
    if (!o) return;
    const p = Engine.resolvePreset(VERB[state], o.preset);
    o.mode = p.mode;
    o.speed = p.speed;
    o.opts = p.opts;
    if (reduced) paint(o, 0.6);
    run();
  }, [state]);

  return (
    <canvas
      ref={ref}
      className={className ? `orb-dots ${className}` : "orb-dots"}
      role="img"
      aria-label={label ?? `Kik is ${state}`}
    />
  );
}
