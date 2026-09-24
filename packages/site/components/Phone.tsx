"use client";

import { useReducedMotion } from "@/lib/hooks";
import { sleep } from "@/lib/hooks";
import { useEffect, useRef, useState } from "react";
import { DotOrb, type KikState } from "./DotOrb";
import { Live, Logo, Pin } from "./Kit";
import { useSound } from "./Sound";

// The phone: Kikoe's phone page (renderer/room/phone.js) drawn with the app's
// pieces, in a frame drawn after this year's phones. The screen is laid out at
// the phone's own width in points and scaled into the frame, so it reads the
// way it does in the hand.

type Model = "iphone" | "pixel";

const MODELS: Record<Model, { name: string; finish: string; w: number; h: number }> = {
  iphone: { name: "iPhone 17 Pro", finish: "Cosmic Orange", w: 402, h: 874 },
  pixel: { name: "Pixel 10 Pro", finish: "Moonstone", w: 412, h: 915 },
};

const TALKS: [string, string, string][] = [
  ["what is it doing?", "storefront is running a command.", "storefront is working."],
  [
    "tell it to run the tests",
    "Queued for storefront; it gets it when its turn ends.",
    "storefront is working.",
  ],
  ["did the tests pass?", "Seventeen passed. It's green.", "storefront is green."],
];

function StatusBar({ model }: { model: Model }) {
  const icons = (
    <span className="sb-icons" aria-hidden="true">
      <svg viewBox="0 0 18 12" width="18" height="12" aria-hidden="true">
        <rect x="0" y="8" width="3" height="4" rx="1" />
        <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
        <rect x="10" y="3" width="3" height="9" rx="1" />
        <rect x="15" y="0" width="3" height="12" rx="1" />
      </svg>
      <svg viewBox="0 0 16 12" width="16" height="12" aria-hidden="true">
        <path d="M8 11.5 5.6 9a3.4 3.4 0 0 1 4.8 0z" />
        <path d="M3.3 6.8a6.6 6.6 0 0 1 9.4 0l-1.5 1.5a4.5 4.5 0 0 0-6.4 0z" />
        <path d="M1 4.5a9.9 9.9 0 0 1 14 0l-1.5 1.5a7.8 7.8 0 0 0-11 0z" />
      </svg>
      <span className="battery">
        <i style={{ width: "78%" }} />
      </span>
    </span>
  );
  return (
    <div className={`statusbar ${model}`}>
      <span className="sb-time">9:41</span>
      {model === "iphone" ? <span className="island-cut" /> : <span className="punch" />}
      {icons}
    </div>
  );
}

function PhoneScreen({ model }: { model: Model }) {
  const { speak } = useSound();
  const reduced = useReducedMotion();
  const [state, setState] = useState<KikState>("idle");
  const [n, setN] = useState(0);
  const [you, setYou] = useState(TALKS[0]![0]);
  const [kik, setKik] = useState(TALKS[0]![1]);
  const [line, setLine] = useState(TALKS[0]![2]);
  const busy = useRef(false);
  const holding = useRef(false);

  async function talk() {
    if (busy.current) return;
    busy.current = true;
    holding.current = true;
    const next = (n + 1) % TALKS.length;
    const [y, k, l] = TALKS[next]!;
    setN(next);
    setState("listening");
    setYou("");
    for (let i = 1; i <= y.length; i++) {
      setYou(y.slice(0, i));
      await sleep(reduced ? 0 : 38);
    }
    while (holding.current) await sleep(60);
    setState("thinking");
    await sleep(reduced ? 0 : 600);
    setState("speaking");
    setKik(k);
    speak(k);
    setLine(l);
    await sleep(reduced ? 0 : 1800);
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
    <div className="phone-ui">
      <StatusBar model={model} />
      <div className="phone-head">
        <Logo size={16} />
        <span>Kikoe</span>
      </div>
      <div className="phone-board">
        <span className="frame-label static">kik</span>
        <Pin
          icon={
            <DotOrb
              size={20}
              state={state === "speaking" ? "speaking" : "idle"}
              className="card-orb"
            />
          }
          title={<span className="k-title">kik · talking</span>}
          age={<Live>with you</Live>}
        >
          <div className="chat">
            <div className="chat-you">{you || "…"}</div>
            <div className="chat-kik">{kik}</div>
            <div className="chat-reply">
              <span className="fake-input">type to kik…</span>
              <span className="fake-send">send</span>
            </div>
          </div>
        </Pin>
        <Pin
          icon={<span className="ring-icon">○</span>}
          title={<span className="k-title">agents</span>}
          age={<Live />}
        >
          <div className="agent-row" data-status="working">
            <span className="dot" />
            <b>storefront</b>
            <span>bash · 6s</span>
          </div>
        </Pin>
        <Pin
          icon={<DotOrb size={20} state="thinking" className="card-orb" />}
          title={<span className="k-title">agent · storefront</span>}
          age={<Live />}
        >
          <div className="log-lines">
            <div>Nothing yet. Say what you want done and it starts here.</div>
            <div className="cmd">storefront · bash</div>
          </div>
        </Pin>
      </div>
      <div className="phone-line">{line}</div>
      <div className="phone-talk">
        <div className="phone-row">
          <span className="phone-sound">
            sound
            <br />
            off
          </span>
          <button
            type="button"
            className="phone-talk-btn"
            data-on={state === "listening" ? "1" : undefined}
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
            <DotOrb state={state} />
          </button>
          <span className="phone-spacer" />
        </div>
        <div className="phone-hint">{state === "listening" ? "listening…" : "hold to talk"}</div>
      </div>
      <span className="home-bar" />
    </div>
  );
}

export function PhoneShowcase() {
  const [model, setModel] = useState<Model>("iphone");
  const reduced = useReducedMotion();
  const device = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.7);
  const m = MODELS[model];

  useEffect(() => {
    const el = screen.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale((e?.contentRect.width ?? m.w) / m.w));
    ro.observe(el);
    return () => ro.disconnect();
  }, [m.w]);

  function tilt(e: React.PointerEvent) {
    const el = device.current;
    if (!el || reduced || e.pointerType !== "mouse") return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.setProperty("--ry", `${(x * 14).toFixed(2)}deg`);
    el.style.setProperty("--rx", `${(-y * 10).toFixed(2)}deg`);
    el.style.setProperty("--gx", `${((x + 0.5) * 100).toFixed(0)}%`);
  }
  function rest() {
    device.current?.style.setProperty("--ry", "-8deg");
    device.current?.style.setProperty("--rx", "3deg");
  }

  return (
    <div className="showcase">
      <div className="model-switch" aria-label="Phone">
        {(Object.keys(MODELS) as Model[]).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={model === k}
            className={model === k ? "on" : undefined}
            onClick={() => setModel(k)}
          >
            {MODELS[k].name}
          </button>
        ))}
      </div>
      <div className="device-stage" onPointerMove={tilt} onPointerLeave={rest}>
        <div ref={device} className={`device ${model}`}>
          <span className="btn b1" />
          <span className="btn b2" />
          <span className="btn b3" />
          <span className="btn b4" />
          {model === "iphone" && <span className="btn b5" />}
          <div className="shell">
            <div className="bezel">
              <div className="screen" ref={screen} style={{ aspectRatio: `${m.w} / ${m.h}` }}>
                <div
                  className="screen-inner"
                  style={{ width: m.w, height: m.h, transform: `scale(${scale})` }}
                >
                  <PhoneScreen model={model} />
                </div>
              </div>
            </div>
          </div>
          <span className="glare" />
        </div>
      </div>
      <p className="fine device-note">
        {m.name}, {m.finish}. A drawn frame; the screen is Kikoe's phone page, live. Hold the orb.
      </p>
    </div>
  );
}
