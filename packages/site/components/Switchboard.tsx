"use client";

import { sleep, useReducedMotion } from "@/lib/hooks";
import { type Decision, decide } from "@/lib/router";
import { useEffect, useRef, useState } from "react";
import { useSound } from "./Sound";

// Say a sentence and watch it go: the ear, whether it was for Kik, a reflex,
// the switchboard, and who does it. Decided in the browser by lib/router.ts.

interface Preset {
  s: string;
  p?: number;
  reply?: string;
  permission?: boolean;
}

const PRESETS: Preset[] = [
  {
    s: "Kik, what's it doing?",
    reply: "Halfway through the token refresh. Two files changed, tests not run yet.",
  },
  { s: "Open a new Claude session in storefront and tell it to do one, two, three, four" },
  { s: "Tell it to add a retry to the token refresh" },
  { s: "Yes", permission: true },
  { s: "Think this through: SQLite or a JSON file per project?" },
  { s: "Draw the retry flow" },
  { s: "Open marine in VS Code" },
  { s: "Open YouTube here" },
  { s: "Switch to storefront" },
  { s: "Yeah mum, down in five", p: 0.04 },
  { s: "And did it work?", p: 0.82, reply: "Mostly. Sixteen green, one still red in auth." },
  { s: "Stop" },
];

type NodeKey = "ear" | "addr" | "reflex" | "jev" | "dest";
type NodeState = "" | "active" | "done" | "skip" | "stop";
const NODES: { k: NodeKey; dot: string; t: string; d: string }[] = [
  { k: "ear", dot: "ear", t: "The ear", d: "Silero + Whisper, on the PC" },
  { k: "addr", dot: "for?", t: "For Kik?", d: "the name, or Jev ~0.3 s" },
  { k: "reflex", dot: "⚡", t: "A reflex?", d: "stop · quiet · yes · no" },
  { k: "jev", dot: "jev", t: "The switchboard", d: "Jev, one call ~0.4 s" },
  { k: "dest", dot: "→", t: "Who does it", d: "Kik, a session, the PC, the canvas" },
];
const AT: Record<NodeKey, number> = { ear: 10, addr: 30, reflex: 50, jev: 70, dest: 90 };
const BLANK = { ear: "", addr: "", reflex: "", jev: "", dest: "" } as const;

const DEST: Record<string, string> = {
  kik: "kik · talking",
  think: "kik · thinking",
  agent: "agent",
  new_session: "new session",
  open: "the PC",
  canvas: "the canvas",
  switch: "the Room",
};

function outcome(d: Decision, reply?: string) {
  const proj = d.project ?? "storefront";
  if (d.dest === "reflex") {
    if (d.reflex === "allow")
      return {
        tag: "reflex · instant",
        h: "The permission is answered: allowed.",
        p: "The agent's prompt gets its answer. No model sits in between.",
        k: "Allowed.",
      };
    if (d.reflex === "deny")
      return {
        tag: "reflex · instant",
        h: "The permission is answered: denied.",
        p: "The agent is told no, and carries on without it.",
        k: "Told it no.",
      };
    if (d.reflex === "stop the agent")
      return {
        tag: "reflex · instant",
        h: "The agent is stopped.",
        p: "Its turn ends now. Never sent to a model.",
        k: "Stopped it.",
      };
    return {
      tag: "reflex · instant",
      h: "Kik goes quiet.",
      p: "Mid-word if need be. A reflex, never sent to a model.",
      k: "",
    };
  }
  if (d.dest === "drop")
    return {
      tag: "not for Kik",
      h: "Dropped whole.",
      p: `Not logged, not listed, not streamed. Only the word count, ${d.words}, survives.`,
      k: "",
    };
  switch (d.dest) {
    case "think":
      return {
        tag: "kik · thinking · ~25 s",
        h: "Handed to a thinking session.",
        p: "Opus with extended thinking, in the background. You keep talking; the detail goes on the canvas.",
        k: "Thinking on it. I'll put the detail on the board.",
      };
    case "new_session":
      return {
        tag: `agent · ${proj} · new`,
        h: `A fresh Claude Code session in ${proj}.`,
        p: `Started in the project folder with exactly the job you said${d.job ? `: “${d.job}”.` : "."}`,
        k: `Started one in ${proj}.`,
      };
    case "agent":
      return {
        tag: `agent · ${proj}`,
        h: d.busy ? "Queued for the end of its turn." : "Straight to the agent.",
        p: `Your own words, cut from the sentence${d.job ? `: “${d.job}”` : ""}. ${d.busy ? "The agent is mid-turn, so it waits." : "The agent is idle, so it goes now."}`,
        k: d.busy ? "It's busy. I'll hand it over when it stops." : "Told it.",
      };
    case "open":
      return {
        tag: `the PC · ${d.open}`,
        h: "Opened on the PC, from a fixed menu.",
        p: "Editor, folder, terminal, browser or a website. The model picks from the menu; it never writes the command.",
        k: "Opening it.",
      };
    case "canvas":
      return d.open === "web card"
        ? {
            tag: "the canvas",
            h: "A live web card on the canvas.",
            p: "The site opens inside the board, beside the work.",
            k: "It's on the board.",
          }
        : {
            tag: "the canvas",
            h: "A card on the canvas.",
            p: "Pages, diagrams and checklists, made for this board.",
            k: "It's on the board.",
          };
    case "switch":
      return {
        tag: "the Room",
        h: `The whole Room moves to ${d.project ?? "that project"}'s board.`,
        p: "One board per project; switching brings its cards, agent and history.",
        k: `Here's ${d.project ?? "it"}.`,
      };
    default:
      return {
        tag: "kik · talking · first word 0.5–1.7 s",
        h: "Kik answers from the live picture.",
        p: "Haiku, one process kept warm. One sentence, then quiet.",
        k: reply ?? "Answered in a sentence, from what the agents are doing right now.",
      };
  }
}

function Bar({ p }: { p: number }) {
  return (
    <>
      <span className="bar" style={{ width: Math.round(p * 90) }} />
      {p.toFixed(2)}
    </>
  );
}

export function Switchboard() {
  const { speak } = useSound();
  const reduced = useReducedMotion();
  const [jev, setJev] = useState(true);
  const [busy, setBusy] = useState(true);
  const [permission, setPermission] = useState(false);
  const [chosen, setChosen] = useState<string | null>(PRESETS[1]!.s);
  const [text, setText] = useState("");
  const [nodes, setNodes] = useState<Record<NodeKey, NodeState>>({ ...BLANK });
  const [values, setValues] = useState<Record<NodeKey, string>>({ ...BLANK });
  const [spark, setSpark] = useState<number | null>(null);
  const [done, setDone] = useState<{ d: Decision; reply?: string; clock: number } | null>(null);
  const runId = useRef(0);

  async function run(
    sentence: string,
    preset: Preset = {} as Preset,
    ctx = { jev, busy, permission },
  ) {
    const id = ++runId.current;
    const d = decide(sentence, ctx, preset.p);
    const T = reduced ? 0 : 1;
    const ns: Record<NodeKey, NodeState> = { ...BLANK };
    const vs: Record<NodeKey, string> = { ...BLANK };
    const paint = () => {
      setNodes({ ...ns });
      setValues({ ...vs });
    };
    paint();
    setDone(null);
    const step = async (k: NodeKey, label: string, ms: number) => {
      if (id !== runId.current) throw new Error("superseded");
      setSpark(AT[k]);
      ns[k] = "active";
      paint();
      await sleep(ms * T);
      if (id !== runId.current) throw new Error("superseded");
      ns[k] = "done";
      vs[k] = label;
      paint();
    };
    let clock = 0;
    try {
      await step("ear", `“${d.words} words”`, 500);
      if (d.dest === "reflex") {
        await step("addr", "the name, or a reflex", 250);
        await step("reflex", "yes · at once", 300);
        ns.jev = "skip";
        vs.jev = "never reached";
        await step("dest", "code", 200);
      } else {
        clock += d.named ? 0 : 0.3;
        const addr = d.named
          ? "the name · 1.00"
          : d.jev
            ? `Jev · ${d.addr.toFixed(2)}`
            : d.addr
              ? "rules · yes"
              : "rules · no";
        await step("addr", addr, d.named ? 250 : 700);
        if (d.dest === "drop") {
          ns.reflex = "skip";
          ns.jev = "skip";
          ns.dest = "stop";
          vs.dest = "dropped whole";
          paint();
        } else {
          await step("reflex", "no", 200);
          clock += d.jev ? 0.4 : 0;
          await step(
            "jev",
            d.jev && d.conf != null ? `${d.dest} · ${d.conf.toFixed(2)}` : "rulebook",
            d.jev ? 800 : 300,
          );
          await step("dest", DEST[d.dest] ?? d.dest, 400);
        }
      }
      setSpark(null);
      setDone({ d, clock, ...(preset.reply ? { reply: preset.reply } : {}) });
      const k = outcome(d, preset.reply).k;
      if (k) speak(k);
    } catch {
      // a newer sentence took over
    }
  }

  // open on a real example, so the panel is never empty
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  useEffect(() => {
    run(PRESETS[1]!.s);
  }, []);

  const o = done ? outcome(done.d, done.reply) : null;
  const d = done?.d;

  return (
    <div className="sim">
      <div className="sim-top">
        <div className="chips">
          {PRESETS.map((p) => (
            <button
              key={p.s}
              type="button"
              className={chosen === p.s ? "chip on" : "chip"}
              onClick={() => {
                setChosen(p.s);
                const ctx = { jev, busy, permission: permission || Boolean(p.permission) };
                if (p.permission) setPermission(true);
                run(p.s, p, ctx);
              }}
            >
              {p.s}
            </button>
          ))}
        </div>
        <form
          className="say-form"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            const v = text.trim();
            if (!v) return;
            setChosen(null);
            run(
              v,
              PRESETS.find((p) => p.s.toLowerCase() === v.toLowerCase()),
            );
          }}
        >
          <input
            id="say-input"
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Or type anything, e.g. “tell it to add a retry to the token refresh”"
            aria-label="A sentence to say to Kik"
          />
          <button className="pill-btn solid" type="submit">
            Say it
          </button>
        </form>
        <div className="toggles">
          <label className="switch">
            <input
              id="jev-on"
              type="checkbox"
              checked={jev}
              onChange={(e) => setJev(e.target.checked)}
            />{" "}
            Jev key
          </label>
          <label className="switch">
            <input
              id="busy-on"
              type="checkbox"
              checked={busy}
              onChange={(e) => setBusy(e.target.checked)}
            />{" "}
            agent is mid-turn
          </label>
          <label className="switch">
            <input
              id="perm-on"
              type="checkbox"
              checked={permission}
              onChange={(e) => setPermission(e.target.checked)}
            />{" "}
            a permission is waiting
          </label>
        </div>
      </div>

      <div className="pipe">
        <div
          className="spark"
          style={{ left: `calc(${spark ?? 10}% - 5px)`, opacity: spark == null ? 0 : 1 }}
        />
        {NODES.map((n) => (
          <div key={n.k} className={`node ${nodes[n.k]}`}>
            <div className="dot">{n.dot}</div>
            <div className="t">{n.t}</div>
            <div className="d">{n.d}</div>
            <div className="v">{values[n.k]}</div>
          </div>
        ))}
      </div>

      <div className="outcome">
        <div className="readout" aria-live="polite">
          {d && (
            <>
              <div>
                <span className="k">heard</span>“{d.text}”
              </div>
              {d.dest === "reflex" ? (
                <>
                  <div>
                    <span className="k">reflex</span>
                    {d.reflex}
                  </div>
                  <div>
                    <span className="k">model</span>none. Code answers it.
                  </div>
                </>
              ) : d.dest === "drop" ? (
                <>
                  <div>
                    <span className="k">for kik</span>
                    {d.jev ? <Bar p={d.addr} /> : "no (no name, rules)"}
                  </div>
                  <div>
                    <span className="k">kept</span>word count: {d.words}
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <span className="k">for kik</span>
                    {d.named ? "the name" : d.jev ? <Bar p={d.addr} /> : "rules: yes"}
                  </div>
                  <div>
                    <span className="k">what</span>
                    {d.dest} {d.conf != null && <Bar p={d.conf} />}
                  </div>
                  <div>
                    <span className="k">job</span>
                    {d.job ? `“${d.job}”` : "—"}
                  </div>
                  <div>
                    <span className="k">open</span>
                    {d.open ?? "—"}
                  </div>
                  <div>
                    <span className="k">project</span>
                    {d.project ?? "—"}
                  </div>
                  {d.jev && (
                    <div>
                      <span className="k">time</span>~{done.clock.toFixed(1)} s to decide
                    </div>
                  )}
                </>
              )}
              <div className="src">
                {d.jev
                  ? "Jev's answers, simulated in your browser. The real one runs through TypeSafe."
                  : "Jev off: the regex rulebook decides. Kik still hears, answers and starts agents."}
              </div>
            </>
          )}
        </div>
        <div className="result" aria-live="polite">
          {o ? (
            <>
              <div className="dest-tag">{o.tag}</div>
              <h3>{o.h}</h3>
              <p>{o.p}</p>
              {o.k && <div className="kline">{o.k}</div>}
            </>
          ) : (
            <p className="fine">routing…</p>
          )}
        </div>
      </div>
    </div>
  );
}
