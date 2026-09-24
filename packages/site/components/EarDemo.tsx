"use client";

import { useInView } from "@/lib/hooks";
import { useEffect, useRef, useState } from "react";

// The room, overheard. Each sentence arrives with a score; what was for Kik
// is kept, and the rest is dropped whole, leaving only its word count.

const ROOM: [string, number][] = [
  ["yeah mum, down in five", 0.04],
  ["kik, is the build green?", 1],
  ["did you feed the cat", 0.07],
  ["and did it work?", 0.82],
  ["ugh, this meeting could've been an email", 0.03],
  ["tell it to run the tests again", 0.91],
  ["no, the blue one, by the door", 0.05],
  ["kik, quiet", 1],
  ["I'll call you back after lunch", 0.02],
  ["open storefront in VS Code", 0.88],
  ["what time is the dentist on thursday", 0.09],
  ["what's it waiting on?", 0.86],
];

type Phase = "enter" | "mid" | "kept" | "gone";
interface Said {
  id: number;
  text: string;
  p: number;
  phase: Phase;
}

export function EarDemo() {
  const box = useRef<HTMLDivElement>(null);
  const seen = useInView(box, "-10% 0px");
  const [items, setItems] = useState<Said[]>([]);
  const [dropped, setDropped] = useState(0);
  const [kept, setKept] = useState<{ id: number; text: string }[]>([]);
  const next = useRef(0);

  useEffect(() => {
    if (!seen) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, f: () => void) => {
      const t = setTimeout(() => {
        timers.delete(t);
        f();
      }, ms);
      timers.add(t);
    };
    const phase = (id: number, p: Phase) =>
      setItems((xs) => xs.map((x) => (x.id === id ? { ...x, phase: p } : x)));

    const step = () => {
      const id = next.current++;
      const [text, p] = ROOM[id % ROOM.length]!;
      setItems((xs) => [...xs.slice(-3), { id, text, p, phase: "enter" }]);
      later(40, () => phase(id, "mid"));
      later(1600, () => {
        if (p >= 0.6) {
          phase(id, "kept");
          later(900, () => {
            phase(id, "gone");
            setKept((k) => [{ id, text }, ...k].slice(0, 4));
          });
        } else {
          phase(id, "gone");
          setDropped((d) => d + text.split(/\s+/).length);
        }
      });
      later(2600, step);
    };
    step();
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [seen]);

  return (
    <div className="ear-grid" ref={box}>
      <div
        className="room-feed"
        aria-label="A simulated room: sentences arrive and are kept or dropped"
      >
        <div className="tag">the room · live, simulated</div>
        {items.map((s) => (
          <div key={s.id} className={`said ${s.phase}${s.p >= 0.6 ? " for-kik" : ""}`}>
            <span className="q">“{s.text}”</span>
            <span className="p">{s.p === 1 ? "name" : s.p.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="ear-side">
        <div className="counter">
          <div className="n">{dropped}</div>
          <div className="l">words dropped. This number is all that survives of them.</div>
        </div>
        <div className="counter">
          <div className="l">kept for Kik</div>
          <ul className="kept-list">
            {kept.map((k) => (
              <li key={k.id}>{k.text}</li>
            ))}
          </ul>
        </div>
        <p className="fine">
          Scores are illustrative, except two measured on real sentences: “yeah mum, down in five”
          scored 0.04, and “and did it work?” scored 0.82.
        </p>
      </div>
    </div>
  );
}
