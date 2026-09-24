"use client";

import { useReducedMotion } from "@/lib/hooks";
import { useRef, useState } from "react";
import { useSound } from "./Sound";

// The three sessions, run at their real speeds: the talking session's first
// word under a second, the thinking session about twenty-five, and the agent
// as long as the work takes.

interface LaneState {
  st: string;
  frac: number;
  t: number;
  out: string;
}

const LANES = [
  {
    k: "talk",
    name: "kik · talking",
    h: "The conversation",
    p: "Kik's side of the talk. One Claude Code process kept open and fed each line, so the first word arrives quickly.",
    model: "Haiku, thinking off",
    speed: "first word 0.5–1.7 s",
  },
  {
    k: "think",
    name: "kik · thinking",
    h: "Real thought",
    p: "Questions that need it go to a fresh run with extended thinking, in the background. You keep talking. The detail lands on the canvas.",
    model: "Opus, extended thinking",
    speed: "~25 s",
  },
  {
    k: "agent",
    name: "agent · storefront",
    h: "The work",
    p: "Claude Code in the project folder. Its hooks bring back what it did: narrated, with permissions held until you answer.",
    model: "Claude Code",
    speed: "as long as the work takes",
  },
] as const;

const AGENT: [number, string][] = [
  [0.8, "reading src/store/db.ts"],
  [3, "Edit · src/store/db.ts"],
  [6, "permission · Bash"],
  [9, "running the tests"],
  [14, "tests green"],
  [18, "turn done"],
];

const READY: LaneState = { st: "ready", frac: 0, t: 0, out: "" };

export function SessionsRace() {
  const { speak } = useSound();
  const reduced = useReducedMotion();
  const [lanes, setLanes] = useState<Record<string, LaneState>>({
    talk: READY,
    think: READY,
    agent: READY,
  });
  const running = useRef(false);

  function race() {
    if (running.current) return;
    running.current = true;
    const start = performance.now();
    const speed = reduced ? 20 : 1;
    let last = 0;
    const frame = (now: number) => {
      const t = ((now - start) / 1000) * speed;
      if (now - last > 50 || t >= 25) {
        last = now;
        const a = [...AGENT].reverse().find((x) => t >= x[0]);
        const agentOut =
          t >= 18
            ? "Storefront's done. Tests green."
            : t >= 6
              ? "It wants to run the tests. Yes or no?"
              : "";
        setLanes({
          talk:
            t < 0.9
              ? { st: "listening", frac: t / 0.9, t, out: "" }
              : {
                  st: "first word",
                  frac: 1,
                  t: 0.9,
                  out: "Thinking on it. The short answer's coming; the detail goes on the board.",
                },
          think:
            t < 25
              ? { st: "thinking", frac: t / 25, t, out: "" }
              : {
                  st: "done",
                  frac: 1,
                  t: 25,
                  out: "SQLite, if you'll ever query across projects. A JSON file each, if a board is only read whole.",
                },
          agent: {
            st: a ? a[1] : "starting",
            frac: Math.min(t / 18, 1),
            t: Math.min(t, 18),
            out: agentOut,
          },
        });
      }
      if (t < 25) requestAnimationFrame(frame);
      else {
        speak("SQLite, if you'll ever query across projects.");
        running.current = false;
      }
    };
    requestAnimationFrame(frame);
  }

  return (
    <>
      <div className="race-row">
        <button type="button" className="pill-btn solid" onClick={race}>
          ▶ Run all three
        </button>
        <span className="q">“SQLite or a JSON file per project?”</span>
      </div>
      <div className="lanes">
        {LANES.map((l) => {
          const s = lanes[l.k] ?? READY;
          return (
            <article className="lane" key={l.k}>
              <div className="name">{l.name}</div>
              <h3>{l.h}</h3>
              <p>{l.p}</p>
              <dl>
                <dt>model</dt>
                <dd>{l.model}</dd>
                <dt>speed</dt>
                <dd>{l.speed}</dd>
              </dl>
              <div className="track">
                <div className="fill" style={{ transform: `scaleX(${s.frac})` }} />
                <div className="clock">
                  <span>{s.st}</span>
                  <span>{s.t.toFixed(1)} s</span>
                </div>
              </div>
              <div className="said-out">{s.out}</div>
            </article>
          );
        })}
      </div>
    </>
  );
}
