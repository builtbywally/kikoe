"use client";

import { sleep, useReducedMotion } from "@/lib/hooks";
import { useEffect, useRef, useState } from "react";
import { DotOrb, type KikState } from "./DotOrb";
import { useSound } from "./Sound";

// Hold the orb and talk. What you "say" types itself out while you hold; let
// go and Kik answers in one line. The orb is the app's, in its real states.

const TALKS: [string, string][] = [
  [
    "Kik, what's it doing?",
    "Halfway through the token refresh. Two files changed, tests not run yet.",
  ],
  [
    "Tell it to add a retry to the token refresh.",
    "It's mid-turn. I'll hand it over when it stops.",
  ],
  ["Make me a release checklist.", "On the board. Four items, the first one's already done."],
  [
    "Think this through: SQLite or a JSON file per project?",
    "Thinking on it. I'll put the detail on the canvas.",
  ],
  ["Open storefront in VS Code.", "Opening it."],
  [
    "Kik, how much of my limit is left?",
    "About a third used this window. You're fine for the afternoon.",
  ],
];

const LABEL: Record<KikState, string> = {
  idle: "hold the orb to talk",
  listening: "listening…",
  thinking: "for Kik · routing",
  speaking: "speaking",
  asking: "waiting on you",
};

export function HeroTalk() {
  const { speak } = useSound();
  const reduced = useReducedMotion();
  const [state, setState] = useState<KikState>("idle");
  const [you, setYou] = useState(TALKS[0]![0]);
  const [kik, setKik] = useState<string | null>(TALKS[0]![1]);
  const [typing, setTyping] = useState<"you" | "kik" | null>(null);
  const n = useRef(1);
  const busy = useRef(false);
  const holding = useRef(false);

  async function talk() {
    if (busy.current) return;
    busy.current = true;
    holding.current = true;
    const [y, k] = TALKS[n.current++ % TALKS.length]!;
    setState("listening");
    setKik(null);
    setTyping("you");
    for (let i = 1; i <= y.length; i++) {
      setYou(y.slice(0, i));
      await sleep(reduced ? 0 : 32);
    }
    setTyping(null);
    while (holding.current) await sleep(60);
    setState("thinking");
    await sleep(reduced ? 0 : 650);
    setState("speaking");
    speak(k);
    setTyping("kik");
    for (let i = 1; i <= k.length; i++) {
      setKik(k.slice(0, i));
      await sleep(reduced ? 0 : 26);
    }
    setTyping(null);
    await sleep(900);
    setState("idle");
    busy.current = false;
  }

  useEffect(() => {
    const up = () => {
      holding.current = false;
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  return (
    <div className="stage">
      <div className="orb-stage">
        <span className="halo a" />
        <span className="halo b" />
        <span className="halo c" />
        <button
          type="button"
          className="hero-orb"
          data-state={state}
          aria-label="Hold to talk to Kik"
          onPointerDown={(e) => {
            e.preventDefault();
            talk();
          }}
          onKeyDown={(e) => {
            if ((e.key === " " || e.key === "Enter") && !e.repeat) {
              e.preventDefault();
              talk();
            }
          }}
          onKeyUp={() => {
            holding.current = false;
          }}
        >
          <DotOrb state={state} label={`Kik is ${state}. Hold to talk.`} />
        </button>
      </div>
      <div className="orb-label">{LABEL[state]}</div>
      <div className="transcript" aria-live="polite">
        <p className={typing === "you" ? "you caret" : "you"}>
          <span className="who">you</span>
          {you}
        </p>
        {kik != null && (
          <p className={typing === "kik" ? "kik caret" : "kik"}>
            <span className="who">kik</span>
            {kik}
          </p>
        )}
      </div>
    </div>
  );
}
