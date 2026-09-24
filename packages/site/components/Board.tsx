"use client";

import { sleep, useReducedMotion } from "@/lib/hooks";
import { useRef, useState } from "react";
import { DotOrb, type KikState } from "./DotOrb";
import { Live, Pin } from "./Kit";
import { useSound } from "./Sound";

// A board you can use: pan it, drag cards by their heads, press the buttons.
// The cards are the app's pins. Moving is done on the element directly, so a
// drag never re-renders React.

const TO_AGENT: Record<string, string> = {
  again: "Do that edit again, from scratch.",
  revert: "Revert the change to auth.ts.",
  explain: "Explain the change to auth.ts.",
};
const W = 1600;
const H = 1000;
const TESTS = Array.from({ length: 24 }, (_, i) => `t${i}`);

export function Board() {
  const { speak } = useSound();
  const reduced = useReducedMotion();
  const board = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const pan = useRef({ x: -20, y: -10 });
  const drag = useRef<{
    el: HTMLElement | null;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
  } | null>(null);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [orb, setOrb] = useState<KikState>("asking");
  const [bubble, setBubble] = useState("The agent wants to run the auth tests. Yes or no?");
  const [sent, setSent] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [perm, setPerm] = useState<"waiting" | "allowed" | "denied">("waiting");
  const [green, setGreen] = useState(0);
  const [running, setRunning] = useState(false);
  const [checks, setChecks] = useState([true, false, false, false]);

  function say(text: string, after: KikState) {
    setOrb("speaking");
    setBubble(text);
    speak(text);
    clearTimeout(bubbleTimer.current);
    bubbleTimer.current = setTimeout(() => setOrb(after), 2600);
  }

  function down(e: React.PointerEvent) {
    const t = e.target as HTMLElement;
    if (t.closest("button, input, label")) return;
    const card = t.closest<HTMLElement>(".pin");
    if (card && !t.closest(".pin-head")) return;
    drag.current = card
      ? { el: card, sx: e.clientX, sy: e.clientY, ox: card.offsetLeft, oy: card.offsetTop }
      : { el: null, sx: e.clientX, sy: e.clientY, ox: pan.current.x, oy: pan.current.y };
    if (card) card.classList.add("dragging");
    else board.current?.classList.add("panning");
    board.current?.setPointerCapture(e.pointerId);
  }
  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.el) {
      d.el.style.left = `${d.ox + dx}px`;
      d.el.style.top = `${d.oy + dy}px`;
      return;
    }
    const b = board.current;
    if (!b || !world.current) return;
    pan.current = {
      x: Math.min(40, Math.max(b.clientWidth - W, d.ox + dx)),
      y: Math.min(40, Math.max(b.clientHeight - H, d.oy + dy)),
    };
    world.current.style.transform = `translate(${pan.current.x}px, ${pan.current.y}px)`;
  }
  function up() {
    drag.current?.el?.classList.remove("dragging");
    board.current?.classList.remove("panning");
    drag.current = null;
  }

  function act(a: string) {
    setSent(TO_AGENT[a] ?? null);
    setNotes((n) => ({ ...n, diff: "queued for the end of its turn" }));
    say(
      a === "explain" ? "Asked it to explain. I'll put the answer here." : "Handed to the agent.",
      perm === "waiting" ? "asking" : "idle",
    );
  }

  async function answer(yes: boolean) {
    if (perm !== "waiting") return;
    if (!yes) {
      setPerm("denied");
      say("Told it no. It'll carry on without the tests.", "idle");
      return;
    }
    setPerm("allowed");
    say("Allowed. Running the auth tests.", "thinking");
    setRunning(true);
    for (let i = 1; i <= TESTS.length; i++) {
      await sleep(reduced ? 0 : 90);
      setGreen(i);
    }
    setRunning(false);
    await sleep(600);
    say("Auth's green. Twenty-four passing.", "idle");
    setChecks((c) => [c[0] ?? true, true, c[2] ?? false, c[3] ?? false]);
  }

  const items = [
    "Retry on token refresh",
    "Tests green on auth",
    "Changelog line",
    "Tag and build the installer",
  ];
  const testNote =
    perm === "denied"
      ? "not run: you said no"
      : running
        ? "running…"
        : green === TESTS.length
          ? "24 passing"
          : "24 failing: waiting on your permission";

  return (
    <div
      className="board demo-board"
      ref={board}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <div
        className="world grid-bg"
        ref={world}
        style={{ width: W, height: H, transform: "translate(-20px, -10px)" }}
      >
        <span className="frame-label" style={{ left: 62, top: 26 }}>
          storefront
        </span>
        <Pin
          style={{ left: 60, top: 50, width: 320 }}
          icon={<span className="plus">+</span>}
          title="auth.ts +2 −1"
          age={<Live />}
          foot={
            <>
              {Object.keys(TO_AGENT).map((k) => (
                <button type="button" key={k} onClick={() => act(k)}>
                  {k}
                </button>
              ))}
              <span className="note">{notes.diff}</span>
            </>
          }
        >
          <pre>
            <span className="hunk">line 42</span>
            <span className="del">{"- const token = await refresh();"}</span>
            <span className="add">{"+ const token = await retry(refresh, {"}</span>
            <span className="add">{"+   attempts: 3, backoff: 250 });"}</span>
          </pre>
        </Pin>

        <Pin
          style={{ left: 430, top: 110, width: 300 }}
          asking={perm === "waiting"}
          icon={<span className="ring-icon">○</span>}
          title="permission · Bash"
          age={
            perm === "waiting"
              ? "asking"
              : perm === "allowed"
                ? "allowed by voice"
                : "denied by voice"
          }
          foot={
            perm === "waiting" ? (
              <>
                <button type="button" className="primary" onClick={() => answer(true)}>
                  say “yes”
                </button>
                <button type="button" onClick={() => answer(false)}>
                  say “no”
                </button>
              </>
            ) : (
              <span className="note">
                {perm === "allowed" ? "“yes” · no model in between" : "“no”"}
              </span>
            )
          }
        >
          <pre>
            <span className="cmd">pnpm test --filter auth</span>
            <span className="ctx">the agent is waiting on you</span>
          </pre>
        </Pin>

        <Pin
          style={{ left: 120, top: 330, width: 320 }}
          icon={<span className="ring-icon">○</span>}
          title="run · auth.test.ts"
          age={running ? <Live /> : undefined}
        >
          <div className="tests">
            {TESTS.map((t, i) => (
              <b key={t} className={i < green ? "ok" : undefined} />
            ))}
          </div>
          <div className="ctx">{testNote}</div>
        </Pin>

        <Pin
          style={{ left: 490, top: 390, width: 290 }}
          icon={<DotOrb size={20} className="card-orb" />}
          title={<span className="k-title">kik · release checklist</span>}
        >
          <div className="checklist">
            {items.map((label, i) => (
              <label className="check-row" key={label} data-done={checks[i] ? "1" : undefined}>
                <input
                  type="checkbox"
                  checked={Boolean(checks[i])}
                  onChange={(e) =>
                    setChecks((c) => c.map((v, j) => (j === i ? e.target.checked : v)))
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </Pin>

        <Pin
          style={{ left: 830, top: 60, width: 330 }}
          icon={<DotOrb size={20} state="thinking" className="card-orb" />}
          title={<span className="k-title">kik · thinking</span>}
        >
          <p className="serif-17">
            SQLite, if you'll ever query across projects. A JSON file each, if a board is only ever
            read whole.
          </p>
          <p>The detail stays here. Kik said the short version out loud.</p>
        </Pin>

        <Pin
          style={{ left: 850, top: 330, width: 300 }}
          icon={<span className="ring-icon">○</span>}
          title="diagram · retry flow"
        >
          <svg
            viewBox="0 0 250 120"
            width="100%"
            role="img"
            aria-label="Retry flow: refresh, check, token; on no, wait 250 ms and try again, three times"
          >
            <g fontFamily="var(--mono)" fontSize="10" fill="#f5f1ec">
              <rect x="4" y="44" width="62" height="30" rx="6" fill="none" stroke="#8b8b80" />
              <text x="14" y="63">
                refresh
              </text>
              <rect x="96" y="44" width="56" height="30" rx="6" fill="none" stroke="#d2683f" />
              <text x="110" y="63">
                ok?
              </text>
              <rect x="182" y="44" width="62" height="30" rx="6" fill="none" stroke="#8b8b80" />
              <text x="196" y="63">
                token
              </text>
              <path d="M66 59H96M152 59H182" stroke="#8b8b80" fill="none" />
              <path d="M124 74V100H35V74" stroke="#d2683f" fill="none" strokeDasharray="3 3" />
              <text x="46" y="114" fill="#8b8b80">
                no · wait 250 ms · ×3
              </text>
            </g>
          </svg>
        </Pin>
      </div>

      {sent && (
        <div className="sent">
          → sent to the agent: <b>“{sent}”</b>
        </div>
      )}
      <div className="board-hint">drag to pan · drag a card by its head</div>
      <div className="board-orb">
        <div className="bub">{bubble}</div>
        <span className="board-orb-glow">
          <DotOrb state={orb} />
        </span>
      </div>
    </div>
  );
}
