"use client";

import { useInView } from "@/lib/hooks";
import { useEffect, useRef, useState } from "react";

// Claude Code's hooks going in, and what the daemon does with each one.

const LINES: [string, string][] = [
  ["SessionStart", "agent · storefront is on the board"],
  ["UserPromptSubmit", "“add a retry to the token refresh”"],
  ["PreToolUse · Read src/auth.ts", "narrated: “Reading the auth code.”"],
  ["PostToolUse · Edit src/auth.ts", "a diff card: again · revert · explain"],
  ["PermissionRequest · Bash pnpm test", "held open. Kik: “It wants to run the tests. Yes or no?”"],
  ["you: “yes”", "reflex → allowed. No model in between"],
  ["PostToolUse · Bash", "a run card: 24 passing"],
  ["Notification", "the orb turns ember: waiting on you"],
  ["Stop", "Kik: “Storefront's done. Tests green.”"],
];

export function Hooks() {
  const box = useRef<HTMLDivElement>(null);
  const seen = useInView(box);
  const [n, setN] = useState(3);

  useEffect(() => {
    if (!seen) return;
    const t = setInterval(() => setN((x) => x + 1), 1800);
    return () => clearInterval(t);
  }, [seen]);

  const rows = Array.from({ length: Math.min(n, 6) }, (_, i) => {
    const k = n - Math.min(n, 6) + i;
    const [h, o] = LINES[k % LINES.length]!;
    return { k, h, o };
  });
  const current = rows.at(-1)?.h.split(" · ")[0] ?? "";

  return (
    <div className="hooks" ref={box}>
      <div className="diagram">
        <svg
          viewBox="0 0 760 300"
          role="img"
          aria-label="Claude Code hooks flow into the Kikoe daemon, which drives the voice, the canvas and the phone"
        >
          <defs>
            <radialGradient id="dg" cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="#d2683f" stopOpacity=".5" />
              <stop offset="1" stopColor="#d2683f" stopOpacity="0" />
            </radialGradient>
          </defs>
          <path id="w1" className="wire" d="M190 150 C 260 150, 270 150, 330 150" />
          <path id="w2" className="wire" d="M430 130 C 500 90, 520 60, 580 60" />
          <path id="w3" className="wire" d="M430 150 C 500 150, 520 150, 580 150" />
          <path id="w4" className="wire" d="M430 170 C 500 210, 520 240, 580 240" />
          <path id="w5" className="wire" d="M580 70 C 520 70, 490 110, 432 140" />
          <rect className="box" x="20" y="105" width="170" height="90" rx="14" />
          <text className="big" x="40" y="145">
            Claude Code
          </text>
          <text x="40" y="170">
            hooks in every session
          </text>
          <circle cx="380" cy="150" r="58" fill="url(#dg)" />
          <g className="ring-dots">
            {Array.from({ length: 24 }, (_, i) => `d${i}`).map((id, i) => (
              <circle
                key={id}
                cx={380 + 34 * Math.cos((i * Math.PI) / 12)}
                cy={150 + 34 * Math.sin((i * Math.PI) / 12)}
                r="2.2"
              />
            ))}
          </g>
          <text x="338" y="232">
            daemon :4570
          </text>
          <rect className="box" x="580" y="30" width="160" height="60" rx="12" />
          <text className="big" x="598" y="66">
            the voice
          </text>
          <rect className="box" x="580" y="120" width="160" height="60" rx="12" />
          <text className="big" x="598" y="156">
            the canvas
          </text>
          <rect className="box" x="580" y="210" width="160" height="60" rx="12" />
          <text className="big" x="598" y="246">
            your phone
          </text>
          <text x="204" y="136" className="accent">
            {current.startsWith("you") ? "" : current}
          </text>
          <text x="470" y="100" className="faint">
            you: “yes”
          </text>
          <circle r="5" className="p1">
            <animateMotion dur="1.6s" repeatCount="indefinite">
              <mpath href="#w1" />
            </animateMotion>
          </circle>
          <circle r="4" className="p2">
            <animateMotion dur="2.2s" begin=".3s" repeatCount="indefinite">
              <mpath href="#w2" />
            </animateMotion>
          </circle>
          <circle r="4" className="p2">
            <animateMotion dur="1.9s" begin=".6s" repeatCount="indefinite">
              <mpath href="#w3" />
            </animateMotion>
          </circle>
          <circle r="4" className="p2">
            <animateMotion dur="2.4s" begin=".1s" repeatCount="indefinite">
              <mpath href="#w4" />
            </animateMotion>
          </circle>
          <circle r="3.5" className="p3">
            <animateMotion dur="3s" begin="1s" repeatCount="indefinite">
              <mpath href="#w5" />
            </animateMotion>
          </circle>
        </svg>
      </div>
      <div className="log">
        <div className="fine">daemon.log · simulated</div>
        {rows.map((r) => (
          <div className="row" key={r.k}>
            <span className="h">{r.h}</span>
            <span className="o">{r.o}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
