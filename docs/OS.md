# Kikoe as the operating system

Asked 2026-09-07, in one line: *"what if kikoe becomes the actual operating
system of the laptop or pc."* This is the concept document that answers it.
Written against the code at commit `10cd959`, not from memory: every claim
below about what exists was checked in the source, and the file references
are there so the next session can check them again.

It is not a new question. Day one already set the frame, in
`docs/REVIEW-2026-09-05.md`:

> **Kikoe is not a tool. It is an operating environment for productive,
> creative people.**

And on 2026-09-07 `Astra.md` researched the missing half — a machine Kik can
actually operate — and stopped one library rename short of building it. This
document joins those two and says where the road goes.

## The answer, before the detail

**Kikoe should not become a kernel. It should become the shell — and it is
already an operating system, just not for the human. It is one for the
agents.**

Finish that, take the human's shell only as far as it serves, and a bootable
KikoeOS becomes a packaging decision at the end rather than a rewrite at the
start.

---

## 1. What is already there

Kikoe implements the primitives of an operating system today. Not as a
metaphor stretched to fit — as the actual shape of the code.

| OS concept | Kikoe today | Where |
|---|---|---|
| process table | `IDLE / WORKING / WAITING / FAILED` per session, with repo, cwd, current tool, `running_for_s`, `quiet_for_s`, files touched, errors | `core/src/tracker.ts:25-43` |
| process reaping | sessions evicted after 15 min; a quiet `working` session demoted to `idle` after 120 s — a zombie reaper | `tracker.ts:195-204` |
| preemptive scheduler | five priority levels, strict priority with FIFO tiebreak, `AbortController` preemption at attention grade, then the queue flushed below it | `core/src/arbiter.ts:121-197`, `core/src/events.ts:55-63` |
| rate limiting, QoS | per-session token bucket (burst 4, refill 10 s), a 4 s floor between progress lines, TTL staleness, queue cap 64 | `arbiter.ts:19-24, 207-226` |
| head-of-line blocking | a permission utterance blocked by the binding is **held and re-prepended**, not dropped | `arbiter.ts:211-235` |
| syscalls | sixteen brain tools | `daemon/src/daemon.ts:1408-1753` |
| a public syscall ABI | around twenty-five HTTP routes: `/state`, `/speak`, `/show`, `/say`, `/answer`, `/permission` and the rest | `daemon.ts:2119-2345` |
| capabilities, `sudo` | the held-open `PermissionRequest`: the `ServerResponse` is stashed unanswered and the agent's `curl` blocks on the socket | `daemon.ts:90-97, 2151-2169` |
| IPC | instructions routed into an agent's Stop hook | `daemon.ts:1435` |
| filesystem | the board (24-pin cap, repo-aware eviction, sticky survives restart), `memory.md`, `journal.md`, `inner.md` | `daemon/src/pins.ts` |
| device drivers | the TTS ladder, the ear, the usage providers | `daemon/src/tts.ts`, `app/src/mic.ts`, `daemon/src/usage.ts` |
| the shell | your voice | `core/src/router.ts` |
| init and watchdog | the daemon on 4570, restarted in place on `uncaughtException` with a crash budget | `app/src/main.ts:133-186` |

That is a scheduler with preemption, quality of service and priority-inversion
handling; a process table with reaping; a syscall surface; and an approval
mechanism that blocks its caller. Kikoe is further along as an operating
system than it looks, because the operating system it built is for the agents,
not for the person.

## 2. What is actually missing

Not a kernel. **Hands and eyes.**

The whole of `packages/` was searched for any ability to act on the machine
outside the Claude Code hook loop. The complete surface is:

- four `execFile` call sites, every one with fixed argv — `icacls` on Kikoe's
  own key files (`daemon/src/hooks.ts:99`), `tar` for model unpacking
  (`daemon/src/models.ts:135`), and PowerShell `System.Speech` as the
  last-resort voice (`daemon/src/tts.ts:401`);
- `shell.openExternal(url)`, guarded to `^https?://` (`app/src/main.ts:561`);
- `shell.openPath` on two hardcoded paths under `~/.kikoe`;
- `clipboard.writeText` with fixed content. No `readText` anywhere.

Zero matches for window enumeration or focus, keyboard or mouse synthesis (no
`robotjs`, no `nut-js`, no `sendInput`), `globalShortcut`, `desktopCapturer`,
or any generic exec. Screen capture exists only as `capturePage()` on Kikoe's
*own* window, inside the `--smoke` branch. File writes are confined to
`~/.kikoe`, plus `~/.claude/settings.json` for hook installation and one
`showSaveDialog` path.

So Kik can speak, draw on its own canvas, answer a permission, queue an
instruction, and open a URL. That is the entire actuation surface. It is
exactly why it still says *"I can't take instructions yet. Say it to the
terminal."*

## 3. Why this is the right ambition

The moat of an operating system is not the kernel. It is the **system model**
— the nouns the person thinks in.

Windows' nouns are files, folders, windows, apps. Kikoe's are repos, agents,
cards, concerns, the journal, memory. Kikoe is already a different operating
model running as a guest. Becoming "the OS" means making its nouns the primary
ones: you stop thinking in paths and start thinking in what you are working
on.

That is the product bet, and it is independent of whether a kernel is ever
written.

---

## 4. The ladder

Each rung is useful on its own, ships on its own, and is reversible.

- **L0 — today.** Ears, voice, canvas, agents, memory, limits.
- **L1 — hands and eyes.** Kik can operate this machine: open apps, focus
  windows, press keys, read the screen. `Astra.md`'s Piece A, folded into Kik
  rather than run as a second listener with a second wake word.
- **L2 — the canvas eats the desktop.** Every open window becomes a live card.
  Kik replaces Alt-Tab, Start and Explorer in practice. Windows still boots
  underneath; you stop looking at it. The rung where it *looks* like an OS.
- **L3 — launch and find.** Files and work by meaning, not by path — "the
  invoice from the tiler", not a path. The journal and memory are already the
  index for this, and nothing else on the machine has that context.
- **L4 — the session.** Literal shell replacement: `Winlogon\Shell` points at
  `kikoe.exe` instead of `explorer.exe`. Behind a flag, with an escape hatch
  back to Explorer that works from a dead machine.
- **L5 — KikoeOS.** A bootable image: Linux, a compositor, Kikoe as the only
  client. A packaging decision taken last, and only if strangers ever flash
  it.

Day one's warning stands and is respected here:

> An OS is built one used surface at a time, not by drawing the whole thing
> first. […] Do not draw the whole OS on the canvas before the next surface is
> used.

So the ladder above is a **map**, not a build order. Only the gate and L1 are
scheduled.

---

## 5. The gate

Today a Kikoe failure is an annoyance. As a shell it is a bricked laptop.
Three things must be true before Kik touches the machine.

### Gate 1 — the ear can never stay dead

This is the real hole, and it is worse than `docs/AUDIT.md` says.
`app/src/main.ts:246-251`:

```ts
ear.on("exit", (code) => {
  log(`mic process exited ${code}`);
  ear = null;
  if (daemon) daemon.micPhase = code === 0 ? "off" : "dead";
  buildTrayMenu();
});
```

It records `dead` and redraws the tray. `startEar()` is called from exactly
three places — the tray toggle (`main.ts:422`), a settings change
(`main.ts:699`), and app start (`main.ts:1087`). **There is no supervisor, no
backoff, no respawn.** A mic crash silently ends voice input until the user
notices. That is precisely what happened on 2026-09-06.

What it needs: a supervisor with backoff; Kik says *"I lost the mic, back in a
second"*, and *"I can't hear, check the headset"* after three failures; the
doctor says it in words a person would use.

### Gate 2 — the watchdog needs a mouth

The daemon watchdog already exists (`main.ts:152-186`): crashes inside a 60 s
window are counted and the daemon is restarted in place. Two gaps remain.

- `if (crashTimes.length > 2) { log("too many crashes in a minute; leaving the
  daemon down"); return; }` — it gives up **silently, to a log file**. The one
  moment the user most needs telling, nothing is said.
- The handlers sit on `uncaughtException` and `unhandledRejection` for the
  whole main process, so any main-process fault is attributed to the daemon.

Scope: make giving up audible and visible, and tell daemon faults from
main-process faults. Much smaller than moving the daemon out of process.

### Gate 3 — a real capability model

There is none. Permissions are a binary allow/deny on one opaque id, depth-1 —
`daemon.ts:2152` has a new request **deny the outstanding one** — with no
scope, no rules, no persistence. The only scope-like construct in the codebase
is the `full` / `viewer` token split at `daemon.ts:1955`, and that is transport
auth, not agent capability.

`Astra.md`'s own Risk 1 is honest that skipped permissions plus a mouse will
eventually click something expensive. The rule:

| class | behaviour |
|---|---|
| reads — `screenshot`, `ui_tree`, `list_windows` | free |
| writes — type, click, launch, file write | held at the permission hook |
| delete, send, publish, purchase | always ask, never auto-approvable |

Reuse the existing hook verbatim; do not invent a second approval path. It is
the best-tested thing in the product. Two of its properties are worth
preserving deliberately:

- denial writes an **empty body** (`daemon.ts:500`), so Claude Code falls back
  to its own on-screen prompt rather than hard-failing;
- `lastPermissionId` is bound by the arbiter *before the first word is spoken*
  (`arbiter.ts:272`), which is what stops a spoken "yes" landing on the wrong
  question.

The depth-1 slot should become a real queue as part of this. It is already
AUDIT gap 4.

---

## 6. L1, in enough detail to build

### No new native module

`packages/daemon/package.json` carries exactly two — `audify` and
`sherpa-onnx-node` — and `docs/HANDOVER.md` documents that this is precisely
where builds break silently: under `npx`, electron-builder drops them from
`app.asar.unpacked` and the ear dies with "Cannot find module
'sherpa-onnx-node'". A third native addon buys a third way for the installer
to fail.

Windows gives all of `Astra.md`'s Piece A through **PowerShell plus inline C#
(`Add-Type`)**, with no compiled dependency. There is already precedent in the
codebase: `daemon/src/tts.ts:390-401` shells to PowerShell with `-Command` and
an established quote-escaping pattern (`text.replace(/'/g, "''")`).

| capability | mechanism |
|---|---|
| `open_app`, open a file, folder or URL | `Start-Process` |
| `list_windows` | `Get-Process` → `MainWindowTitle`, `MainWindowHandle` |
| `focus_window` | `user32!SetForegroundWindow` via `Add-Type` |
| `type_text`, `press_key` | `System.Windows.Forms.SendKeys` |
| `screenshot`, window capture | `System.Drawing` `CopyFromScreen` |
| `ui_tree` | `UIAutomationClient` via `Add-Type` |
| `run_powershell` | directly |

### Shape it like the ear

`app/src/mic.ts` is already an isolated `utilityProcess.fork` that talks to the
daemon over loopback HTTP with the bearer token, with no IPC channel. Add
`app/src/hands.ts` on the same pattern, holding **one long-lived PowerShell
host** over stdin and stdout — a fresh `powershell.exe` per call costs 200 to
500 ms and would make Kik feel slow. It inherits the supervisor built for
Gate 1.

### The tree before the pixels

The UI Automation tree gives Kik the semantic contents of any Windows app —
buttons and fields by name — for almost no tokens. Screenshots are the
expensive, imprecise fallback. Hotkeys and PowerShell beat clicking wherever
both work. `Astra.md` reaches the same conclusion from the other direction.

### Fold Astra in, do not run it alongside

`Astra.md` as drafted adds a *second* thing that hears you, with a second wake
word and a second speech model — its own Risk 2. Kik already hears, already
knows when it is being addressed, already speaks, already shows. **It needs
hands, not a twin.** The two draft scripts in `C:\Users\USER\astra\` become
reference material; the capability lands as tools seventeen and up, next to
`approve` and `instruct_agent`.

---

## 7. Notes for L2, recorded now

The web-card plumbing is more reusable than expected: the same iframe path
already serves `web`, `html` and `react` pins
(`app/renderer/room/room.js:384-400`), with viewport presets, an
open-in-browser button and sticky persistence for free. Three things do not
carry over, and should be settled before anyone plans L2.

- **A native window is not a URL.** `room.js` renders `web` by setting
  `iframe.src`. A live VS Code card needs a new pin kind fed by captured
  frames, not an iframe.
- **`MAX_PINS = 24`** (`pins.ts:28`), with repo-aware eviction. "Every window
  becomes a card" collides with that cap directly.
- Header stripping (`main.ts:346-363`: `x-frame-options` dropped and
  `frame-ancestors` excised, `subFrame` only, on the `roomWin` session only) is
  **Electron-only**. The browser-served Room on a second screen cannot do it.

---

## 8. Order of work

Nothing here jumps the gate.

1. **This document**, referenced from `CLAUDE.md` beside `SENTIENCE.md`, with
   `ROADMAP.md`'s milestones re-hung under it.
2. **Gate 1** — the mic supervisor, with spoken failure lines and the doctor in
   plain words.
3. **Gate 2** — give the existing watchdog a mouth; separate daemon faults from
   main-process faults.
4. **Gate 3** — the capability model, as a class every tool declares, wired to
   the existing permission hook; the depth-1 permission slot becomes a queue.
5. **L1** — `hands.ts` and the tool set above, off by default behind a setting,
   reads free and writes gated from the first commit.
6. Re-assess. L2 is a document of its own, written only after L1 has been used
   for a week.

Each lands the house way: `pnpm test`, `pnpm lint`, `pnpm typecheck`, a
screenshot, one spoken line, a commit with a paragraph of why and the
Co-Authored-By line, push, the installer built outside the repo under `pnpm
exec`, a silent reinstall, `/state` verified.

## 9. How each rung is verified

- **Gate 1:** `taskkill` the mic utility process. Hear *"I lost the mic"*, see
  `mic.phase` return to listening in `/state`, see it named in the doctor. Kill
  it three times; hear the give-up line.
- **Gate 2:** force three daemon exceptions inside a minute. Hear that it has
  given up, instead of finding it in `daemon.log` an hour later.
- **Gate 3:** tests that a write-class tool cannot execute without a permission
  decision, that delete, send and purchase cannot be auto-approved even with
  permissions relaxed, and that two permissions in flight are both answered
  rather than the first being denied.
- **L1:** with the headset on, through the installed app. *"Kik, open Notepad
  and write milk, eggs, bread"* — the window opens, the text appears, Kik says
  it is done. *"Kik, what's on my screen"* — answered from the UI tree with no
  screenshot. A denied write: *"Kik, delete that file"* — held at the
  permission hook, answered no by voice, nothing happens.

Tests keep `KIKOE_CLAUDE_DIR` and `tts: "none"`. Add `KIKOE_HANDS=off` to
`vitest.config.ts` on the same principle as `KIKOE_USAGE=off`, so no test can
ever move the real mouse or launch a real process.

---

## 10. What must never change

Carried from `docs/SENTIENCE.md`, and made stricter by the ambition.

- **The rulebook stays the floor.** Today, no key means no person but
  everything still works. As a shell it is the difference between a quiet
  computer and no computer. The day the Anthropic account ran out of credit
  was the drill, and it was passed.
- **Permissions stay instant and stock-phrased.** The model never sits between
  a permission and its answer — least of all when the permission moves a mouse.
- **Unaddressed speech is still dropped whole.**
- **Voice-first, never voice-only.** Nobody dictates a regular expression. The
  canvas and the keyboard stay.
- **Every rung is reversible.** Especially L4: a shell replacement that cannot
  be undone from a dead machine is not shippable.

---

## Appendix: drift found while writing this

- `docs/HANDOVER.md` says fourteen brain tools. There are sixteen
  (`daemon.ts:1408-1753`); `design_artifact` and `pin_note` are the two the
  count missed.
- `packages/app/electron-builder.yml` still tells macOS users the wake word is
  "hey Claude", in `NSMicrophoneUsageDescription`. Also noted in AUDIT §1.
