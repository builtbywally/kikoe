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

## Starting an agent, and acting on a card (2026-09-07)

The two things that turned the canvas from a window onto the work into
something you can work *from*.

- **`daemon/src/agents.ts`.** `startAgent(project, task)` spawns Claude Code
  headless with `-p` in the project's folder. It is not a wrapper: the hooks
  are already installed, so narration, the tracker and the work cards all
  arrive the way they always have. Nothing is parsed from its output — the
  session is matched to the run by `claim(cwd, session)` when `SessionStart`
  fires, so "hooks in, hooks out" still holds. **`--dangerously-skip-permissions`
  is never passed**: being asked, and answering by voice, is the product.
- **Finding the binary is the part that breaks.** On Windows an npm install
  of `claude` is a `.cmd` shim, which `spawn` refuses without a shell, and
  the failure looks exactly like Kikoe ignoring you. `findClaude()` resolves
  setting → PATH → the usual install locations, and `spawn` gets
  `shell: true` only for a `.cmd`. There is a `claude_bin` setting for the
  machine where that is not enough.
- **`instruct()` no longer dead-ends.** "No agent is connected; nothing to
  hand it to" was the answer to the *first* instruction of every day, which
  is exactly the one that mattered. It now starts one.
- **It works with the model down.** Two paths had to change for that: the
  rulebook's `work` case, which said "say it to the terminal" since before
  Kik could start anything, and the brain's own failure fallback, which said
  the same. Both now instruct. This was verified with the account at 402:
  a spoken sentence started a real agent and the file it was asked for
  appeared.
- **`actOnPin(id, action)`** is how a card acts: `again` on a run or result,
  `revert` on a diff, `explain` on any of them. **Every one is an
  instruction to the agent.** Kikoe writes to no source file and runs no
  build of its own, so a revert is an edit you can see and judge and a
  re-run is the command that already ran — no new way for anything to reach
  your disk. `pinSubject()` reads the command or the file back out of the
  card body, because the body is a format this codebase writes and a second
  copy of the same fact is a second thing to keep true.

## The walkie-talkie: your phone as a microphone (2026-09-07)

Hold a button on your phone, talk, let go; what you said arrives as though
the headset had heard it, and Kik answers out loud from the desktop.

- **It is the one listener that is not loopback**, so it is `walkie: false`
  by default and switching it off *closes the socket* rather than ignoring
  it. Its own server on its own port (4571), its own token
  (`~/.kikoe/walkie_token.txt`, prefix `w-`) which can push audio in and
  nothing else — it cannot read the board, approve a tool call, or speak.
  The daemon's own port is untouched and still loopback only.
- **HTTPS is not optional.** `getUserMedia` refuses outside a secure
  context, and a phone on `http://192.168.x.x` is not one (localhost is the
  exception; the phone is not localhost). So the daemon signs itself a
  certificate with `selfsigned` — a new dependency, pure JS, so no native
  module for electron-builder to drop — and keeps it in `~/.kikoe`. It is
  **kept, not regenerated**: a fresh certificate every restart is a fresh
  warning every restart, and a warning you see constantly is one you stop
  reading. Every LAN address goes in as a SAN, because a modern browser
  ignores the common name entirely. `walkie_cert.json` records which
  addresses it was made for, since a PEM is base64 and cannot be asked.
- **The audio is raw.** The page downsamples to the 16 kHz mono the
  recognizer already wants and posts Int16 PCM. No codec to decode, and no
  second speech model: the clip goes to the ear utility process over
  `postMessage` and the same Whisper that hears the headset hears the phone.
  The answer comes back the same way rather than through `/heard`, because
  an HTTP request is waiting on it.
- **Push to talk is its own answer to "was that for me"**, so the name gate
  and the model judgement are skipped: you held a button on a page called
  Kik.
- The page is one file with nothing fetched — it has to work on a phone
  that has just been told this certificate is suspicious. Capture is a
  `ScriptProcessor` rather than an `AudioWorklet` because a worklet needs
  its own module URL, and one file is worth more here than the deprecation.
- **The one thing not proven on this machine**: whether a given phone hands
  over the microphone after you tap through the certificate warning. Chrome
  on the desktop refuses the page outright (`ERR_CERT_AUTHORITY_INVALID`)
  rather than offering the bypass to an automated client, so this needs a
  real phone. `GET /cert.pem` serves the certificate for installing
  properly, which removes the warning and the question together; the page
  says so itself if it finds it is not in a secure context.

Verified end to end over the LAN: 1.39 s of speech posted to
`https://192.168.1.115:4571/audio` came back `"Kick switch to billier"` and
the Room moved to Billiar. That one line is also the best argument for the
project resolver matching by shape — Whisper said "billier", the folder is
"Billiar".

## Projects: a board each, switched by voice (2026-09-07)

The second slice of the ADE work. `docs/REVIEW-2026-09-05.md:126-130` asked
for it in the user's own words — *"a project is a name, a set of repos, a
voice, a board. 'Switch to storefront' by voice or click moves the whole
Room."*

- **`daemon/src/projects.ts`.** A project is an id, a name, aliases, and
  folders. `of(cwd, repo)` finds the one a working directory belongs to,
  longest root first, and makes it if it is new. `resolve(spoken)` goes
  exact, then alias, then prefix, then within one edit — the ear will not
  spell "Marine" the way the folder does, and a refused right answer costs
  more than a wrong one. `learn()` keeps what the ear called it, so the
  second time is direct.
- **They find themselves.** Nobody is going to register thirteen folders by
  hand, so when a hook arrives from a folder, `discoverSiblings()` lists
  its parent **once** and registers every sibling that is a git repo. One
  directory listing, no file is read, and nothing is looked at that is not
  next door to somewhere an agent has already run. Without this, "open
  Marine" failed until you had run an agent in Marine, which is backwards.
- **`Pin` gained `project`, `x` and `y`.** Boards live in
  `~/.kikoe/boards/<project>.json`, one file each, written only when that
  project changed. `board.json` is read once and **left in place** — a
  downgrade still finds its pins.
- **Eviction is per project.** `MAX_PINS = 24` across thirteen projects
  would mean opening one board emptied another; `evict(project)` only ever
  looks at one board's own pins.
- **The switch works without a key.** `"switch to marine"` has routed to a
  `focus` control since the beginning and only ever published a frame the
  Room ignored; it now moves the board, in the rulebook, so it works with
  the model off. `open_project` is the same thing as a brain tool.
- **A `project` frame** carries the whole board in one message, so a swap is
  one render rather than cards trickling in. `board.reset()` drops
  positions, columns and the arranged-by-hand set, because none of it means
  anything on the next board.
- **The rules for a project you are not looking at**, which are the ones to
  get right: the daemon never stops ingesting, Kik still speaks about every
  project, a permission from anywhere still takes the line, and switching
  destroys nothing — the other board is on disk exactly as you left it.
- `board.js`'s header used to end "nothing here is persisted: the board is
  as ephemeral as speech". That was deliberate and it is now false; the
  comment says so and says why.

Storage is JSON per project, **not** SQLite as the plan said. The data is a
few dozen pins per board, `board.json` already proved the shape, and
`node:sqlite` does not exist on Node 20 — which CI still builds. SQLite
earns its place when the heard log and history arrive, which are the things
JSON would actually be bad at.

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
- The NSIS install lands in `%LOCALAPPDATA%\Programs\kikoe` (it was
  `@kikoeapp`, the package name, in early builds). The start-at-login Run
  key (`electron.app.kikoe`) points there. The silent installer does not
  always relaunch the app (2026-09-23 it did not); start `kikoe.exe` from
  there and then check `/state`.
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
  Check `resources/app/node_modules` lists audify, sherpa-onnx-node and
  sherpa-onnx-win-x64 before installing (it was `app.asar.unpacked` until
  the build dropped asar on 2026-09-24). If an install fails with exit code
  2, something holds a file in the install folder; ask Windows who with the
  Restart Manager: `powershell -File scripts/who-holds.ps1 -Path <file>` (used on
  2026-09-24) rather than guessing — it was Orca. Then run
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

## The standing session, and the thread (2026-09-07)

The user's own simplification, and it was right: *"when I open Kikoe there
should be a Claude Code terminal that I am speaking to."*

- **A session is a file, not a process.** `claude -p` starts and exits every
  turn, so "always there" costs an id and nothing else. Each project keeps
  one (`Project.session`, a v4 UUID in `projects.json`): `--session-id`
  opens it the first time, `--resume` continues it after. Verified across
  separate processes — told one turn to remember 91, a later turn wrote 91
  to a file.
- **That deleted `claim()`.** Matching a spawned run to a session by cwd was
  only ever needed because the id was discovered rather than chosen. It is
  gone.
- **Idle goes straight in; busy still queues.** A second `-p` cannot
  interrupt a turn already running, so mid-turn the Stop-hook queue is still
  the only way in and remains. Idle, there is nothing to wait for.
- **The thread card** (`sessionBody()` in `room.js`) is the answer to "I
  can't see what it's doing": you, Kik and the agent in one place and in
  order, with every agent line clicking through to its card. It is built in
  the renderer from the heard log and the work pins, so it stores nothing.

**A guard worth keeping.** Making the rulebook instruct meant a misheard
fragment could reach a real agent — the word "time" was queued as a job
once. `instruct()` now wants four words before it passes anything on.

**The tension this exposed, unresolved.** The router sends *questions* to
Kik and *work* to the agent. So "what number did you remember?" goes to Kik,
who has no idea, while "write it to a file" reaches the agent. If the goal
is really to talk to the agent, that split needs revisiting — some
questions are for the agent, and only it can answer them.

## Talking to it with no model of its own (2026-09-07)

Asked "so can I have a normal conversation with it?" the answer was no —
both model accounts are empty — and that was the wrong answer, because a
whole Claude was sitting idle in the next room on the user's own
subscription.

So when Kik's brain is unavailable, the fallback now has three answers
rather than one:

- **social** — the rulebook, as before.
- **a question the rulebook knows** (`headKnows()` in `core/src/head.ts`:
  tests, errors, waiting, how long, what's it doing) — answered here,
  instantly and free. Measured at 75 ms.
- **anything else** — to the agent, through `instruct()`, and its reply comes
  back on the Stop hook and is spoken like any other. Measured end to end:
  "why is a bounded retry better than an unbounded one" → 19 s → spoken
  aloud, and a card on the canvas.

`headKnows()` exists because the rulebook always returned *something*, so
there was no way to tell "I know this" from "here is a status line because
it is all I have".

**The cost, stated plainly:** an agent turn is fifteen to forty seconds.
That is a conversation, but not a quick one, and it is not a substitute for
credit — Kik's own voice is a second away when it has a model.

## Jev, the switchboard (2026-09-23)

The user asked for Laya or Jev "as the form of communication between
Claude Code and my PC": say "open a new Claude session and tell it to do
one, two, three, four" and have it happen. Both are System One models:
typed questions in, probabilities out, no text generated. So they cannot
*be* the conversation; they decide where a sentence goes, and code acts.

- **Why Jev and not Laya.** Both were put to Kikoe's own cases
  (`~/orca/projects/laya-vs-jev/kikoe_probe*.py`). "Was that said to Kik":
  Jev 10/10 with wide margins, Laya no separation at all (0.19–0.38 for
  every sentence). Kik-or-agent: Jev 9/10 at near-certainty, Laya 8/10 at
  0.3–0.7. Laya is 34 ms local on the 3090 against Jev's ~320 ms over the
  network, and is the answer for privacy once fine-tuned on the heard log;
  it is cloned with a CUDA venv at `~/orca/projects/laya`. Jev costs
  $0.042 per million input tokens: nothing.
- **`daemon/src/jev.ts`.** `command()` asks, in one request, the action
  (kik, agent, new_session, open, stop_agent), which *cut* of the sentence
  is the task (`taskCandidates()`: the whole thing, after "tell it to",
  after "and", …), and what to open. The project is a **second request in
  parallel over the sentence alone** — given the current project and the
  last exchange too, Jev named projects the sentence never mentioned.
  `directed()` replaces `Brain.directed()` in the gray zone; the model is
  now only the fallback.
- **Jev chooses, code acts.** The task an agent gets is the user's own
  words, cut, never paraphrased. `spokenRest()` hands Jev the raw
  transcript minus the name, because the router's normalized text had
  turned "github.com" into "github com" and dropped the task's commas.
  `pc.ts` is a fixed menu (editor, folder, terminal, browser, an http(s)
  address found in the sentence), no shell except `code.cmd`, behind the
  `pc` setting.
- **Thresholds.** An action below 0.6 goes the old way (`respond()`, the
  pre-Jev tail of `hear()`); a named project below 0.5 is asked about
  ("Which project, storefront or billiar?") and the next name answers it.
  Measured on thirteen real sentences: every action right, the lowest
  0.52 (and that one was Kik's anyway).
- **"New session" is a new conversation**: `startAgent(…, { fresh: true })`
  forgets the project's standing session id, only when nothing is running
  there. Verified live: "open a new claude session in ClaudeTalks and tell
  it to reply with the single word ready" → Jev new_session 0.97 in
  ClaudeTalks 0.84 (906 ms) → agent started 16 ms later → `ready`.
- **Two rule fixes that need no key**: "wait, why did that fail" was a
  *pause* (the control regex took any sentence starting with "wait");
  "stop the agent" only stopped Kik's voice. Now `agent` is its own
  control intent that stops the runs Kik started.
- **Tried and dropped**: Jev for corrections. It called "stop the agent" a
  correction and missed "no, I said storefront"; the regex stays, with
  "actually I meant" added.
- The key is `~/.kikoe/jev_key.txt` (or `JEV_API_KEY`), re-read on
  `reconfigure()`. Tests pass `jevKey` and a fake `fetchImpl`; no test can
  reach TypeSafe. **The screenshot harness does**, since it reads the real
  key: its staged "add a retry" line made one real Jev call. Harmless, but
  know it.
- Still open: Jev does not know what only the agent's session knows, so
  "what number did you remember?" goes to Kik. The fix is a line of state
  about the standing session, not a better model.

## The canvas on the phone (2026-09-23)

The user's vision: the infinite canvas streamed to the phone, talk to the
phone, everything still done on the PC. The walkie was already a phone
microphone and the browser Room already ran on a second screen; this joins
them.

- **The walkie serves the Room.** With a Room to serve, `/` on the walkie
  redirects to `/room/?phone=1` (the button-only page stays at `/talk`).
  The Room's reads — `/room/*`, `/artifact/*`, `/state`, `/stream`, `/pins`,
  `/backdrop`, `/usage` — are proxied to the daemon on loopback **with the
  viewer token**, swapped in for whatever the page sent. So the daemon's own
  rule, a viewer may look and may not touch, is what holds; the walkie token
  never reaches the daemon; and nothing that acts is proxied (a test posts to
  every acting route and checks the daemon saw nothing). The event stream is
  piped unbuffered and closed on the daemon side when the phone goes.
- **Talking**: `phone.js` puts a hold-to-talk button over the canvas and
  posts PCM to the walkie's `/audio`, the same path as before. Typing in the
  canvas's box posts to the walkie's own `/say`, which calls `typed()` —
  the same power as speaking, which the walkie token already had.
- **Two browser-side traps, both fixed**: the Room's CSP had
  `connect-src http://127.0.0.1:*` only, so on the phone every fetch and the
  stream were refused (`'self'` added); and `fit()` fitted the whole board at
  a floor of 0.85, cutting cards off on a phone — the phone fits the first
  column to its width. A finger on a card pans (a viewer cannot drag), and
  two fingers pinch-zoom about their midpoint.
- **Verified** over the LAN address with an Electron window at 390×844
  (`~/orca/projects/laya-vs-jev/shots/phone-shot.js`): the canvas, the
  backdrop and the cards render; typing "what is the agent doing right now"
  went walkie → Jev (kik 0.87) → rules (the model account is at 402) →
  the answer on the phone's card, spoken on the desk. **Not verified**: a real
  phone's microphone through the new button — same capture code and route as
  the walkie page, but it needs a phone in hand.
- **Electron trap**: `electron.exe script.js https://…` exits 127 before
  running anything; Electron will not start with a URL on its command line.
  Pass it through the environment. And a `/c/...` script path from Git Bash
  does the same; `cd` to the folder and use a relative path.
- **Hearing Kik on the phone.** The daemon's speaker is a `TappedSpeaker`:
  every `push()` is also handed to `walkie.voice()`, and `drop()` (Kik cut
  off) to `voiceDrop()`. A phone that turns on its "sound" button opens the
  walkie's `/voice` event stream and gets 16-bit PCM in base64 at the rate
  it was made (24 kHz here), scheduled back to back in Web Audio; a drop
  stops it. Nobody listening costs nothing: no phone, no encoding. The desk
  still speaks too. Verified live: a spoken line arrived as 97 events,
  2.3 s of speech, RMS 0.25. The phone remembers the choice, but a phone
  will not play audio a page started by itself, so after a reload the first
  tap anywhere unlocks it.
- **What the first real phone test showed** (the user, 2026-09-23 05:17),
  all fixed the same hour: sentences arrived cut off ("hey how's it go")
  because recording stopped the instant the finger lifted — the page now
  keeps 0.4 s from before the press and runs 0.45 s past the release, and a
  tap under 0.3 s held sends nothing; Whisper's "[buzzing]" and a lone "("
  were routed as speech — `hear()` now drops a transcript that is only a
  noise tag; "what what what what" (four words, one idea) reached the WM
  Studio agent through the no-model fallback — `instruct()` now wants three
  *different* words; every hello got "Here." because the model account is
  at 402 — the rules now answer "how are you" and "hey", and Kik says once
  an hour that it is out of credit; and the session card repeated the Kik
  card line for line — it now shows only what reached the agent.
- **"Open YouTube here" puts it on the canvas** (asked from the phone the
  same morning). Jev has a `canvas` action beside `open`: "on the canvas",
  "on the board", "here" → a live `web` card, the same one the model's
  create_artifact makes; "in my browser" → the PC. From the phone, an `open`
  of a website becomes `canvas` too, because the desk's browser helps nobody
  on the couch. `siteByName()` turns "open YouTube" into youtube.com (the
  phone asked "which address?" three times running), and `findUrl()` mends
  Whisper's "youtube.com.com". **Limit**: the Room unframes sites only
  inside Electron; a phone's browser honours X-Frame-Options, so YouTube's
  card is blank on the phone and fine on the desk.
- **Away from home: Tailscale** (`daemon/src/tailnet.ts`). The walkie
  already answered on the machine's 100.x tailnet address, and its
  certificate already names it, so the phone worked over Tailscale with the
  usual warning from day one. The `walkie_tailscale` setting adds the better
  door: `tailscale serve --bg --https=443 https+insecure://127.0.0.1:4571`,
  a real certificate at `wm.taile841c1.ts.net`, own devices only. The rule
  follows the walkie (off takes it down), and Kikoe only ever touches that
  one rule. **First run on a tailnet**: Serve must be approved once — the
  CLI prints a login.tailscale.com link and *waits*; the 8 s timeout ends the
  wait and Settings shows the link. HTTPS certificates must also be on for
  the tailnet (`CertDomains` in `tailscale status --json`). Tests never run
  the real CLI (`tailnetImpl` is null under Vitest unless a test passes one).
- **Stopping the walkie with a phone attached**: `server.close()` waits for
  every open connection, and a phone watching the canvas or listening holds
  one forever. `stop()` now ends the voice streams and calls
  `closeAllConnections()`; a test stops it with a listener attached.
- Not done, by design: acting from the phone (approve, card buttons) is the
  next slice and needs its own token right; `localhost` web cards show only
  on the desk; away from home needs Tailscale (and gives a real certificate).

## Thinking through Claude Code (2026-09-23)

The user: "for the thinking aspect, I want to use a Claude session in the
background", and "whenever Claude is thinking, Kik should give me filler
speech, like give me two seconds to think about this, or start a different
subject". The API account had been at 402 for days.

- **`daemon/src/codebrain.ts`, provider `claude-code`.** A `Brain` subclass
  that runs `claude -p` headless per thought: `--system-prompt-file` (the
  whole brainSystem), stream-json with partial messages so clauses are
  spoken as they arrive, `--tools ""` (Kik's head edits nothing),
  `--strict-mcp-config`, and a settings file with `disableAllHooks` — or
  Kik would narrate its own thinking as an agent at work. The prompt is the
  recent conversation plus the new sentence, on stdin. Needs no key; the
  binary is `agents.bin()`.
- **Kik's tools reach it over MCP**: `ToolServer` is a loopback JSON-RPC
  server (initialize, tools/list, tools/call, ping) on a random port with a
  random token, alive for one reply, `--allowedTools mcp__kik`. Each call
  runs the same `BrainTool.run` the API head would. Verified live: "remember
  that we ship on Fridays" called `remember` through it.
- **Measured**: a bare `claude -p` is ~6.6 s (Haiku); with the tool server
  and a small prompt the first word was 3.7 s; with Kik's full system prompt
  7.2 s to the first word, 9.2 s done. The API head is ~1 s.
- **The fillers**: two beats. At ~0.9 s a line that says it is thinking
  ("Give me a second to think about that."), and 4.5 s later, if still
  thinking, something real from the board (`meanwhile()`: an agent waiting
  or failed, not repeated within ten minutes) or "Still thinking." Live:
  +1.0 s, +5.3 s, answer at +7.4 s. A hello gets a filler too on this head.
- **What stays on the rules with this head** (`thinksSlowly()`): event
  narration, the minute check-in and the inner note. Every thought is a
  process and several seconds of the user's subscription, so only what the
  user asks for, and the designer, goes through it.
- The user's config was switched to `brain_provider: "claude-code"` on
  2026-09-23 at their request (it was `openrouter`).

## Two sessions: talking and thinking (2026-09-23)

The per-thought head above was 7 s a reply and it confused the user: a
filler said "let me look into that" and the next reply had no idea it had.
Their design, built the same hour: **a talking session with thinking off,
kept open, and a separate thinking session.** `docs/PIPELINE.md` is the
whole flow, written for the user; the parts the next session needs:

- `livebrain.ts`: one `claude -p --input-format stream-json` process,
  Haiku, `MAX_THINKING_TOKENS=0`, warmed when the brain is made. 0.68 s to
  the first word live. The live picture rides on each message (the persona
  is the system prompt); `ReplyOptions.asides` carries what Kik said aloud
  since (fillers, thoughts that landed). Restarts after 30 turns, 20 min
  idle, or a crash.
- `think()`: Opus (`think_model`, default the `opus` alias — the user's
  choice), `MAX_THINKING_TOKENS=12000`, via `CodeBrain.generate`. Reached by
  Jev's new `think` action or the `think_deeply` tool. Live: 24 s; answer
  spoken, detail as a markdown card, `thinking` frame for the Room.
- Jev's `agent` criterion was narrowed to *doing* things in the repo; "think
  this through / what's the best way / weigh up" is `think` (11/11 on real
  Jev). Before that, a design question went to the coding agent.
- The Room's cards are now **kik · talking**, **kik · thinking** and
  **agent · \<project\>** — "the session" read as a second Kik.
- **A trap found on the way**: the screenshot harness stages a fake
  "kikoe is working" session, and a dev daemon queues instructions for it —
  which a real Claude Code session in the kikoe repo could receive on its
  Stop hook. Stop the dev app after a live test and the queue goes with it.
- Tests start no real Claude: `codeSpawn` (daemon) and `spawnImpl` (heads)
  take a fake, `livebrain.test.ts` has one that speaks stream-json.

## Thinking orbs (2026-09-23)

Asked for by name: [Jakubantalik/thinking-orbs](https://github.com/Jakubantalik/thinking-orbs)
(MIT) — dotted thought-orbs, nine animated states, two tuned sizes, plain
2D canvas. Only its engine is used: `scripts/build-orbs.mjs` bundles
`../thinking-orbs/src/engine` into `renderer/room/vendor/thinking-orbs.js`
(14 KB, licence in the header; clone the repo beside kikoe to rebuild).
`renderer/room/orbs.js` replaces the React component: one shared clock and
animation frame, stops when hidden, a still frame under reduced motion,
`KikOrb.forKik()` maps Kik's states to orb verbs (idle→breathing,
listening, thinking→working, speaking→composing, asking→connecting, a
thought→solving). Where they are: the Room's big orb (setOrb drives it and
broadcasts `kik-orb`), the headers of kik · talking / kik · thinking /
agent cards, the phone (beside the talk button; listening while held) and
the island's mark (20 px preset). Files live under `room/` because the
daemon only serves that folder to the phone; the island loads `../room/`.
`**/vendor/**` is out of Biome's reach. Known: the markdown card renders
tables as raw text, which the thinking session's detail often uses.

**YouTube on the phone** (the user, 2026-09-23: "open YouTube and look up
lofi… it couldn't reach the web"). Jev routed it right; the card was blank
because youtube.com sends `X-Frame-Options: SAMEORIGIN`, which the desk app
strips and a phone's browser obeys. Now a YouTube ask becomes YouTube's
player (`/embed/<id>`, which may be framed): `searchQuery()` pulls "low-fi
chill beats" out of the sentence, `youtubeSearch()` reads the first
`videoId` off the results page (no API key; if YouTube changes the page Kik
says it found nothing), and any YouTube link given to the canvas becomes its
player too. Other sites that refuse framing still show blank on the phone;
phone web cards carry an "open ↗" link for that. The phone's orb is now the
talk button itself (the user asked), with "hold to talk" beneath it.

**Jev does not build web pages.** A demo of "Jev building a page live" is
Jev choosing and an LLM (or code) writing; Jev returns no text. The fast
page in Kikoe is `design_artifact` with `quick: true` on Haiku.

## The README, and a cleanup (2026-09-24)

- **The README was rewritten** from the day-one "Phase 0" text: what Kik
  does, what you can say, the pipeline as a Mermaid diagram, the three
  sessions, the phone, install, keys, the installer's traps, the change
  loop, the layout, the docs index and the principles. Its images live in
  `docs/images` and come from **`bash scripts/readme-images.sh`**: the
  desk from the `--screenshot` harness, the phone from a second Kikoe on a
  throwaway `KIKOE_HOME` staged through hooks and `/show`, captured by
  `scripts/phone-shot.cjs`. Never publish a shot of the real board.
- **Trap found making them**: a Kikoe with `walkie_tailscale: false` takes
  the tailnet serve rule *down* on start, even from a throwaway home — it is
  one machine-wide rule. Starting the real app puts it back
  (`tailscale serve status` shows `wm.taile841c1.ts.net → 4571`).
- **Removed, each checked unreferenced**: `packages/daemon/proto/` (three
  prototype scripts), `packages/cli/src/index.ts` (`export {}`), the CLI's
  `@kikoe/core` and `@kikoe/daemon` dependencies (it imports only `node:`),
  `CollectingSink`, `needsHuman`, `KIT_REFERENCE_CSS`, `docs/UPGRADES.md`
  (the day-one ranked list, orphaned), and the ClaudeTalks wordmark,
  lockups and pre-orb app icons in `brand/` (`BRAND.md` is now Kikoe's).
  The three Instrument Sans files were the same bytes; there is one, with
  `font-weight: 400 600`. `Astra.md` moved to `docs/ASTRA.md`.
- **Left on purpose**: `evals/fleet` and `evals/impulse` (no test reads them
  yet; `PLAN.md` calls them the acceptance contract), the unused
  re-exports in `core` and `daemon` indexes (`@kikoe/daemon` is published),
  `cold.yml` failing by design on commands still `PLANNED`.
- **The installer's exit code 2 was Orca** (found the same day). Before it
  installs, the NSIS installer runs the old version's uninstaller, which
  moves every file out of the install folder first and aborts on any busy
  file ("File is busy, aborting"); the installer then quits with 2
  (`installUtil.nsh:131`), or, if it gets as far as extracting, retries the
  locked file for ever in silent mode (the twelve-minute hang). The busy file
  was `resources\app.asar`, held by **Orca.exe**: Electron treats an `.asar`
  as a folder, and any Electron process that reads into one keeps the
  archive open until it quits. Windows' Restart Manager names the holder
  (`scripts/who-holds.ps1 -Path <file>`). **Fix: `asar: false`** in
  `electron-builder.yml` — the app ships as plain files, which are opened
  and closed, so nothing can pin the folder, and the ear's native modules
  need no unpacking. The one upgrade *from* an asar build still needs Orca
  (or whatever holds it) to let go: quit it, install, reopen.
- **"On my computer" from the phone opened a canvas card.** A phone's
  "open a website" became a canvas card whatever was said, so "pull up
  Chrome on my computer and go to YouTube" (Jev: open 0.98) went to the
  canvas. `wantsThePc()` now keeps anything that names the computer,
  desktop, a browser or Chrome on the PC; "on the desktop, please" right
  after a card opens that card's site on the PC (`lastCanvasSite`); and
  "a picture from unsplash" is Unsplash, not picture.com (`siteByName`
  prefers a named site; `siteSearch` opens its search for the subject).
- **Found, not fixed**: `electron-builder.yml` and `main.ts:455` want
  `build/trayTemplate.png` on macOS and it does not exist; the app requires
  `audify` and `sherpa-onnx-node` without declaring them (works because
  `.npmrc` hoists); `docs/VOICE.md` still names ClaudeTalks's Python files.

## A canvas that moves, and renders less (2026-09-24)

The user: "make the canvas more dynamic and also optimize it". `board.js`
was restructured; its header says the rules.

- **Motion**, all transform and opacity (compositor only): focus and fit
  glide (`glideTo`, 420 ms ease-out) instead of jumping; a flung pan coasts
  and slows (`coastFrom`, time-based friction, so a slow frame does not
  slide further); new cards fade and rise in; a card that goes fades out
  before it is removed (`leave`); cards the layout pushes aside slide there
  (FLIP with the Web Animations API: positions before and after a render,
  a translate from the old place to none); frames ease to their new bounds;
  a card lifts 2 px on hover and scales 1.5% when picked up. The zoom
  buttons glide too. **None of it runs** under prefers-reduced-motion or in
  a window whose document is not visible (the `--screenshot` harness), so
  screenshots are exactly as they were.
- **Speed**, measured with the old and new board.js on the same 80 cards
  in Chrome: first render 29–42 ms → 9–11 ms; a render where nothing
  changed (every stream frame, the 15 s tick) 2.4–3.4 → 1.1–1.3 ms; a card
  arriving ~2.6 → ~2 ms with its animations. Where it came from: unchanged
  cards are no longer built just to read their age (`pinFresh()` in
  room.js gives the fade and the age line; `render(pins, pinCard,
  pinFresh)`); an id → element map instead of `querySelector` per card;
  one pass that reads every size, then placing and settling in memory, then
  one pass that writes positions (it used to read and write card by card,
  a layout each); frames bounded from positions and cached sizes, never
  the DOM; dragging a card re-bounds only its own frame from sizes taken at
  pick-up, so no layout is forced while a card is in the hand; pan, zoom and
  the grip paint once per animation frame; the dot grid is not rewritten
  under a backdrop that overrides it; `.pin { contain: layout style }` so
  typing in a card lays out that card only; `will-change: transform` on the
  world only while it moves (kept on, text went soft when zoomed in), and
  frosted cards drop their backdrop blur while the canvas moves.
- `contain: layout` would change what a `position: fixed` child of a card
  is fixed to; nothing inside a card is fixed today. Keep it that way.

## Jev, a third of a second (2026-09-24)

Measured first, on the real API (`jev-timing.mjs` and `jev-idle.mjs`, kept
in the session's scratchpad): a request on a new connection ~760 ms, on an
open one ~280 ms; the main and project requests in parallel cost no more than
one; "was it for me" then "what to do" 590 ms, both at once 310 ms; and
TypeSafe keeps an idle connection for at least two minutes. Live, sentences
fifteen seconds apart were ~700 ms each, because `fetch` drops its
connection after about four seconds and nobody speaks twice in four.

- **A kept connection**: `jev.ts` posts through its own `https.Agent`
  (keep-alive), retrying once on a reused socket the server closed. The
  daemon passes Jev a `fetchImpl` only when a test gave it one
  (`fetchGiven`); passing the platform `fetch` silently undid all of this,
  and the first live measurement after the change was still ~700 ms.
- **Warmed before it is needed**: `Jev.warm()` (a tiny request, skipped if
  the connection was used in the last minute) on daemon start, on the ear's
  `hearing` phase — the handshake happens while the user is still talking —
  and when a phone clip arrives, before Whisper.
- **Asked together**: for a nameless sentence, `decideDirected()` starts
  `command()` beside `directed()`, and hands the promise to `dispatch()`
  (`pre`), which uses it instead of asking again. A no throws it away.
- Live after: 284–322 ms per sentence at fifteen-second gaps (756 ms for the
  very first after a restart, now covered by the start-up warm).

## The phone's background came and went, and tore (2026-09-24)

Three causes, all fixed:

- **A 404.** The Room asks for `../backdrops/<name>.jpg`, which is outside
  `/room/`, and the walkie's `proxiable()` did not pass `/backdrops/`
  through, so the phone mostly had no backdrop at all (the README's phone
  shot of the day before shows it missing). Now proxied; a test says so.
- **A 4K image on a phone.** 3840×2160 decodes to ~33 MB of pixels, which a
  phone's GPU evicts and re-tiles under pressure: tearing, vanishing. A
  phone now loads `<name>-small.jpg` (1920×1080, 30–120 KB, made from the
  originals with Pillow; re-make them if a backdrop changes).
- **The backdrop repainted with the cards.** It was the board's own
  background, so anything that changed on a card repainted it — and a
  thinking orb changes every frame. The image and its dim are now one
  `::before` layer of its own (`will-change: transform`), drawn once. On the
  phone the card world keeps its layer at rest too, and frosted cards are
  solid (backdrop blur per card per frame is the heaviest thing a phone's
  GPU does).
- **Correction, the same evening**: the user's phone screenshot showed the
  backdrop in its top third and black below a straight line — tiles the
  phone's GPU dropped. The layer of its own for the backdrop, and the cards'
  layer kept at rest, were the big textures it dropped them from (Chrome on
  Android, 19 tabs open, several live pages on the canvas). On the phone the
  backdrop is back in the page's own layer (always painted whole), the
  cards' layer comes and goes with movement as on the desk, and card iframes
  are `loading="lazy"`, so a live page far off screen costs nothing. The
  desk keeps the backdrop layer. Not verified on the phone itself yet.

## The three gates before hands (2026-09-24)

`docs/OS.md` §5: before Kik may act on the machine. All three are done.

1. **The ear can never stay dead** — `daemon/src/supervisor.ts`
   (`Supervisor`), used by `main.ts` as `earKeeper`. An exit nobody asked for
   is a crash; restarted after 1 s, then 2, 4, 8, 16, then every 30 s while
   wanted; a minute's run resets the backoff. Kik says "I lost the mic",
   "I can't hear you" after three, "I can hear you again" on the ear's
   `ready` (`Daemon.onMicReady`). `stopEar()` releases first, and the exit
   handler ignores a process that is no longer the current ear — a stopped
   ear can exit after its replacement started. Verified by killing the ear's
   utility process while listening: back in 1.9 s, both lines spoken.
2. **The watchdog has a mouth** — `crashSource()` reads the stack: the
   app's own errors are logged and no longer restart the daemon; three
   daemon crashes in a minute say "Kikoe has stopped working" through
   System.Speech (the daemon's voice is what stopped), show a notification
   that restarts it on a click, and try again after a minute instead of
   leaving it down for good.
3. **A capability model** — `daemon/src/capability.ts`: `gradeOf(kind,
   detail)` gives read / write / irreversible; the detail's words decide
   irreversible (delete, send, publish, pay, shut down…), and the stricter
   grade wins. `Daemon.askPermission(what, grade)` asks through the same
   held-question machinery as Claude Code's hook — the pending permission
   now carries a `reply` rather than a raw response — so the arbiter's
   binding and "yes" work unchanged. The depth-1 slot is a queue
   (`queued`, `enqueuePermission`, `nextPermission`, `expirePermission`,
   `Arbiter.wake()` to let a held question speak). Irreversible is never
   auto-approvable: there is no "always allow", and nothing may add one.
