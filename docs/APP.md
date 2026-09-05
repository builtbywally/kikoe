# What the app does

Everything the desktop app does, from the chair of the person using it.
Each item says which milestone of [APP-PLAN.md](APP-PLAN.md) delivers it:
**A** installs and narrates, **B** is trustworthy, **C** listens, **later**
is the Companion tier. Nothing here is a promise until its milestone is
marked done in the plan.

The one-sentence version: **it lets you leave the desk while your coding
agents work, and it tells you, out loud and in one line, exactly when it is
worth coming back.**

---

## 1. It narrates your agents · A

You run Claude Code the way you always do. The app hears every event the
agent emits through its hooks and decides, event by event, whether a person
across the room needs to know.

**What it says**

- **A turn finished.** One or two sentences, leading with the answer. *"Done.
  Fixed the race in token refresh by calling lock acquire."* Never the
  terminal read aloud: no code, no paths, no markdown, no diffs, no tables.
  File names become spoken names; identifiers become words.
- **Tests ran.** *"Tests: eighteen passed, two failed."* Pass and fail counts
  are matched independently, in either order, and a red run is never read
  as green. A failing run is spoken as an alert; a green run as a milestone.
- **Something broke.** *"It hit an error. Model stream disconnected after
  four minutes."* A turn that died, a tool that failed, a build that failed.
  Always spoken, and it interrupts whatever else was being said.
- **It needs you.** *"It wants to push. Shall I?"* A permission prompt is
  spoken as a question, with what it wants to do. Always spoken, interrupts,
  never goes stale.
- **A background task came back.** *"That's done. Migration finished, twelve
  tables."* The wait you forgot about is over.
- **It is waiting on you** and has been for a while. *"Waiting on you."*

**What it never says**

- Reads, greps, globs, searches, file listings, planning bookkeeping.
- A permission you just denied in the terminal.
- The same line twice within a few seconds.
- Progress that is already old news by the time the speaker is free. Running
  commentary carries a shelf life; expired lines are dropped, not spoken late.
- Anything from a session you never opened, unless it is a question, a
  failure, or done.

**How chatty, four settings, one click in the tray**

| Mode | Speaks |
|---|---|
| Silent | permissions and errors only |
| Attention | + turn completions |
| Normal *(default)* | + milestones: tests, commits, builds, installs |
| Verbose | + running commentary: *"Editing three files, starting with token refresh."* |

A burst of edits in Verbose is one sentence, not five. Shell commands are
described the way a colleague would: *"running the tests"*, *"installing
packages"*, *"committing"*. Boring ones are skipped.

## 2. Many agents, one voice · A

Run five agents in five repos. The app is one mouth for all of them.

- More urgent wins. A permission question preempts a milestone; an error
  preempts everything.
- When the speaking session changes, you are told which one: *"In storefront,
  it wants to run npm install."*
- Background chatter is rate-limited per session. Alerts never are.
- Sessions the app spawned itself (later, the Companion) are held to a
  stricter floor: only permission, failure, and done.

It works with Claude Code first. Codex and other agents join by adapter:
one file each, nothing else changes.

## 3. It stays out of the way · A

- **The island.** A small pill at the top of the screen. Idle: a thin sliver.
  Working: which repo, which tool, how long. Needs you: the question, and
  what it wants to run. Speaking: the line. Heard you / overheard (C): what it
  decided about your voice. It is click-through and accepts no mouse event,
  so it can never eat a click in your editor.
- **The tray.** Mode, pause for an hour, settings, doctor, quit. That is the
  whole menu.
- **No window to keep open.** After first run, nothing is on screen but the
  island.
- **It does not slow the agent.** The hook on the agent's critical path is
  `curl`, about ten milliseconds, and it never blocks a tool call to speak.
  A slow island or a stuck speaker can never back up into the agent.

## 4. It installs itself into Claude Code, and out again · A

- Finds your Claude Code settings, shows you exactly the hooks it will add,
  backs the file up, and adds them on one click.
- Marks what it owns. Uninstall removes exactly those entries and nothing
  else, and a hook you wrote yourself survives.
- Picks a hook profile: **attention** (two subprocesses a turn), **balanced**
  (default, one per tool call), **full** (two per tool call, for verbose).
- Detects a second copy of itself and refuses to start twice. Detects a
  stranger on its port and says so rather than binding over it.

## 5. Voices · A

- **Piper**, bundled. Speaks the moment the app opens, no download, no
  account, sixty milliseconds to first sound.
- **Kokoro**, one click to download, better voice, about four hundred
  milliseconds to first sound. Runs entirely on your machine.
- **ElevenLabs**, paste your own key, pick any voice in your library. About
  two hundred milliseconds to first sound. The key lives in the OS keychain,
  never in a file, and never in a log.
- **System voice**, always there, as the floor. If a better rung fails, the
  line still arrives.
- A play button next to each voice speaks a real narrator line so you choose
  by ear.
- **Strict mode**: use this voice and no other. For when a line arriving in
  the wrong voice is worse than a line that does not arrive.
- **A cloned voice** (B): fifteen clean seconds of someone talking, through
  ElevenLabs instant cloning. The app prepares the clip: mono, trimmed,
  levelled.

## 6. It speaks fast · A

Every line streams clause by clause. The first words reach the speaker
before the sentence is finished being made. Repeated lines are cached as
audio, so *"Tests: all twenty passed"* the second time costs nothing.

Targets, measured in CI, not claimed:

| From | To | Budget |
|---|---|---|
| Agent turn ends | first sound | under 700 ms |
| You say "yes" (C) | the agent proceeds | under 600 ms |
| You stop talking (C) | first sound of the reply | under 1.2 s |

## 7. First run · A

1. Open the app. The island appears. The tray icon appears.
2. Pick a voice. Hear it.
3. Connect Claude Code. See the hooks. Click.
4. Hear it work: the app replays a real session through the real pipeline,
   three edits, a test run, a permission question.
5. The window closes. Two minutes, start to finish.

Every step can be skipped and every step is in settings afterwards.

## 8. It keeps itself healthy · A, B

- **Doctor.** One click. Reports what is running, what is answering, which
  voice is live, whether the hooks are installed and whether they are
  reaching the app, what the microphone is actually hearing (C). Separates
  *running* from *answering*, because a daemon that is up but deaf looks
  identical to one with nothing to say.
- **Logs**, in a viewer, with a copy button.
- **Support bundle** (B): logs, doctor output, settings with secrets removed,
  zipped, for when you need help.
- **Updates** (B): checks GitHub releases, downloads in the background,
  installs on next launch, tells you in one tray line what changed.
- **Crash reports** (B): opt-in, and contain no transcript, no audio, no
  repository path.

## 9. It listens · C

Turn on the microphone in settings. From then on:

- **Say its name.** *"Hey Claude, did the tests pass?"* Open mic, no hotkey,
  no button. The name is configurable. Everything not addressed to it is
  discarded on the spot; nothing is recorded, nothing is kept.
- **Or hold a key.** Push-to-talk from the island, for a shared office. While
  the key is held, the key is the endpoint: no guessing when you stopped.
- **Local by default.** Voice activity detection, turn detection, and speech
  recognition run on your machine, on the CPU, in one runtime. No audio
  leaves the machine. On a machine without the horsepower, ElevenLabs Scribe
  is offered as a cloud rung, and the app tells you plainly that audio will
  leave the machine if you pick it. The name gate still runs locally, so
  only what you said *to it* is sent.
- **It knows when you have finished.** A turn-detection model reads the
  audio, not just the words, so a pause mid-sentence does not cut you off and
  a finished sentence does not leave you waiting.
- **Barge-in.** Talk over it and it stops. Say "mm-hm" over it and it does
  not.
- **Background audio ducks.** Music and video fade down while you talk and
  while it answers, per app, and come back after. Its own voice is never
  ducked. A crash never leaves the machine quiet: volumes are journaled to
  disk before they are moved.
- **The island shows what it decided.** *Heard you* when it took a sentence as
  yours. *Overheard* when it decided you were talking to someone else. That
  second state is the reason the island exists: it is how an open mic
  becomes something you stop thinking about.

## 10. You answer it · C

- **Yes and no.** *"It wants to push. Shall I?"* — *"yes"* — and the agent
  proceeds. The answer is bound to the last question it spoke and no other.
  Two agents ask seconds apart, you say yes, only the one you heard is
  released. Silence, "no", and the timeout all deny.
- **A stray word never approves anything.** Only the addressed, exact phrase
  counts. False accepts are held at zero and the budget is spent on the
  other side: it will occasionally ask you to say it again.
- **Destructive commands are never voice-approved by default.** Deleting,
  force-pushing, dropping: those come back to the terminal, and the list is
  code, not a setting.
- **No keystrokes are typed.** The approval travels back through the same
  hook that asked, as a decision the agent understands. Nothing is injected
  into your terminal and nothing can land in the wrong window.

## 11. You ask it · C

- *"What's it doing?"*, *"did the tests pass?"*, *"what's it blocked on?"*,
  *"how long has it been going?"*, *"which repo is talking?"* — answered from
  the live status board, in a sentence, without interrupting the agent.
- Answered locally by rules with no model and no network, and it is good on
  its own. Optionally by a Claude model, streamed so the first words arrive
  early.
- It **cannot see your repository**, and says so rather than inventing a file.
  *"Can't see that from here, want me to ask it?"*
- Social turns are social. *"Thanks"* gets a word back, not a summary of a
  repository.

## 12. You tell it · C

- *"Add a retry to the fetch call."* An instruction goes to an agent that can
  take one, in the repo you named or the one that is talking.
- **At a turn boundary**, the app can hold the session open for a couple of
  seconds and hand your spoken reply back as the next instruction. Hands-free
  back and forth, no keystrokes. Off by default, because it is the one place
  the app can slow the agent down.
- **In a repo you registered**, the app can start a headless session with no
  terminal at all. Its events land in the same narrator, its permission
  questions come to your voice, and it is capped so it cannot eat the
  machine.
- **Control words go nowhere near an agent.** "Stop", "quiet", "louder",
  "repeat", "switch to the API repo", "shut down": matched first, handled by
  the app, never delivered as a prompt.

## 13. Control by voice · C

- *"Stop."* It stops mid-word.
- *"Quieter"*, *"go verbose"*, *"silent"*: mode changes.
- *"Repeat that."*
- *"Switch to storefront."* Which agent you are talking to.
- *"Shut down."* Exact phrases only. It says goodbye, waits for the goodbye to
  finish, then takes everything down.

## 14. Other languages · later

The narrator's register and control words are English first. Arabic and
Turkish are next, and each needs its own control-word table and question
shapes before the open mic is safe in that language. The cloud voice rung
already speaks them; the local rungs pick up a voice per language.

## 15. The Companion · later, opt-in, the paid tier

Off by default and off means off: nothing is loaded. On, the voice you talk
to gains a memory and a mind of its own, within limits that are code.

- **Brainstorms.** *"What do you think about yearly billing?"* escalates from
  the fast status head to a model with your context.
- **Remembers.** Tasks, notes, and what was said, in a local database that
  never leaves the machine.
- **Speaks first, with manners.** An agent left waiting, failing tests sitting
  idle, an overdue task, a morning briefing. Behind a budget per hour, quiet
  hours, and a rule never to talk over you or over queued speech.
- **Offers work.** *"Want me to kick off the test fix?"* A yes starts it. One
  live offer at a time, and a real agent's permission question always
  outranks the Companion's own offer.
- **Reaches your services.** Calendar, email, whatever you connect, in the
  same configuration shape Claude Code uses. Reads are free. **Anything that
  changes the world is a proposal**: it is spoken, it waits for your yes, and
  a send without an accepted proposal fails the build, not a warning.
- **Its hands stay tied.** The Companion cannot run shell commands or write
  files itself. Development work goes through a real agent, narrated and
  permissioned like everything else.

## 15b. The board and the Room · A

The Room is the default window: the spoken line large and low, the orb, the
agents as dots, and the board, a canvas you pan and zoom with one labelled
frame per repo. The agent pins what words can't carry: a diff to approve, a
failing test's lines, a table, a picture, a sandboxed page, an SVG it drew,
or a diagram written as boxes and arrows that the app lays out. Pins fade
with age; nothing on the board is editable; every action is a phrase. The
Control Room is one key away, and the whole thing is served to a browser
on a tunnel of your own for a second screen.

## 16. Privacy and safety, throughout

- **Everything local by default.** Speaking, listening, deciding. The only
  things that reach a network are the rungs you opt into with a key, and the
  Companion, which is one explicit switch.
- **Loopback only.** The app listens on 127.0.0.1 with a per-machine token.
  It can speak and it can approve tool calls, so it is never exposed on a
  network interface. Phone access, when it comes, is through a tunnel you
  set up, never an open port.
- **No account. No telemetry.** Crash reports are opt-in and scrubbed.
- **Keys in the keychain.** Redacted from every log line, with a test.
- **Nothing recorded.** The mic buffer is a few seconds of ring memory and is
  discarded the moment a sentence is judged not addressed to it.
- **The voice you clone is yours.** The reference clip stays on your machine;
  only the clone id does not.

## 17. Uninstall · B

Removes the hooks it added and nothing else. Removes the app. Asks whether
to remove `~/.kikoe`: settings, models, the Companion's memory. Says
goodbye first.
