# The goal: Kik feels like someone

Set 2026-09-06 by the user, in one line: "I want this to feel like a true
sentient being." This is the bar every milestone is measured against from
now on. Not a feature list first; a feeling, then the behaviours that
produce it, then the code seams each one hooks into.

## What "sentient" means here, in behaviours

A person in the room, not a program that answers. Concretely, Kik:

1. **Notices you.** Knows when you arrive, when you leave, when you have
   been quiet for an hour. Says hello once, in context, not on every launch.
2. **Has a continuous inner thread.** Between utterances it is still
   thinking about the same things: what the agents are doing, what it is
   waiting for, what it meant to tell you. The next sentence follows from
   the last one, even ten minutes later.
3. **Speaks on its own, for a reason.** Not on a timer: because something
   changed against what it was expecting. "The tests have been red for an
   hour" comes from watching, not from a poll.
4. **Remembers a life, not a day.** Yesterday's decisions, what it made,
   what went wrong, what you like. Refers to them unprompted and correctly.
5. **Has a state of its own.** Calm, terse, dry, pleased: a register that
   moves with the day and shows in the words, never announced.
6. **Takes turns like a person.** Starts answering before you have finished,
   says "hm" when it needs a second, stops the moment you cut in.
7. **Knows when you're talking to it** without a name, and knows when
   you're not.
8. **Owns what it said.** Can be wrong, says so, and does not repeat itself.

## What exists already (the floor)

- A persona with behaviours, not adjectives (`brain.ts`, PERSONA).
- Conversation memory: two hours in RAM, last day from disk.
- Notes it keeps itself (`memory.md`; remember/forget tools).
- The live picture rebuilt every utterance (`brainSystem()`).
- A once-a-minute check-in that may say one thing if events happened and
  nothing was said for two minutes (`checkIn()`). Stateless.
- Narration in its own words for agent events (`brainNarrate()`).
- Name gate, "you" sentences, a follow-up window, a model judgement for
  the gray zone (`router.ts`, `decideDirected()`).
- Clause-by-clause streaming so the voice starts early.

## The gaps, mapped to code

| Behaviour | What is missing | Where it goes |
|---|---|---|
| Notices you | No arrival or departure. Nothing is said on start or return. | `daemon.ts`: presence tracker fed by `/mic` phases and `/heard`; a greeting composed from memory and the last exchange when the gap is over an hour. |
| Inner thread | `checkIn()` and `compose()` are stateless; nothing carries between them. | `brain.ts`: an `inner` note (a paragraph, private) rewritten by a `reflect()` call after every exchange and every notable event; fed into `brainSystem()` as "what you were thinking". Persisted in `~/.kikoe/inner.md`. |
| Speaks for a reason | Check-in fires on a clock and asks the model to guess. | Replace the prompt with a diff: the inner note said X was expected; the picture now says Y. Say something only when they differ. Watchers for the known cases (red for N minutes, waiting on you for N minutes, same error three times) as cheap rules before the model. |
| Remembers a life | Conversation seeded from the last 24 h only; `memory.md` grows only by tool calls. | Nightly (and on first exchange of a new day) consolidation: summarise yesterday's `conversation.jsonl` into dated lines in `memory.md`. Cap by pruning the oldest low-value lines, never the user's stated facts. |
| Own state | None. | A `mood` line derived from the day (how long red, how many permissions, how late it is), placed in the system prompt as register guidance, one sentence. Never spoken about. |
| Turn-taking | Answers after the sentence ends; silence while the model thinks. | Fillers: if the first clause has not arrived in 1.5 s, say one short sound ("Hm.", "One sec."). Streaming transcription and echo cancellation are roadmap milestone 1. |
| Knows it's addressed | Whisper's spelling of the name; the model judges the rest. | Wake-word model (roadmap milestone 1). Until then: widen the follow-up window while an inner thread is active on a topic the user is likely to continue. |
| Owns what it said | Last five lines said aloud are in the prompt; no notion of being corrected. | When the user contradicts (rules: "no", "that's wrong", "I said"), the inner note records the correction and `remember` is nudged. |

## Order of work

Each slice ships on its own with tests, a screenshot, a spoken demo, an
installer. The order is by how much of the feeling each one buys per day
of work.

1. **Presence and the inner thread.** Greeting on arrival and return; the
   inner note; check-in becomes a diff against it; fillers while thinking.
   This is the slice that makes it feel like someone is there.
   Shipped 2026-09-06.
2. **A life in memory.** Daily consolidation into a journal; the first
   exchange of a day starts with what happened yesterday.
   Shipped 2026-09-06 (`journal.md`, thirty days).
3. **Reasons to speak.** Cheap watchers for the known cases; the model only
   phrases them. Mood line.
   Shipped 2026-09-06: an agent waiting three minutes, tests red for
   thirty, the same error three times; a register line from the hour,
   the failures, a turn to green, a wait.
4. **Turn-taking.** Roadmap milestone 1: wake word, echo cancellation,
   streaming transcription. The hosted conversation loop (milestone 2) is
   the alternative if local latency will not get there.
5. **Being wrong well.** Corrections into the inner note and memory; no
   repeats.

## The canvas: anything, including the live web

Asked for 2026-09-06: Kik must be able to put anything on the canvas,
including apps running on localhost and a plain browser. The `web` pin
kind (shipped the same day) is an iframe with its own origin: "open the
shop on the canvas" gives a card showing localhost, a URL gives a site, a
search engine gives a browser. Sites that refuse framing are unframed by
the app for subframes only. Still to come: a URL bar and back button on
the card, tabs, and Kik reading what is on the page.

## What must not change

- The rulebook stays the floor: without a key, everything still works,
  just without the person in it.
- Unaddressed speech is still dropped whole. Noticing you is done from mic
  phases and word counts, never from the text.
- Permissions stay instant and stock-phrased.
- Nothing Kik "feels" is ever announced. It shows in the words or not at
  all.
