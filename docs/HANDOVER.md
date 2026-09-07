# Kikoe handover

Read this first in a new session. It is everything the last session knew
that the code does not say by itself. Written 2026-09-06, commit `5f087c2`.

## What Kikoe is

The room you run your coding agents from by voice. One Electron window on
Windows (installers also build for macOS and Linux in CI), an ear, a voice,
a mind, and a canvas. The user is a solo builder (GitHub `builtbywally`)
who wants a voice-first "ADE": talk to Kik, the agents do the work, the
canvas shows what words can't carry. Nickname for the assistant: **Kik**.

Repo: `~/orca/projects/kikoe`, branch `main`, private on GitHub. The old
Python project (ClaudeTalks) is retired; `~/orca/projects/ClaudeTalks` is
an empty checkout whose CLAUDE.md now points here.

## Run, build, test, install

```bash
cd ~/orca/projects/kikoe
pnpm install                     # pnpm 10; audify/electron builds allowed in pnpm-workspace.yaml
pnpm build                       # tsc -b for core, daemon, cli, app
pnpm test                        # vitest, 133 tests; never touches ~/.claude or the speaker
pnpm lint                        # biome; it also reformats after edits
pnpm typecheck
pnpm app                         # build + run from source (kills nothing; the installed app holds the port)
pnpm app:dist                    # NSIS installer -> out/app/kikoe-0.1.0-win-x64.exe (~3 min)
./out/app/kikoe-0.1.0-win-x64.exe /S     # silent reinstall; it relaunches itself
```

Only one daemon can own port 4570. Before running from source, kill the
installed app: `taskkill //IM kikoe.exe //F` (Git Bash) or Stop-Process
in PowerShell. Dev instances are `electron.exe`.

Useful while developing:

```bash
TOKEN=$(cat ~/.kikoe/daemon_token.txt)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4570/state | python -m json.tool
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"make me a checklist for the release"}' http://127.0.0.1:4570/say   # type to Kik
curl -s -K ~/.kikoe/speak.curlrc --data-binary "a line to say"                    # speak
grep -E "heard|brain tool|brain failed|follow-up" ~/.kikoe/logs/daemon.log | tail
```

The browser Room for a second screen or DevTools:
`http://127.0.0.1:4570/room/?token=<daemon_token>`. The chrome-devtools
MCP was used to inspect it; computed styles and console errors show there.
`npx electron . --screenshot out.png --enable-logging=stderr` (from
`packages/app`, dev app stopped) writes `out.png` and `out-settings.png`
with staged pins, and prints renderer console errors.

## Where things live

```
packages/core      pure logic: events, narrator, arbiter, tracker, router (name gate,
                   control words, you-questions), head (rulebook), diagram DSL -> SVG
packages/daemon    the HTTP daemon: hooks, TTS ladder, speaker, board (pins.ts),
                   brain.ts (Claude in the head), models, config, hooks installer
packages/cli       `kikoe speak`, `kikoe show`
packages/app       Electron: main.ts (daemon in main process, tray, windows, IPC),
                   mic.ts (utility process: audify -> Silero VAD -> Whisper -> /heard),
                   renderer/room (the one window: room.js, board.js, settings.js,
                   room-web.js shim for the browser), renderer/island (the pill),
                   renderer/backdrops (4K jpgs), renderer/fonts
brand/             orb.svg (the logo), backdrops.py (regenerates the backdrops)
docs/              PLAN, APP, ROOM-PLAN (running log of the Room), VOICE, ROADMAP, this
.github/workflows  test (3 OS), app (installers + smoke + screenshot), cold, release
```

User data: `~/.kikoe/` — `config.local.json` (settings), `daemon_token.txt`,
`viewer_token.txt`, `hook.curlrc` / `speak.curlrc` / `show.curlrc`,
`elevenlabs_key.txt` + `.enc`, `anthropic_key.txt` + `.enc` (never print),
`board.json` (sticky pins), `conversation.jsonl`, `memory.md` (Kik's notes),
`inner.md` (Kik's private inner note, rewritten after each exchange),
`presence.json` (when the user was last here and last greeted),
`journal.md` + `journal.json` (earlier days, one to three lines each,
thirty days kept; the mark says how far the conversation was journaled),
`models/` (Piper, Kokoro, Whisper base, Silero VAD), `logs/daemon.log`,
`metrics.jsonl`.

Claude Code side: `~/.claude/settings.json` carries Kikoe's curl hooks (16
events, "full" profile) and `outputStyle: "Kikoe Voice"`;
`~/.claude/output-styles/kikoe.md` and `~/.claude/skills/speak/SKILL.md`
are installed by the app with the marker `<!-- installed by kikoe -->`.

## How it works, end to end

1. Claude Code hook -> `POST /hook/claude` -> adapter -> event -> tracker +
   narrator -> arbiter -> TTS ladder (ElevenLabs Sarah > Piper > Kokoro >
   system) -> speaker. PermissionRequest hooks are held open until a spoken
   or clicked answer. A Stop hook can carry a queued voice instruction back
   to the agent (`decision: block` with the instruction as the reason).
2. The ear (`mic.ts`) posts phases to `/mic` and transcripts to `/heard`.
   `daemon.hearSegment()` merges half sentences; `hear()` routes: name or
   alias ("kik", and what Whisper makes of it) -> addressed; a sentence to
   "you" -> addressed; a follow-up within 20 s of an exchange -> addressed;
   anything else is judged by the model (`Brain.directed`) when
   `hear_you` is on; reflexes (stop, quiet, yes, no) never touch the model.
3. Addressed speech that is not a reflex goes to `Brain.reply` with
   `brainSystem()` (persona + live picture + canvas + memory) and
   `brainTools()`. Clauses stream to the voice; a final `Next: a | b`
   line becomes suggestion chips. Tools: approve, deny, answer_board,
   instruct_agent, create_artifact, update_artifact, read_board,
   remove_artifact, point_at, ask_user, remember, forget, set_mode,
   clear_board, pin_note. Every html artifact gets the artboard kit
   (`daemon/src/kit.ts`) inlined once: the Room's tokens, good defaults
   for bare elements, and classes for product UI; the tool description
   tells the model the classes. The frame is opaque-origin under the
   Room's CSP, so nothing external loads; the kit is the offline floor.
   The real runtime (`daemon/src/runtime.ts`): a page or react artifact
   is served by the daemon at `GET /artifact/<id>` (no token; the id is
   the key and opens one page only) with its own CSP allowing cdnjs,
   jsdelivr, unpkg and Tailwind's CDN; the Room frames that URL. Kind
   `react` is a component file: imports become globals (React, ReactDOM,
   LucideReact, Recharts), `export default` is the root, Babel compiles
   the JSX in the frame, Tailwind is the play CDN. `design_artifact`
   takes a brief and asks `artifact_model` (Sonnet 5 by default, a
   setting) with `DESIGN_BRIEF`; Kik is told to use it for any page, app
   or comparison instead of writing html itself. The tool speaks the wait
   itself ("give me a minute or two", "still on it" at 75 s) and `quick:
   true` sketches on `brain_model` (Haiku) in about twenty seconds with
   a shorter brief. `docs/EVAL-MODELS.md` has the Sonnet vs Haiku numbers
   behind those choices; `pnpm eval:models` reruns them. Needs the network;
   offline, the kit-html path still works. Pin kind `web` is a live iframe (localhost app,
   site, or a search engine as a browser); the Room strips X-Frame-Options
   and frame-ancestors for subframes so sites show.
   Between utterances Kik keeps an inner note (`reflectNow()`, five
   seconds after an exchange, ending or error, at most every thirty):
   what it thinks is going on, what it expects, what it meant to say. The
   note goes into the system prompt and the minute check-in compares the
   picture against it. The first thing the user says after an hour away
   is a return: a hello inside the reply if addressed, a hello of its own
   if overheard (only the gap is used, never the words). If the model's
   first clause takes over 1.5 s, Kik says "hm" or "one sec" first.
   Once an hour (`consolidateMaybe()`), every day of conversation before
   today that is not yet in the journal is summarised by the model into
   dated lines in `journal.md`; the last 3000 characters go into the
   system prompt. Facts the user states still go to `memory.md` through
   the remember tool; the journal is what happened.
   Once a minute `watch()` runs cheap rules over the picture: an agent
   waiting three minutes, tests red thirty, the same error three times;
   each concern is said once (the model phrases it if there is a key) and
   published as a `concern` frame. `register()` adds a never-spoken line
   of tone to the prompt (late night, a bad hour, a turn to green, a wait).
   The name gate also takes any word shaped like the name (`nameLike` in
   `router.ts`) so a new Whisper spelling still lands. Talking to Kik
   while it speaks interrupts it, through speakers too (`hear()`, after
   the echo check). A correction ("no", "that's wrong", "I said") sets a
   flag the next prompt reads: take it, fix the notes, don't repeat.
   The goal all of this serves is `docs/SENTIENCE.md`.
4. The Room renders the daemon's `/stream` frames: `pin`, `heard`, `mic`,
   `speech`, `sessions`, `event`, `focus`, `suggest`, `look`. The board is a
   pan/zoom canvas (`board.js`): frames per repo, cards placed in columns,
   dragged cards remembered, `near` cards placed beside their host, `w/h`
   from the corner grip. Synthetic cards (conversation, agents, events) are
   built in `room.js`, not stored. `render()` keeps a card whose content
   signature has not changed (so a live frame never reloads on the
   15-second age tick) and `settle()` pushes auto-placed cards down until
   nothing overlaps, wide cards and grown cards included; dragged cards
   and stickies stay put. Web and page cards have phone, tablet and
   desktop viewport buttons in the footer that set the card's size.

## The work feed (2026-09-07)

The canvas used to hold only what Kik *made*. Now it also holds what the
agent *did*: a diff per file it edited, a run card for a command that
matters, a result card for a test run, and the turn's reply in full. This
is the first slice of using Kikoe as the ADE rather than as a voice beside
a terminal.

- **The data was already arriving and was being thrown away.** Claude Code
  POSTs the whole hook payload, and a PostToolUse for an Edit carries
  `structuredPatch` — a finished unified diff. `asText()` returns the first
  of `text/content/output/stdout/result/message`, an Edit response has none
  of them, so it returned `""`. `stderr` was never read at all.
  `core/src/adapters/claude-code.ts` now has `toolResult()` beside
  `asText()`: the same response projected rather than flattened, onto a new
  `AgentEvent.result`. **Do not "fix" `asText` instead** — it feeds the
  narrator and, through the tracker, the brain's prompt, so widening it
  would start speaking diffs and put file bodies in the system prompt.
  `packages/core/test/tool-result.test.ts` keeps that as a test.
- **Two budgets, one canvas.** `Pin` gained `stream: "board" | "work"` and
  `turn`. `board` is the whiteboard it always was (`MAX_PINS = 24`, TTL,
  oldest-of-the-crowded-repo). `work` is per session (`MAX_WORK = 40`),
  has no TTL, and is evicted by whole turns, oldest first. `evict()` only
  ever looks at board pins, so a busy turn can never take down an artifact
  Kik made; `evictWork()` never touches the whiteboard. Both directions
  have a test.
- **`daemon/src/work.ts`** turns events into cards. A turn's cards share
  `near`, so the canvas groups them with placement it already had. Editing
  one file five times is **one card that grows**, not five — without that a
  single refactor buries the board. Not every command earns a card: a
  failure always does, and so does work with a result (tests, build,
  install, commit, deploy); `ls` and `cat` never do.
- **It runs after the hook is answered.** `ingest()` ends with
  `queueMicrotask(() => this.work.ingest(e))`. Hooks are subprocesses in
  front of the agent with a three second budget; nothing here is worth a
  stall.
- Work cards do not persist yet — `toJSON()` excludes them. Per-project
  boards and positions are the next slice.
- `renderDiff` used to strip `@@` along with the file header. It now draws
  a rule reading "line 118" instead: without it you cannot tell a change at
  line 20 from the same change at line 900, and multi-hunk diffs ran
  together.

## The artifact runtime, actually running real artifacts (2026-09-07)

Two bugs that made any ordinary artifact fail, found by pasting one in:

- **Every artifact opens `import React, { useState } from "react"`.** The
  runtime pre-destructures the hooks, so rewriting that import produced a
  second `const { useState } = React` in the same scope — a SyntaxError
  that blanked the card. `PRE_DECLARED` in `runtime.ts` now drops names the
  page already declares. The existing test used that very import line and
  never checked for it.
- **lucide's UMD reads `window.react`, lower case**; React's UMD only ever
  defines `window.React`. So every artifact with an icon died on "cannot
  read forwardRef of undefined". A one-line alias is emitted before the
  bundles that need it.

Verified by serving a component that uses hooks, a lucide icon, a Recharts
chart and Tailwind, and looking at it in Chrome: it renders and the button
works.

## Settings that matter (config.local.json)

`tts`, `narrate`, `hook_profile`, `mic` + `mic_device` ("HyperX Cloud
Flight": the desk mic M8 hears the room), `wake_name` ("kik"),
`stt_model` ("base"), `hear_debug` (ON right now for tuning; it keeps the
text of everything heard; turn off when the name lands reliably),
`hear_you` (true), `barge_in` (true, headset only), `brain` (true),
`brain_model` (Haiku 4.5; Sonnet 5 option), `brain_provider` ("openrouter"
on this machine since 2026-09-07: the Anthropic account ran out of credit
and Kik was the rulebook for a day; OpenRouter serves the same Messages
API, key in `~/.kikoe/openrouter_key.txt`, model names mapped in
`brain.ts` `providerModel`; measured 1.0 s to the first word for Haiku on
a Kik-sized prompt, the same as direct), `brain_narrates`,
`brain_checkin`, `brain_greets` (hello after an hour away),
`artifact_model` (Sonnet 5: designs pages), `usage` (true: the limit rings
on the pill), `usage_off` (provider ids never read), `backdrop`
("aurora"), `backdrop_dim`, `backdrop_blur`,
`backdrop_image`, `start_at_login`, `theme`.

## The usage rings (2026-09-07)

The right-hand end of the pill carries one ring per coding assistant: how
much of its limit is gone, the number beside it, and a card on hover with
every limit window and when it resets. The idea and the drawing are
[Codenotch](https://github.com/vinzdg/codenotch)'s — a macOS notch that
pins the same reading to a screen edge — and the user asked for both.

- `daemon/src/usage.ts` is the whole engine. `ClaudeUsageProvider` reads
  the OAuth token from `<claude dir>/.credentials.json` (`claudeAiOauth`,
  never logged) and GETs `https://api.anthropic.com/api/oauth/usage` with
  `anthropic-beta: oauth-2025-04-20` — the same endpoint Claude Code's own
  `/usage` reads, so the two never disagree. `OpenCodeUsageProvider` uses
  the `opencode-go` key from `~/.local/share/opencode/auth.json`.
- Kikoe **never signs in anywhere**. Every reading is borrowed from a
  credential a tool on this machine already holds. Switching a provider
  off in Settings → Limits stops it being read at all; it does not sign
  you out of the tool that owns the account.
- Failures degrade to a visible status, never a number: no reading is a
  dash, an old reading is dimmed with its age and the reason, and "0%" is
  never shown for something that was not read. This is the one rule worth
  defending if the code is ever refactored.
- An expired token is not a sign-out. Claude Code rotates it whenever it
  runs and Kikoe deliberately does not, so after a restart it is often
  stale until Claude Code is next used.
- 429 backs off 60s, doubling to 15 min. The endpoint answers
  `Retry-After: 0`, which is honoured only as a floor-raiser.
- Polling follows the work: a minute while an agent is running, five when
  nothing is, plus one poll four seconds after any turn ends. Last-good
  readings live in `~/.kikoe/usage.json` so a fresh start draws numbers
  rather than empty circles.
- Multiple accounts: `~/.claude` first, then every `~/.claude-<slug>` that
  Claude Code has actually used, alphabetically, each its own ring.
- The inner thin arc is *activity*, not usage — spinning while an agent
  works, pulsing while one waits on you. It comes from Kikoe's own tracker,
  so it stays live even when the percentage has gone stale. Hooks carry no
  profile, so it is attributed to the default Claude ring only.
- Kik knows the numbers: `brainSystem()` carries `usage.brief()`, so "how
  much have I got left?" is answered from the live picture, not a tool call.
- Codenotch's thresholds (half, seven tenths) are kept; its traffic light
  is not. `island.css` says "ember as the one accent. No green.", so the
  bands are paper, amber, ember. The user chose that explicitly.
- `KIKOE_USAGE=off` (set in `vitest.config.ts`) yields no providers, so no
  test can ever read a real credential or call a vendor.
- `npx electron . --screenshot out.png` now also writes `out-island.png`,
  with the first ring's card pinned open — the harness stubs
  `hideUsageCard` because the real pointer keeps closing a staged hover.

## Decisions already made (don't relitigate)

- One window. Control Room and Settings are views inside the Room.
- The canvas is always on and is how Kik communicates, not a side panel.
- Recall over precision for addressing: a false "yes" costs one answer, a
  false "no" costs trust. Shared-room mode is a setting, not the default.
- Unaddressed speech is dropped whole: no text in logs, lists or streams,
  only a word count (`hear_debug` is the one exception and says so).
- Permissions stay stock-phrased and instant; the model never sits between
  a permission and its answer.
- The rulebook remains the floor: everything works without a key.
- No PTY wrapper, ever. Hooks in, hooks out.
- Tests must never touch the real `~/.claude` (`KIKOE_CLAUDE_DIR`) nor the
  OS voice (`tts: "none"`).

## Gotchas that cost hours

- **Anchor-patch scripts**: the last session patched files with Python
  scripts that search for an anchor and insert. Re-running one re-inserts
  every block whose anchor survives (duplicate methods, duplicate fields).
  Check `new in s` before `old in s`, or `git checkout` the file and run
  once. Biome reformats long lines, so anchors drift; grep the formatted
  text first.
- Bash heredocs and `sed` mangle backslashes on this box; write `.py` patch
  files with the Write tool and run them. Python `re.sub` turns `\b` into a
  backspace.
- `board.js` sets the dot grid's `background-size` inline with the zoom;
  the backdrop rule needs `!important`. `background-attachment: fixed`
  breaks under the composited canvas; don't use it.
- Electron forbids external ArrayBuffers: `vad.front(false)`.
- GNU tar from Git Bash fails on `.tar.bz2` inside Electron; models are
  unpacked with `System32\tar.exe` on Windows.
- The NSIS install lands in `%LOCALAPPDATA%\Programs\@kikoeapp` (the
  package name); `extraMetadata.name` did not change it. The start-at-login
  Run key (`electron.app.kikoe`) points there.
- The ear's phase posts are serialised; do not post from the audio callback
  on separate connections again.
- The brain's conversation memory must never start on a `tool_result`
  (400 from the API); `Brain.prune()` handles it. Replies are one at a time.
- `pnpm --filter @kikoe/app build` does nothing; the app is built by the
  root `pnpm build`.
- `pnpm app:dist` can fail with EBUSY on `default_app.asar` or EPERM
  renaming `win-unpacked.tmp` when something watches the repo (Orca's
  file watcher does; Defender real-time is on). The locked directory
  stays locked. Build outside the repo instead, from `packages/app`, and
  under pnpm, never npx: `pnpm exec electron-builder
  --config.directories.output=<dir outside the repo>`. With npx,
  electron-builder resolves dependencies as npm and silently drops
  audify and sherpa-onnx from `app.asar.unpacked`; the app installs and
  speaks but the ear dies with "Cannot find module 'sherpa-onnx-node'".
  Check `resources/app.asar.unpacked/node_modules` lists audify,
  sherpa-onnx-node and sherpa-onnx-win-x64 before installing. Then run
  the installer with `/S` with the app stopped first, or it hangs.
  The Windows icon is pre-rendered (`build/icon.ico`, made with Pillow
  from icon.png) because electron-builder's WebAssembly icon tool dies
  with "could not allocate memory" when the machine is low on RAM.
- Whisper writes "kik" as "kick", "Kiko", "a cookie"; aliases live in
  `core/src/router.ts`. A real wake-word model is roadmap item 1.

## Where it stands, honestly

Works daily on this machine: hooks, narration, permissions by voice, the
canvas with artifacts by voice, memory, backdrops, resize. CI green on
three platforms; installers unsigned. Verified tonight through the
installed app: "make me a standup timer page as an artboard and annotate
it" produced a wide page, a sticky beside it, a focus, and a remembered
fact.

Known weak spots:

- The name depends on Whisper's spelling; the shape match, the follow-up
  window and the model judgement paper over it. A real wake word is still
  open: see `docs/SENTIENCE.md`, order of work, item 4, for the two routes
  (openWakeWord trained on the user's voice, or the sherpa-onnx keyword
  spotter already in the ear's runtime).
- No echo cancellation: VAD barge-in is headset-only; barge-in by words
  works through speakers but only once the sentence has been transcribed.
- Suggestion chips depend on the model ending with `Next:`; usually does.
- Batch transcription: Kik answers after the sentence ends, not during.
- The conversation card shows the last eight exchanges only; the
  Control Room shows thirty.
- ElevenLabs Agents as the hosted conversation loop was researched and
  planned (see ROOM-PLAN, "Conversation, the way the assistants do it");
  the user has not said go.

## What to do first in the new session

1. `git pull`, `pnpm install`, `pnpm test` (expect 115 green).
2. Kill the installed app, `pnpm app`, say "kik, what's on the board" with
   the headset on; read `~/.kikoe/logs/daemon.log`.
3. Check the Anthropic account has credit: from 2026-09-06 20:29 every
   model call failed with "credit balance is too low" and Kik ran on the
   rulebook for a day. Then the ear: `docs/HEARING.md` (2026-09-07) is
   the researched plan, phase 1 needs no new models and fixes the call
   that Kik joined (the "you" rule and the twenty-second window).
   Then `docs/ROADMAP.md` milestone 1. The user's own priorities, in
   their words across the last session: it should know when they're
   talking to it without the name; it should think and speak on its own;
   the canvas is how it communicates; canvas freedom; live memory.
4. Every change: tests, a screenshot, one spoken demo, commit with the
   house style (a sentence of why, a Co-Authored-By line), push, `pnpm
   app:dist`, silent reinstall, verify `/state`.

## The user's way of working

Short messages, often in caps, often while the app is running and they're
talking to it. They test by voice immediately and report what they saw.
They approve with "go ahead" and expect the whole list done, not the easy
half. They dislike being asked to confirm ordinary work. They want to hear
Kik speak at milestones: use `curl -K ~/.kikoe/speak.curlrc --data-binary
"..."` (the `speak` skill). Commit only when the work is verified; they do
not want to be asked before each commit once they've said go.
