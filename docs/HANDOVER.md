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
pnpm test                        # vitest, 121 tests; never touches ~/.claude or the speaker
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
   clear_board, pin_note.
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
   The goal all of this serves is `docs/SENTIENCE.md`.
4. The Room renders the daemon's `/stream` frames: `pin`, `heard`, `mic`,
   `speech`, `sessions`, `event`, `focus`, `suggest`, `look`. The board is a
   pan/zoom canvas (`board.js`): frames per repo, cards placed in columns,
   dragged cards remembered, `near` cards placed beside their host, `w/h`
   from the corner grip. Synthetic cards (conversation, agents, events) are
   built in `room.js`, not stored.

## Settings that matter (config.local.json)

`tts`, `narrate`, `hook_profile`, `mic` + `mic_device` ("HyperX Cloud
Flight": the desk mic M8 hears the room), `wake_name` ("kik"),
`stt_model` ("base"), `hear_debug` (ON right now for tuning; it keeps the
text of everything heard; turn off when the name lands reliably),
`hear_you` (true), `barge_in` (true, headset only), `brain` (true),
`brain_model` (Haiku 4.5; Sonnet 5 option), `brain_narrates`,
`brain_checkin`, `brain_greets` (hello after an hour away), `backdrop`
("aurora"), `backdrop_dim`, `backdrop_blur`,
`backdrop_image`, `start_at_login`, `theme`.

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
  stays locked. Build outside the repo instead, from `packages/app`:
  `npx electron-builder --config.directories.output=<dir outside the repo>`,
  then run that installer with `/S`.
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

- The name depends on Whisper's spelling; the follow-up window and the
  model judgement paper over it. Wake-word model next.
- No echo cancellation: barge-in is headset-only.
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
3. Pick from `docs/ROADMAP.md` milestone 1. The user's own priorities, in
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
