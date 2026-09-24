"use client";

import { asset, useInView, useReducedMotion } from "@/lib/hooks";
import { useEffect, useRef, useState } from "react";
import { DotOrb, type KikState } from "./DotOrb";
import { Live, Logo, Pin } from "./Kit";

// The Room, drawn with the app's own pieces at the app's own size (1280 by
// 800) and scaled to fit. It plays the diff-to-green loop while it is on
// screen, so it is the product working rather than a picture of it.

interface Scene {
  orb: KikState;
  repo: string;
  line: React.ReactNode;
  hints: string[];
  asking: boolean;
  events: [string, string][];
  tests: string;
}

const SCENES: Scene[] = [
  {
    orb: "asking",
    repo: "in storefront",
    line: (
      <>
        The diff's on the board. <em>Apply it?</em>
      </>
    ),
    hints: ["apply", "no", "clear the board"],
    asking: true,
    events: [
      ["09:33 PM", "bash ok"],
      ["09:33 PM", "edit ok"],
      ["09:33 PM", "bash"],
    ],
    tests: "tests: all 16 passed",
  },
  {
    orb: "speaking",
    repo: "in storefront",
    line: (
      <>
        Applied. <em>Running the tests.</em>
      </>
    ),
    hints: ["stop", "what's it doing"],
    asking: false,
    events: [
      ["09:33 PM", "edit ok"],
      ["09:34 PM", "applied tts.ts"],
      ["09:34 PM", "bash pnpm test"],
    ],
    tests: "running pnpm test…",
  },
  {
    orb: "idle",
    repo: "in storefront",
    line: (
      <>
        Seventeen passed. <em>Storefront's green.</em>
      </>
    ),
    hints: ["what changed", "open it in VS Code"],
    asking: false,
    events: [
      ["09:34 PM", "applied tts.ts"],
      ["09:34 PM", "bash ok"],
      ["09:35 PM", "tests 17 passed"],
    ],
    tests: "tests: all 17 passed",
  },
];

export function RoomPreview() {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [i, setI] = useState(0);
  const seen = useInView(box);
  const reduced = useReducedMotion();

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale((e?.contentRect.width ?? 1280) / 1280));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!seen || reduced) return;
    const t = setInterval(() => setI((n) => (n + 1) % SCENES.length), 3600);
    return () => clearInterval(t);
  }, [seen, reduced]);

  const s = SCENES[i] ?? SCENES[0]!;
  return (
    <div className="room-box" ref={box} style={{ height: 800 * scale }}>
      <div
        className="room"
        style={{ transform: `scale(${scale})` }}
        role="img"
        aria-label="The Room: Kik's conversation, the agents, the agent's session, what happened, and a diff waiting on an answer"
      >
        <div
          className="room-backdrop"
          style={{ backgroundImage: `url(${asset("/img/backdrop.webp")})` }}
        />
        <div className="titlebar">
          <Logo size={14} />
          <span className="tb-title">Kikoe</span>
          <span className="tb-actions">
            <span>control room</span>
            <span>clear the board</span>
            <span>settings</span>
          </span>
        </div>
        <div className="zoom-hud">
          <span>−</span>
          <span>86%</span>
          <span>+</span>
          <span>fit</span>
        </div>

        <span className="frame-label" style={{ left: 75, top: 100 }}>
          kik
        </span>
        <span className="frame-label" style={{ left: 620, top: 100 }}>
          storefront
        </span>
        <span className="frame-label" style={{ left: 1163, top: 100 }}>
          api
        </span>

        <Pin
          style={{ left: 93, top: 141, width: 435 }}
          asking
          icon={
            <DotOrb
              size={20}
              state={s.orb === "speaking" ? "speaking" : "idle"}
              className="card-orb"
            />
          }
          title={<span className="k-title">kik · talking</span>}
          age={<Live>with you</Live>}
        >
          <div className="chat">
            <div className="chat-you">add a retry to the token refresh</div>
            <div className="chat-kik">Queued for storefront; it gets it when its turn ends.</div>
            <div className="chat-reply">
              <span className="fake-input">type to kik…</span>
              <span className="fake-send">send</span>
            </div>
          </div>
        </Pin>

        <Pin
          style={{ left: 93, top: 360, width: 435 }}
          icon={<span className="ring-icon">○</span>}
          title={<span className="k-title">agents</span>}
          age={<Live />}
        >
          <div className="agent-row" data-status="working">
            <span className="dot" />
            <b>storefront</b>
            <span>{s.orb === "idle" ? "idle" : "working ·"}</span>
          </div>
        </Pin>

        <Pin
          style={{ left: 93, top: 474, width: 435 }}
          icon={<DotOrb size={20} state="thinking" className="card-orb" />}
          title={<span className="k-title">agent · storefront</span>}
          age={<Live />}
        >
          <div className="log-lines">
            <div>edited tts.ts +2 −1</div>
            <div>{s.tests}</div>
          </div>
          <div className="chat">
            <div className="chat-you mono">add a retry to the token refresh</div>
          </div>
        </Pin>

        <Pin
          style={{ left: 637, top: 141, width: 435 }}
          icon={<span className="ring-icon">○</span>}
          title={<span className="k-title">what happened</span>}
          age={<Live />}
        >
          {s.events.map(([t, e]) => (
            <div className="event-row" key={`${t}-${e}`}>
              <span className="t">{t}</span>
              <span>{e}</span>
            </div>
          ))}
        </Pin>

        <Pin
          style={{ left: 637, top: 333, width: 700 }}
          asking={s.asking}
          icon={<span className="plus">+</span>}
          title="tts.ts +2 −1"
          foot={
            <>
              <button type="button" className="primary" tabIndex={-1}>
                apply
              </button>
              <button type="button" tabIndex={-1}>
                no
              </button>
              <button type="button" tabIndex={-1}>
                download
              </button>
              <button type="button" tabIndex={-1}>
                ask kik
              </button>
            </>
          }
        >
          <pre>
            <span className="hunk">line 118</span>
            <span className="ctx">{"  async speak(line: string) {"}</span>
            <span className="del">{"-   return this.eleven(line);"}</span>
            <span className="add">{"+   const voice = this.pick(line);"}</span>
            <span className="add">
              {"+   return voice ? this.eleven(line, voice) : this.piper(line);"}
            </span>
            <span className="ctx">{"  }"}</span>
          </pre>
        </Pin>

        <Pin
          style={{ left: 1181, top: 141, width: 300 }}
          icon={<span className="ring-icon">○</span>}
          title="why the retry"
        >
          <h3>Why the retry is three</h3>
          <p>Three attempts with backoff cover a cold token server.</p>
        </Pin>

        <div className="line">
          <div className="line-repo">{s.repo}</div>
          <div className="line-text" key={i}>
            {s.line}
          </div>
          <div className="line-hint">
            {s.hints.map((h) => (
              <span key={h}>
                say <b>{h}</b>
              </span>
            ))}
          </div>
        </div>
        <div className="room-orb">
          <DotOrb state={s.orb} />
        </div>
      </div>
    </div>
  );
}
