# Kikoe roadmap

Kikoe is the room you run your coding agents from by voice: an ear, a voice,
a mind, and a canvas. This is the whole road, from what runs tonight to what
ships. Dates are targets from 2026-09-06; each milestone has a bar it must
clear before the next starts.

## The bar above every milestone

`docs/SENTIENCE.md`: Kik should feel like someone in the room, not a
program that answers. Every milestone below is measured against it.

## Where it stands (2026-09-06)

Working on this machine, installed, starts at login:

- Claude Code hooks in; narration through ElevenLabs, Piper, Kokoro, system.
- The Room: one window, the canvas always on, the Control Room and settings
  as views, light and dark, a second-screen viewer link.
- The ear: headset mic, local VAD and Whisper, name gate with the
  nickname "kik", follow-up window, second-person detection, model-judged
  gray zone, barge-in, sentence merging.
- The mind: Claude in the head with the live picture; tools to approve,
  deny, answer, instruct the agent through its Stop hook, change mode, and
  make, read, update, point at and remove artifacts; asks with buttons;
  suggestion chips; narrates in its own words; speaks up unprompted.
- The canvas: conversation card, agents card, what-happened cards,
  checklists, notes as stickies, markdown, tables, diagrams, SVG, sandboxed
  HTML artboards with open and download; keep (sticky, survives restarts);
  resize anything; four 4K backdrops or your own image.
- 114 tests, CI on three platforms, unsigned installers.

## Milestone 1: Trust (by 2026-09-13)

The bar: a week of daily use without a surprise.

- Wake word model for "kik" (openWakeWord, trained on your voice and a few
  synthetic ones) so the name stops depending on Whisper's spelling.
- Acoustic echo cancellation so barge-in works through speakers.
- Streaming transcription so Kik can start answering before the sentence
  ends.
- The tuning switch off by default; a one-tap "what did you hear" in the
  Control Room for the last minute only.
- Persistence for the conversation and the heard log (SQLite), so a restart
  keeps context.
- Crash-proof ear: watchdog restarts it; the Room says when it is down.

## Milestone 2: Conversation (by 2026-09-20)

The bar: you forget it is a program for a whole session.

- Hosted conversational session (ElevenLabs Agents over WebSocket) as the
  primary loop: their turn-taking, interruption and voice; our tools and
  context. The local pipeline stays as the offline fallback.
- Memory across days: what you decided, what you asked for, what it made,
  summarised nightly and fed back into the picture.
- Kik initiates: end-of-day summary, "the tests have been red for an hour",
  "you asked me to remind you about the migration".
- Voice per agent and a spatial cue on the canvas: the card that speaks
  glows.

## Milestone 3: The canvas as a workspace (by 2026-10-04)

The bar: a designer would keep it open.

- Selection, multi-select, group move, align, distribute.
- Connectors between cards (arrows), so a sticky can point at a line in a
  diff.
- Kik draws on the canvas live: strokes, highlights, callouts while it
  talks.
- Artboard presets (phone, desktop, print) and export as PNG or PDF.
- Version history per artifact; "undo what you just changed".
- Text and image drop from the desktop; paste from the clipboard.
- The canvas on the second screen is live and interactive, not just a
  viewer; a phone view for answering permissions from the couch.

## Milestone 4: Agents (by 2026-10-18)

The bar: three agents, three repos, one afternoon, no terminal.

- Instructions by voice for any agent, not only through the Stop hook: a
  queue the agent drains at turn start; a "start a session in repo X" from
  Kik.
- Codex, Gemini CLI, Aider adapters beside Claude Code.
- Diff review by voice: "read me the change", "explain this function",
  "apply hunks two and four".
- Test and build results as first-class cards with re-run buttons.
- A project model: repos, branches, PRs, deploys, on the canvas as a map.

## Milestone 5: Ship (by 2026-11-01)

The bar: a stranger installs it and is talking to Kik in five minutes.

- Signed installers on all three platforms; auto-update.
- Onboarding in the Room: pick a voice, connect Claude Code, say "kik".
- A public `/show` contract and the `kikoe` CLI documented for any agent.
- Keys and privacy page: what leaves the machine, when, and the switch.
- A website, a two-minute film, and pricing (bring your own keys first).

## Beyond

- Kikoe for teams: a shared canvas, one Kik per person, handoffs by voice.
- Local models end to end for the fully offline mode.
- Kik on the phone: the same session, the same canvas, walking.

## How we work

Every change lands with tests, a screenshot, and one spoken demo. Nothing
ships that can't be answered by voice. The rulebook stays as the floor.
