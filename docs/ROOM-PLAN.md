# The Room — plan

The voice-first control room, as decided on the design canvas
(2026-09-05): **The Room** as the default state, **The Board** on it when the
agent has something to show, the **Control Room** one phrase away, and the
**orb** as the voice you talk to. Nothing on any of it is editable; every
action is a phrase (or, until the mic lands, a click on the same words).

Status is real: an item is done when it is in the app and used for a day.

## What it is

```
  the Room window (a normal window, dark, can go full screen, lives on the
  second monitor or an iPad through the same stream)
  ├── the spoken line      large serif subtitle; earlier lines fade upward
  ├── the orb              idle · listening · speaking · needs you
  ├── the agents           dots along the bottom; lit only when they need you
  ├── the board            pins the agent pushed: diff, markdown, table, image,
  │                        text, sandboxed html. One region per repo. They fade.
  └── the control room     one phrase ("show me the board"), one key (C):
                           lanes per agent, what it said, what you said
  the island stays exactly as it is.
```

## The contract: `/show`

The agent's whiteboard, beside `/speak`. Same auth, same curl config shape.

```
POST /show                      body: the content (text/plain or JSON)
  X-Kikoe-Kind:  markdown | diff | text | table | image | html | svg | diagram
                 (default text). `svg` is sanitised and rendered inline so it
                 scales and takes the theme; `diagram` is boxes and arrows
                 (`a -> b`, `*current`, `note:`) laid out and rendered to SVG
                 by the daemon.
  X-Kikoe-Title: short title
  X-Kikoe-Repo:  which region; defaults to the last session that spoke
  X-Kikoe-TTL:   seconds before it fades (default 900)
  X-Kikoe-Ask:   "apply,no"   turns the pin into a question: the request is
                 HELD OPEN until the user answers by voice or click, or the
                 timeout passes; the answer is the response body. This is
                 how `kikoe show --ask` returns "apply" to the agent.
→ { ok, id }   or, when asked, the answer as text ("apply" | "no" | "")
GET  /pins                      the board as it stands
POST /pins/<id>/answer          { answer }   from the Room, or from a voice yes
POST /pins/clear                "clear the board"
hub frames: pin { op: add | answer | remove | clear, pin }
```

Rules, in code: at most 24 pins; the oldest of a repo goes first; a pin
never outlives its TTL; `html` renders in a sandboxed iframe with no
scripts; images are data URLs or local files, never fetched; a held
`/show` denies on timeout like a permission does. The narrator's silence
rule applies: the output style tells Claude what earns a pin (a diff to
approve, a failure with lines, a diagram that explains a decision, a
before-and-after), and the evals will hold it to that.

## Milestones

**R1 — the Room narrates · this week** · *first cut running 2026-09-05*

1. [x] `pins.ts` in the daemon: store, TTL, per-repo regions, the held ask.
2. [x] `/show`, `/pins`, `/pins/<id>/answer`, `/pins/clear`; `pin` hub frames.
3. [x] `kikoe show` in the CLI (file or stdin, `--kind`, `--title`, `--ask`,
       `--ttl`), and `show.curlrc` written by the app for the output style.
4. [x] The Room window: spoken line, fading history, the orb with four
       states driven by hub frames, agent dots, pins with regions and fade,
       answer buttons on asked pins, C for the control room, Esc to clear
       the selection, "clear the board" from the tray.
5. [x] The orb component, CSS only, in the Room and, at pill size, on the
       island. The island is rebranded: paper on ink, ember, no green.
6. [x] Output style and the speak skill carry the board section with the bar.

**R2 — the ear · landed first cut 2026-09-05**

1. [x] The mic runs in its own process (Electron utility process): audify at
       16 kHz mono, Silero VAD, Whisper base English on CPU through
       sherpa-onnx, `POST /heard` per utterance, `POST /mic` for phases.
       Nothing recorded: segments live in memory until transcribed.
2. [x] The name gate in `core/router.ts`, fails closed; the misspellings
       Whisper produces for "kikoe" are aliases; a bare yes or no is allowed
       without the name only while something is waiting on an answer.
3. [x] Control words never reach an agent: stop, pause, resume, modes,
       clear/show/hide the board, repeat, switch to a repo, shut down.
4. [x] The rules head in `core/head.ts` answers what's it doing, did the
       tests pass, how long, what's waiting, from the tracker.
5. [x] Half duplex: a transcript that echoes the line just spoken is dropped.
6. [x] Settings: the toggle, the device (by name fragment), the wake name;
       tray: start/stop listening; doctor: phase and device; the Room and the
       island show hearing, heard you, overheard, thinking.
7. [ ] Soak with a real voice. First run: Whisper loads in 664 ms, the
       HyperX headset opens at 16 kHz, the input reads silent until someone
       speaks into it.
8. [x] Lanes with "what you said" (the heard log, with kind, answer and
       STT time) beside "what it said".
9. [x] The board is a canvas: pan by drag or scroll, zoom by pinch or
       control-scroll, fit, one labelled frame per repo, pins draggable.
       Laid out as direction E on the design canvas.

**R2b — looks · 2026-09-05**

1. [x] Frameless windows with the native controls overlaid on a bar of our
       own (Room and Settings).
2. [x] Light mode: paper ground, ink text, the same ember; follows the
       system by default, a switch under General. Island included.
3. [x] Vector tools: `svg` and `diagram` kinds on the board, with the bar
       for them in the output style.

**R3 — the second screen · first cut 2026-09-05**

1. [x] The daemon serves the Room at `/room?token=…` with a browser shim
       in place of the preload, fonts included, no path escape. The tray
       copies the link. Loopback only; the tunnel is the user's.

**R3 — the second screen**

1. [ ] The Room served to a browser on the LAN through a tunnel the user
       sets up, read-only: an iPad on the desk. Loopback-only stays the
       rule for the daemon; the tunnel is the user's.

### Measured, first cut

- A diff pinned with `X-Kikoe-Ask: apply,no` held the request open; a
  spoken "yes" six seconds later released it and `show --ask` printed
  `apply`. A bare yes goes to a real permission first, then to the board.
- Pins render as text nodes (diff, markdown, table), an image, or a
  sandboxed frame; nothing from the agent is ever parsed as HTML outside
  the sandbox.
- The three typefaces are bundled with the app as woff2 (184 KB).

## What will go wrong

| Failure | Constraint |
|---|---|
| The board becomes a junk drawer | TTL on every pin, 24 max, oldest-per-repo eviction, "clear the board" |
| The agent pins everything | The output style's bar, and silence fixtures in the evals |
| A pin runs script | `html` only ever in `sandbox=""`; markdown and diff are rendered as text nodes |
| The Room grows a text cursor | It has none. Editing happens in the agent's terminal, always |
| Two questions at once | One held ask at a time, like permissions; the second waits |

## One window (2026-09-06)

Kikoe is one window. The Room is what it shows; the Control Room and
Settings are views inside it (the `C` key and the title bar, or the tray),
never separate windows. Settings was rewritten around the Room: start here,
voice, listening, narration, Claude Code, the board, screens (viewer link
and the link that can answer), look and startup, doctor. The old settings
renderer and its preload are gone; the Room's preload carries the settings
API. `--screenshot <path>` now also writes `<path>-settings.png`.

## A mind of its own (2026-09-06)

`packages/daemon/src/brain.ts`: Claude in the head, plain fetch against the
Messages API, streamed clause by clause into the voice. Everything addressed
to Kik that is not a reflex (stop, quiet, yes, no) goes to it with the live
picture: agents, what is waiting, the board, what was last said. Tools:
approve, deny, answer the board, set the mode, clear the board, pin a note,
and `instruct_agent`, which queues the user's words and hands them to the
agent through its next Stop hook (`decision: block` with the instruction as
the reason) or as context on the next prompt. With `brain_narrates` the
model phrases milestones, errors and endings itself; permissions stay stock
so they are instant. With `brain_checkin` it may say one thing unprompted
when things have happened and nothing has been said for two minutes. The
rulebook remains the fallback when the model is unreachable and the whole
thing when there is no key. Key in the OS keychain (`anthropic_key.enc`) or
`~/.kikoe/anthropic_key.txt`. Only what is addressed to Kik leaves the
machine.
