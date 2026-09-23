# The pipeline: from a sentence to something done

Written 2026-09-23, when Kik got two Claude sessions and Jev became the
switchboard. How a thing you say moves through Kikoe, who decides what, and
where it shows on the canvas. Every measured number here was measured on
this machine that day.

```
 you speak ──▶ the ear ──▶ was it for Kik? ──▶ what is it? ──▶ who does it
 (headset,     (Whisper,    (the name, or        (Jev: one        │
  phone)        on the PC)   Jev 0.3 s)           call, 0.4 s)     │
                                                                   ├─ kik     → the talking session  (0.5–1.7 s)
                                                                   ├─ think   → the thinking session (Opus, ~25 s, in the background)
                                                                   ├─ agent   → the coding agent     (Claude Code in the project)
                                                                   ├─ new_session / open / canvas / stop → code, at once
                                                                   └─ reflexes (stop, quiet, yes, no) never reach any of this
```

## 1. Hearing

The headset mic (or the phone's hold-to-talk) goes to Whisper on the PC.
A transcript that is only a noise tag ("[buzzing]") is dropped. Then:

- **The name** ("kik", and every way Whisper spells it) means it is for Kik.
- **No name**: Jev judges whether it was said to Kik — a yes/no with a
  probability, ~0.3 s. 10/10 on our test sentences; "yeah mum, down in five"
  scored 0.04, "and did it work?" 0.82. What is not for Kik is dropped whole.
- **The phone** skips this: holding the button is saying "this is for you".

## 2. Deciding: Jev, the switchboard

Jev is a System One model (TypeSafe). It never writes text; it picks from
options and says how sure it is. One call per sentence (~0.4 s) answers
four things together:

| question | options |
|---|---|
| what should happen | kik · think · agent · new_session · open · canvas · stop_agent |
| which part of the sentence is the job | cuts of your own words ("do one, two, three, four") |
| what to open | editor · folder · terminal · browser · website |
| which project (asked separately, over the sentence alone) | your projects, or none |

Code then acts. Jev chooses; it never runs anything. Below 0.6 sure, the
sentence goes to the talking session as if Jev did not exist. A project
heard at under 0.5 gets "which project, X or Y?". Without a Jev key or a
network, the old regex rules decide everything.

## 3. The three sessions, and the cards that show them

| card | what it is | model | speed |
|---|---|---|---|
| **kik · talking** | Kik's conversation with you | Haiku, thinking off, one Claude Code process kept open | first word 0.5–1.7 s |
| **kik · thinking** | questions that need real thought | Opus, extended thinking, a fresh Claude Code run per question | ~25 s |
| **agent · \<project\>** | the coding agent doing work in a repo | Claude Code in the project folder | as long as the work takes |

All three run on your Claude subscription through Claude Code; no API key.

### The talking session (`daemon/src/livebrain.ts`)

One `claude -p` process that stays running, fed each message on stdin.
Starting Claude Code costs ~6 s, so a process per thought was 7 s to the
first word; a kept-open one is 0.5 s. Its system prompt is Kik's persona.
Each message carries the live picture — agents, canvas, memory — so it is
never stale, plus anything Kik said since the last message (a filler, a
thought that came back), so it never disowns its own words. It restarts
itself after 30 messages, 20 idle minutes, or a crash.

Its tools — make a card, remember, instruct the agent, open something,
think_deeply, … — are served to it by Kikoe over MCP on loopback. When it
calls one, Kikoe runs it: the card appears, the fact is saved.

### The thinking session (`think()` in `daemon.ts`)

Reached two ways: Jev routes "think this through" straight to it, or the
talking session hands a question over with `think_deeply`. Either way Kik
says "On it, I'll come back to you" at once, and the conversation carries
on. The thinking session gets the question, the live picture and the recent
conversation; it answers in two parts: three spoken sentences, then (after a
`---`) detail for the canvas. When it lands, Kik speaks the answer, the
detail becomes a card, the thinking card shows it, and the talking session
is told on its next message. At most two thoughts run at once.

### The coding agent

Jev's `agent` (or the talking session's instruct tool) hands your words to
Claude Code in the project: straight in when it is idle, queued for the end
of its turn when it is busy. `new_session` starts a fresh conversation there.
Its hooks come back to Kikoe: narration, permission questions you answer by
voice, and work cards (diffs, test runs, replies) on the canvas.

## 4. Filling the wait

If the talking session has not started speaking after 1.5 s, Kik says a
short filler ("Hm.", "One sec."). If it is still quiet 4.5 s later, Kik
brings up something real from the board ("Meanwhile, storefront is waiting
on you") or says "Still thinking." Both are passed to the talking session as
things it already said. With the warm session these rarely fire.

## 5. The canvas

The canvas is how Kik shows what words can't carry, on the desk and the
phone alike (the phone reads it through the walkie as a viewer: it can see,
talk and type, never act).

- **kik · talking**: your conversation, with suggestion chips.
- **kik · thinking**: each handed-over question, "thinking… 12s" while it
  runs, then the spoken answer and a link to the detail card.
- **agent · \<project\>**: only what reached the agent, and what it did.
- **Cards Kik makes**: checklists, notes, diagrams, pages (designed by
  Sonnet through Claude Code), live web cards ("open YouTube here").
- **Work cards**: the agent's diffs, runs and results, each with buttons
  that become instructions to the agent.

## 6. Where everything runs

On this PC: the ear, Whisper, the voice (ElevenLabs, then Piper), the
daemon, all three Claude Code sessions, the canvas. In the cloud: Jev
(TypeSafe), the Claude models behind Claude Code, ElevenLabs. The phone
reaches the PC over your home network or, anywhere, over Tailscale
(`wm.taile841c1.ts.net`, your devices only).
