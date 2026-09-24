"use client";

import { useEffect, useRef, useState } from "react";
import { DotOrb, type KikState } from "./DotOrb";
import { useSound } from "./Sound";

// Kik in the corner. It says one line the first time each section comes into
// view (the line is the section's data-kik), and never repeats itself.
// Clicking it hushes it, the way "quiet" does.

export function Companion() {
  const { speak } = useSound();
  const [line, setLine] = useState<string | null>(null);
  const [state, setState] = useState<KikState>("idle");
  const [hushed, setHushed] = useState(false);
  const hushedRef = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const say = useRef<(text: string) => void>(() => {});
  say.current = (text: string) => {
    if (hushedRef.current) return;
    for (const t of timers.current) clearTimeout(t);
    setLine(text);
    setState("speaking");
    speak(text);
    timers.current = [
      setTimeout(() => setState("idle"), 2400),
      setTimeout(() => setLine(null), 6500),
    ];
  };

  useEffect(() => {
    const said = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const el = e.target as HTMLElement;
          const text = el.dataset.kik;
          if (!e.isIntersecting || !text || said.has(el.id)) continue;
          said.add(el.id);
          say.current(text);
        }
      },
      { threshold: 0.25 },
    );
    for (const el of document.querySelectorAll("[data-kik]")) io.observe(el);
    const hello = setTimeout(() => {
      if (!said.size) say.current("Hello. Hold the orb, or scroll and I'll show you round.");
    }, 1800);
    return () => {
      io.disconnect();
      clearTimeout(hello);
    };
  }, []);

  return (
    <div className="companion">
      <div className={line ? "bub" : "bub hide"} aria-live="polite">
        {line}
        <small>kik · click me to hush</small>
      </div>
      <button
        type="button"
        className="companion-orb"
        aria-pressed={hushed}
        aria-label={hushed ? "Kik is hushed. Click to wake" : "Kik. Click to hush"}
        onClick={() => {
          const next = !hushed;
          setHushed(next);
          hushedRef.current = next;
          if (next) {
            setLine(null);
            setState("idle");
            try {
              speechSynthesis.cancel();
            } catch {}
          } else say.current("I'm back. I'll only speak when there's a reason.");
        }}
      >
        <DotOrb state={state} />
      </button>
    </div>
  );
}
