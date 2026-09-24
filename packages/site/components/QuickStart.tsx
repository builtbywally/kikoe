"use client";

import { useEffect, useState } from "react";
import { CopyButton } from "./CopyButton";

// From nothing to talking to Kik, as the README and Settings → Start here do
// it. Three tracks; each step can be ticked off, and the ticks are kept in
// this browser so a visitor can come back to where they were.

interface Step {
  id: string;
  h: string;
  p: React.ReactNode;
  cmd?: string;
  say?: string[];
}

const TRACKS: { id: string; name: string; blurb: string; steps: Step[] }[] = [
  {
    id: "source",
    name: "Run from source",
    blurb: "About ten minutes, most of it pnpm install.",
    steps: [
      {
        id: "need",
        h: "Check what you need",
        p: (
          <>
            Windows 10 or 11, Node 20 or newer, pnpm 10, and Claude Code installed and signed in.
            Kikoe runs on your Claude subscription through Claude Code; there is no API key to set.
          </>
        ),
        cmd: "node -v\ncorepack enable && pnpm -v\nclaude --version",
      },
      {
        id: "clone",
        h: "Clone and install",
        p: "The workspace installs the app, the daemon and the ear's native modules.",
        cmd: "git clone https://github.com/builtbywally/kikoe.git\ncd kikoe\npnpm install",
      },
      {
        id: "run",
        h: "Launch the app",
        p: "Builds the packages, then opens the Room. The island appears at the top of the screen.",
        cmd: "pnpm app",
      },
      {
        id: "start",
        h: "Settings → Start here",
        p: (
          <>
            Connect Claude Code (it installs the hooks), pick a voice (Piper is bundled and speaks
            at once; ElevenLabs with your key), and turn on listening. Whisper, Silero, Piper and
            Kokoro download to <code>~/.kikoe/models</code> the first time they are needed.
          </>
        ),
      },
      {
        id: "say",
        h: "Say something",
        p: "With a headset on, start with the name. After an exchange, the next sentence needs none.",
        say: [
          "Kik, what's it doing?",
          "Open a new Claude session in storefront and tell it to add a health check",
          "Make me a release checklist",
        ],
      },
      {
        id: "extras",
        h: "Optional: keys and the phone",
        p: (
          <>
            Plain files in <code>~/.kikoe/</code>, never printed or logged: <code>jev_key.txt</code>{" "}
            lets Kik know it was addressed without the name, <code>elevenlabs_key.txt</code> for
            that voice. For the phone, switch on Settings → Phone and open the link.
          </>
        ),
      },
    ],
  },
  {
    id: "installer",
    name: "Build the installer",
    blurb: "A Windows installer you can run silently.",
    steps: [
      {
        id: "build",
        h: "Build outside the repo, with pnpm",
        p: "A watcher on out/ locks it, so the output goes beside the repo. Never npx: it resolves as npm and silently drops the ear's native modules.",
        cmd: "cd packages/app\npnpm exec electron-builder --config.directories.output=../../../kikoe-dist",
      },
      {
        id: "check",
        h: "Check the ear made it in",
        p: "The unpacked app must list audify, sherpa-onnx-node and sherpa-onnx-win-x64.",
        cmd: "ls ../../../kikoe-dist/win-unpacked/resources/app/node_modules | grep -E 'audify|sherpa'",
      },
      {
        id: "install",
        h: "Install silently",
        p: "Stop a running Kikoe first; one daemon owns port 4570.",
        cmd: "taskkill //IM kikoe.exe //F\n../../../kikoe-dist/kikoe-0.1.0-win-x64.exe /S",
      },
      {
        id: "state",
        h: "Check it is listening",
        p: "/state is the whole picture; mic.phase should say listening.",
        cmd: 'TOKEN=$(cat ~/.kikoe/daemon_token.txt)\ncurl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4570/state',
      },
    ],
  },
  {
    id: "hack",
    name: "Hack on it",
    blurb: "The loop every change goes through.",
    steps: [
      {
        id: "checks",
        h: "Tests, lint, types",
        p: "The tests never touch your real ~/.claude or the OS voice.",
        cmd: "pnpm test\npnpm lint\npnpm typecheck",
      },
      {
        id: "type",
        h: "Type to Kik without a mic",
        p: "The daemon takes a sentence as if you had said it.",
        cmd: 'curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\\n  -d \'{"text":"make me a checklist for the release"}\' http://127.0.0.1:4570/say',
      },
      {
        id: "speak",
        h: "Make it speak from a script",
        p: "The CLI pushes a line to the running app, as the agent's own.",
        cmd: 'node packages/cli/dist/bin.js speak "The build is green."',
      },
      {
        id: "site",
        h: "Run this site",
        p: "It lives in packages/site: Next.js, exported as static files.",
        cmd: "pnpm --filter @kikoe/site dev",
      },
    ],
  },
];

const KEY = "kikoe-quickstart";

export function QuickStart() {
  const [track, setTrack] = useState("source");
  const [done, setDone] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      if (saved && typeof saved === "object") setDone(saved);
    } catch {}
  }, []);

  function tick(id: string, on: boolean) {
    setDone((d) => {
      const next = { ...d, [id]: on };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  const t = TRACKS.find((x) => x.id === track) ?? TRACKS[0]!;
  const count = t.steps.filter((s) => done[`${t.id}.${s.id}`]).length;

  return (
    <div className="qs">
      <div className="qs-tabs" role="tablist" aria-label="Quick start">
        {TRACKS.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            id={`qs-tab-${x.id}`}
            aria-selected={x.id === track}
            aria-controls="qs-panel"
            className={x.id === track ? "on" : undefined}
            onClick={() => setTrack(x.id)}
          >
            {x.name}
          </button>
        ))}
      </div>
      <div className="qs-progress" aria-live="polite">
        <span>{t.blurb}</span>
        <span className="qs-count">
          {count} of {t.steps.length} done
        </span>
        <span className="qs-bar">
          <i style={{ transform: `scaleX(${count / t.steps.length})` }} />
        </span>
      </div>
      <ol className="qs-steps" id="qs-panel" role="tabpanel" aria-labelledby={`qs-tab-${t.id}`}>
        {t.steps.map((s, i) => {
          const id = `${t.id}.${s.id}`;
          return (
            <li key={id} className={done[id] ? "done" : undefined}>
              <label className="qs-check">
                <input
                  id={`qs-${id}`}
                  type="checkbox"
                  checked={Boolean(done[id])}
                  onChange={(e) => tick(id, e.target.checked)}
                />
                <span className="qs-n">{i + 1}</span>
              </label>
              <div className="qs-body">
                <h3>{s.h}</h3>
                <p>{s.p}</p>
                {s.cmd && (
                  <div className="term">
                    <div className="bar">
                      <span>bash</span>
                      <CopyButton text={s.cmd} />
                    </div>
                    <pre>
                      {s.cmd.split("\n").map((line) => (
                        <span key={line}>
                          <span className="p">{line.startsWith(" ") ? "  " : "$ "}</span>
                          {line.trimStart()}
                          {"\n"}
                        </span>
                      ))}
                    </pre>
                  </div>
                )}
                {s.say && (
                  <ul className="qs-say">
                    {s.say.map((x) => (
                      <li key={x}>“{x}”</li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
