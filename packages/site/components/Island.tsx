"use client";

import { useInView, useReducedMotion } from "@/lib/hooks";
import { useEffect, useRef, useState } from "react";
import { DotOrb, type KikState } from "./DotOrb";

// The island (renderer/island): one dark pill, one row, glanced at. Kik's
// state, what is happening, and a ring for how much of each assistant's limit
// is used. It cycles through a turn while it is on screen.

const R = 10.4;
const C = 2 * Math.PI * R;

type Band = "ample" | "watch" | "critical";
const band = (used: number): Band => (used >= 0.7 ? "critical" : used >= 0.5 ? "watch" : "ample");

const STEPS: { state: string; orb: KikState; text: string; live: boolean }[] = [
  { state: "working", orb: "thinking", text: "storefront · bash pnpm test", live: true },
  { state: "permission", orb: "asking", text: "storefront wants to run pnpm build", live: true },
  { state: "listening", orb: "listening", text: "“yes”", live: true },
  { state: "speaking", orb: "speaking", text: "Storefront's done. Tests green.", live: true },
  { state: "idle", orb: "idle", text: "", live: false },
];

function Burst() {
  // the asterisk: six strokes from 1.5 to 4.6, centred on 12,12
  const rays = [0, 1, 2, 3, 4, 5].map((i) => {
    const a = (i * Math.PI) / 3 - Math.PI / 2;
    return {
      id: `r${i}`,
      x1: 12 + 1.5 * Math.cos(a),
      y1: 12 + 1.5 * Math.sin(a),
      x2: 12 + 4.6 * Math.cos(a),
      y2: 12 + 4.6 * Math.sin(a),
    };
  });
  return (
    <g className="ring-glyph">
      {rays.map((r) => (
        <line key={r.id} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} />
      ))}
    </g>
  );
}

function Prompt() {
  return (
    <g className="ring-glyph">
      <polyline points="9.7,9 13,12 9.7,15" />
      <line x1="14.4" y1="15" x2="16.6" y2="15" />
    </g>
  );
}

function Ring({
  used,
  glyph,
  label,
}: { used: number; glyph: "claude" | "opencode"; label: string }) {
  return (
    <div className="ring-cell" data-band={band(used)} title={label}>
      <svg className="ring" viewBox="0 0 24 24" width="23" height="23" aria-hidden="true">
        <circle className="ring-track" cx="12" cy="12" r={R} />
        <circle
          className="ring-arc"
          cx="12"
          cy="12"
          r={R}
          strokeDasharray={C}
          strokeDashoffset={C * (1 - used)}
        />
        {glyph === "claude" ? <Burst /> : <Prompt />}
      </svg>
      <span className="ring-pct">{Math.round(used * 100)}%</span>
    </div>
  );
}

export function Island() {
  const box = useRef<HTMLDivElement>(null);
  const seen = useInView(box);
  const reduced = useReducedMotion();
  const [i, setI] = useState(0);
  const [used, setUsed] = useState([0, 0]);

  useEffect(() => {
    if (!seen) return;
    setUsed([0.34, 0.58]);
    if (reduced) return;
    const t = setInterval(() => setI((n) => (n + 1) % STEPS.length), 2400);
    return () => clearInterval(t);
  }, [seen, reduced]);

  const s = STEPS[i] ?? STEPS[0]!;
  return (
    <div className="island-wrap" ref={box}>
      <div className="island" data-state={s.state}>
        <span className="orb-mini">
          <DotOrb size={20} state={s.orb} />
        </span>
        <span className="text">{s.text}</span>
        <span className="state">{s.state}</span>
        <span className="rule" />
        <div className="rings">
          <Ring used={used[0] ?? 0} glyph="claude" label="Claude: 34% of this window used" />
          <Ring used={used[1] ?? 0} glyph="opencode" label="OpenCode: 58% used" />
        </div>
      </div>
    </div>
  );
}
