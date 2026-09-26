# Kikoe: every flow, its gaps, and the plan

Audited 2026-09-06 at commit `2d4ea9a`, by walking the code and a day of
using it. A flow is something the user does or something that happens to
them, end to end. Each one gets: what works, what is missing, and how bad
the gap is. Then the flows that do not exist yet, and an order of work.

Severity: **breaks trust** (the user stops relying on it), **costs the
feeling** (it stops feeling like someone is there), **friction** (it
works but annoys), **later** (fine to leave).

## 1. Installing and starting

Works: NSIS installer, silent reinstall relaunches, start at login, tray,
one window, port ownership refused rather than fought, models fetched on
demand, three-OS CI with smoke and screenshot.

Gaps:
- Unsigned installers; no auto-update. **later** until ship.
- The daemon runs in the app's main process: a daemon crash is an app
  crash, and nothing restarts it. **breaks trust** once it happens.
- No log rotation: `daemon.log` grows forever (140 KB after one day is
  fine; a month is not). **later**.
- The mac plist still says the wake word is "hey Claude". **friction**.

## 2. Onboarding

Works: a welcome page with three steps (voice, Claude Code, listening),
hooks installed with a marker, output style and speak skill installed.

Gaps:
- No first-run by voice: the user reads and clicks. The roadmap's "say kik
  and you're talking" is not built. **later** until ship.
- Nothing tells a new user the canvas exists or how to talk to Kik beyond
  one line on the card. **friction**.

## 3. Hearing the agent (hooks in, voice out)

Works: sixteen hook events, adapter, tracker, narrator with modes, arbiter
with priorities, coalescing and self-spoken dedupe, ElevenLabs then Piper
then Kokoro then system, earcons, metrics, the brain phrasing milestones.

Gaps:
- Claude Code only. Codex, Gemini CLI, Aider have no adapter. **later**.
- The agent's own spoken line (via the output style) and the hook summary
  can still double up outside the thirty-second window. **friction**.

## 4. Permissions by voice

Works: the hook is held open, stock phrasing, instant; yes and no by
voice, click, or an asked pin; timeouts answer no; a second question
waits its turn behind the first (2026-09-24; it used to deny the first);
Kik's own actions ask through the same question (`askPermission`, graded
read / write / irreversible in `capability.ts`).

Gaps:
- ~~One pending permission at a time.~~ Closed 2026-09-24: a queue. A
  question in line still counts down its own timeout, so a long first
  answer can let a second expire unasked (it is denied, and Claude Code
  falls back to its own prompt). **friction**.
- No way to answer from another room or the phone. **later** (remote).

## 5. Talking to Kik (the ear)

Works: headset mic, Silero VAD, Whisper base, sentence merging, name gate
with aliases and the name by its shape, "you" sentences, a follow-up
window, Jev as judge in the gray zone (the model only when Jev is away;
2026-09-23), reflexes never touching the model, echo dropped by text,
barge-in by VAD on a headset and by words through speakers, unaddressed
speech dropped whole.

Gaps:
- **The ear can die and stay dead.** It did today for hours: the process
  exited and nothing restarted it or said so; the only sign was a word in
  `/state`. **breaks trust**, the worst gap in the product.
- No real wake word: the name still rides on Whisper's spelling. Two
  routes are written up in `SENTIENCE.md`. **costs the feeling**.
- No echo cancellation: through speakers, Kik cannot be cut off mid-word,
  only after a sentence is transcribed. **costs the feeling**.
- Batch transcription: Kik answers after you stop, never during.
  **costs the feeling**.
- `hear_debug` is on, keeping the text of everything heard. Fine while
  tuning, wrong as a default. **friction** (privacy).
- Whisper base on CPU: one to eight seconds of transcription on long
  sentences. **friction**.
- The gray-zone judge sends the nameless sentence to a cloud service (Jev
  now, Haiku before). Not new, but it is the one place overheard text
  leaves the machine to be judged. **friction** (privacy); Laya, local, is
  the answer once it is fine-tuned on the heard log.

## 6. Kik answering (the head)

Works: persona, live picture, canvas listing, memory, journal, inner
note, register, corrections, fillers while thinking, clause streaming,
Next chips, fourteen tools, rulebook fallback without a key, one reply at
a time, tool-result pruning.

Gaps:
- A voice instruction for an agent ("tell it to add a retry") is queued
  and only delivered when that agent's turn ends or the user types. If the
  agent is idle and nobody types, nothing happens and Kik has said "it's
  got it". That is exactly what happened today. **breaks trust**.
- The instruction goes to a repo by name or "the only one"; with two
  agents and no name Kik guesses. **breaks trust** with more than one.
  Narrowed 2026-09-23: Jev names the project from the sentence and asks
  "which project?" when it only half heard it; with no name it still
  guesses.
- "What number did you remember?" still goes to Kik, not the agent that
  was told it. Jev gets 9/10 on Kik-or-agent; this one is the miss, and
  the fix is telling it what only the agent's session knows. **friction**.
- Nothing on the canvas shows an instruction waiting. **friction**.
- A concern the watchers raise is spoken once and then gone; the `concern`
  frame is published but the Room does not render it. **costs the feeling**.
- A line cut off by barge-in is lost; no "as I was saying". **friction**.
- The conversation card shows eight exchanges; the Control Room thirty;
  the full history is only on disk. **friction**.

## 7. Memory and presence

Works: conversation on disk, notes by tool, a journal of earlier days,
the inner note, presence and a hello after an hour away, the register.

Gaps:
- Hooks count as presence, so a Claude Code session running in the
  background stops the hello. Right in general, wrong when the session is
  Kikoe working on itself. **friction**.
- `memory.md` is capped at 20 KB with no consolidation of the notes
  themselves, only the journal. **later**.
- The journal is written once an hour; the first exchange of a morning
  can land before it. **friction**.

## 8. The canvas as a surface

Works: pan and zoom, frames per repo, drag, resize by grip, settle so
nothing overlaps, cards kept in place so frames never reload, viewports,
stickies beside artboards, ticks and replies on pins, sticky persistence,
fit, focus and pulse, backdrops.

Gaps:
- Settle only pushes down; nothing ever moves back up, so columns grow
  gaps. There is no "tidy the board". **friction**.
- No selection, multi-select, align, connectors, drawing. **later** (M3).
- No undo, no version history: `update_artifact` overwrites. **friction**,
  will become **breaks trust** as Kik edits more.
- The renderer (`board.js`, `room.js`) has no tests at all; both layout
  bugs today shipped because nothing could catch them. **breaks trust**
  for every future change.
- Non-sticky artifacts fade after an hour, including a page Sonnet took
  two minutes to build. **friction** bordering on **breaks trust**.

## 9. Artifacts Kik makes

Works: checklist, note, markdown, table, diagram to SVG, SVG, kit-html,
react through the served runtime, web cards; the designer on Sonnet with
a design brief, quick sketches on Haiku, the wait spoken.

Gaps:
- Designed pages need the network for the CDN; offline they show an error
  in the frame. **friction**, until React and Tailwind are bundled.
- Kik cannot read what is on a page it made or framed; it knows the code,
  not the rendering. **later**.
- The web card has no address bar, back button or tabs; sites that
  frame-bust with script still escape. **friction**.
- The browser Room's viewer cannot open a served page in its own window
  (only web cards). **later**.

## 10. Settings and the doctor

Works: every setting has a control, the doctor shows mic level, engines,
hooks, latencies; the second-screen link with a viewer token.

Gaps:
- No control for the follow-up window, the away threshold, the filler
  delay, the watcher thresholds. Defaults are guesses from one user.
  **later**.
- The doctor does not say when the ear is dead in words a person would
  use. **friction**, tied to gap 5.

## 10b. The limit rings (added 2026-09-07)

Works: one ring per assistant on the pill, the number beside it, a hover
card with every window and its reset, an inner arc for whether an agent is
working or waiting, Kik answering "how much have I got left?" out loud, a
Settings page that says whose credential each reading is borrowed from and
can stop one being read at all. Claude Code (every `~/.claude-<slug>`
profile) and OpenCode's Go plan today. Parsers pinned by 23 tests; every
failure degrades to a status with a date on it.

Gaps:
- Codenotch reads Cursor, Codex, GLM, Grok and Antigravity too. None of
  those had a credential on this machine to test against, and Cursor's
  needs a SQLite read of a 200 MB `state.vscdb`. **later** — the provider
  interface is the only thing a new one has to satisfy.
- The activity arc is attributed to the default Claude profile, because a
  hook says nothing about which config directory launched it. With two
  profiles running at once the work shows on the wrong ring. **friction**.
- The rings are on the pill only. The Room — the surface you actually sit
  in front of — does not show them anywhere. **friction**.
- Nothing warns before a limit runs out. The numbers are there and the
  watcher already speaks about waits and red tests; "you're at ninety on
  the weekly" is the obvious next line and does not exist. **later**.
- No test covers the renderer, like the rest of `renderer/`. The idle
  activity arc drew a permanent quarter-arc that read as usage, and only
  the screenshot caught it. **breaks trust** for every future change.

## 11. The CLI and the show contract

Works: `kikoe speak`, `kikoe show` with kinds, asks, TTL, repo.

Gaps:
- No `kikoe say` (type to Kik from a terminal) and no `kikoe state`.
  **later**.
- The contract is documented in ROOM-PLAN, not in a public page. **later**
  (M5).

## Closed since this was written (2026-09-07)

- **The agent's work is on the canvas.** Diffs per edited file, run cards,
  test results and the turn's full reply, as a `work` stream beside the
  whiteboard. See `docs/HANDOVER.md`, "The work feed". This is most of
  flows 3 and 4 below, minus the voice verbs ("read me the diff", "apply
  hunks two and four") and the re-run button, which need the project's
  test command and so wait for per-project boards.
- **`clearBoard` was broken in the app.** The titlebar and Settings both
  called it, the IPC handler and the browser shim both had it, and only
  `preload-room.ts` was missing the line — so it threw in the installed app
  and worked on the second screen.
- **Starting an agent from Kik** (flow 1). Say what you want done and it
  starts a session in the project and hands it the job — with the model off,
  too. `docs/HANDOVER.md`, "Starting an agent, and acting on a card".
- **Acting on a card** (most of flows 3 and 4). Re-run a command, revert a
  file, ask what a change did, from the card itself. What is still missing
  from flow 3 is the voice half: "read me the diff", "apply hunks two and
  four".
- **Answering from the couch, most of it.** The phone can *talk* to Kik
  (`docs/HANDOVER.md`, "The walkie-talkie") and, since 2026-09-23, *see*
  the canvas live, pinch and pan it, and type to Kik ("The canvas on the
  phone"). It still cannot answer a permission or press a card's button by
  tapping, and it works on the home network only; that is the rest of
  flow 2.
- **Commands by voice, through Jev (2026-09-23).** "Open a new Claude
  session in storefront and tell it to do one, two, three, four" starts a
  fresh session there with exactly that job; "tell it to…" reaches the
  agent without a Haiku call; "open marine in VS Code", "open github.com",
  "a terminal in billiar" open on the PC from a fixed menu. "Stop the
  agent" is a reflex. `docs/HANDOVER.md`, "Jev, the switchboard".
- **Reviewing by voice, most of flow 3 (2026-09-24).** "Read me the diff",
  "undo that", "run it again", "explain it" through the `work_card` tool on
  the latest diff or run card. "Apply hunks two and four" is still missing.
- **The day (2026-09-24).** The calendar read by the desk each hour and
  answered at once; a morning brief the first time you are heard on a new
  day; `day_brief` for a wrap-up; reminders and waiting questions pushed to
  a private ntfy topic when one is set; a permission that cannot be undone
  says so. `docs/HANDOVER.md`, "The rest of the plan".
- **The viewport buttons did nothing but resize.** They send `wide: true`;
  neither update path mapped it to `size`, so a page never became an
  artboard. Both paths now do.

- **Every project on the PC, run, planned, and a mic you choose
  (2026-09-26).** A scan finds projects across home and `C:\` (76, up from
  24); "run Marine" looks, starts it (from a worktree when the main
  checkout is empty) and frames it on the canvas, then asks what next;
  "plan mode, …" plans in `--permission-mode plan`, shows the plan, and
  waits for go ahead, a change, or drop it; the PC mic is open, muted (the
  phone still works) or push to talk, which is the default now.
  `docs/HANDOVER.md`, "Run, plan, and the mic's three modes". Still open:
  a running app's card shows `localhost`, which a phone cannot open; the
  agent works in a project's main checkout even when the app ran from a
  worktree; agents in folders Claude Code has not trusted run without
  hooks (the user decides whether Kik may mark them trusted).

## Flows that do not exist yet

1. **Starting an agent from Kik.** "Start a session in the wallet repo"
   does nothing; Kik can only talk to sessions that already send hooks.
2. **Answering from the couch.** A phone or tablet page for permissions,
   talking, and the canvas (asked for 2026-09-06).
3. **Reviewing a change by voice.** "Read me the diff", "explain this
   function", "apply hunks two and four".
4. **Tests and builds as cards** with a re-run button, and Kik reading the
   result.
5. **Tidying and exporting the canvas**: pull cards up, export PNG or PDF,
   an artboard preset.
6. **Undo.** "Undo what you just changed" on a card or the board.
7. **Kik reading a page.** Ask about what is on the framed site or the page
   it built.
8. **Being told when you are away.** Kik cannot reach you when you have
   left the room: no notification, no phone.
9. **Onboarding by voice**, and a first-run that ends with the user
   talking to Kik in five minutes.
10. **Other agents**: Codex, Gemini CLI, Aider adapters.

## The plan

Ordered by what breaks trust first, then what costs the feeling, then the
rest. Each item is a slice that ships on its own with tests, a screenshot,
a spoken demo and an installer.

### Now: trust (a week)

1. **The ear never stays dead.** A watchdog in the app restarts the mic
   process with backoff; Kik says "I lost the mic, back in a second" and
   "I can't hear; check the headset" after three failures; the doctor and
   the agents card show it in words. Test: kill the process, hear the line,
   see it back.
2. **Instructions land or say why not.** After thirty seconds queued with
   the agent idle, Kik says "it's waiting for the agent's next turn; type
   anything to it, or say start it"; the agents card shows the queued
   text; with two agents and no name, Kik asks which. Test through the
   Stop hook and the prompt hook.
3. **A renderer test harness.** jsdom under vitest for `board.js` layout
   (place, settle, keep, resize) and `room.js` cards (each kind renders,
   the footer buttons exist). Every layout fix gets a test.
4. **Designed pages keep.** Anything the designer builds is sticky by
   default; the user says "dismiss" to drop it.
5. **Two permissions at once.** A queue instead of a slot; the newer one
   waits; Kik says "two things are waiting, first…".

### Next: the feeling (two weeks)

Items 6 to 8 and the ear half of item 5 were researched on 2026-09-07;
`docs/HEARING.md` has the measured failures (a video call taken as
addressed, sentences in pieces, Whisper captions) and the phased setup
that supersedes the three lines below: a turn model, the owner's voice,
the name as a keyword, a transducer recognizer, call awareness, and
WebRTC echo cancellation with a loopback reference.

6. **The wake word** via the sherpa-onnx keyword spotter already in the
   ear (model download, a keywords file, tuned on the real mic), with the
   shape match kept as a fallback.
7. **Echo cancellation**: the speaker publishes what it plays, the ear
   subtracts it (WebRTC AEC through a small native module, or the
   sherpa-onnx speech enhancement), so barge-in works through speakers.
8. **Streaming transcription**: partial decodes every second while speech
   continues; Kik starts on a question before the sentence ends.
9. **Concerns on the canvas**: a quiet line on the agents card for each
   thing the watchers raised, cleared when it resolves.
10. **Resume after a cut**: if barged in with more than a clause left, Kik
    offers "shall I finish?" once.

### Then: the canvas (two weeks)

11. **Tidy and undo**: "tidy the board" pulls cards up into their columns;
    every `update_artifact` keeps the previous body; "undo that" restores.
12. **Bundled runtime**: React, ReactDOM, Babel and a Tailwind build shipped
    in the app and served from the daemon, so designed pages work offline
    and load instantly.
13. **The web card grows up**: address bar, back, reload, tabs; the served
    page reachable from the browser Room.
14. **Export**: PNG and PDF of a card or the board.

### Later: agents and ship

15. Start a session from Kik; Codex and Gemini adapters; diff review by
    voice; test and build cards.
16. The remote page for tablet and phone; being told when away.
17. Signed installers, auto-update, onboarding by voice, the public show
    contract, a privacy page.

### Small things to fold in as they are passed

- Turn `hear_debug` off by default; a one-tap "what did you hear" for the
  last minute.
- Rotate `daemon.log` at a few megabytes.
- Fix the mac plist string.
- Do not count Kikoe's own repo hooks as presence when the user is away.
- Write the journal on the first exchange of a new day, not only hourly.
- `kikoe say` and `kikoe state` in the CLI.
