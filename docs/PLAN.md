# The port — plan

A clean second implementation of ClaudeTalks, built the way the project would
be built if it started today: one language, one binary, one audio runtime, no
sidecars, no PTY, macOS first, narration shipped alone before anything else.

Same rule as [PLAN.md](../PLAN.md): status is real. `done` means written,
tested, and run by someone who is not the author.

Written 2026-09-05. Effort estimates assume one person, most of their time.

## Why a port and not a rewrite

Three things carry the value of the current project, and all three transfer
without change:

- **The thesis and the register.** Severity-scored events, one mouth for many
  agents, silence by default, lead with the answer. VOICE.md, persona.yaml,
  BRAND.md move verbatim.
- **The evals.** `tests/evals/*.json` (12 narration fixtures) and
  `tests/evals/{impulse,fleet}/` (20 more) are runtime-agnostic. They are the
  acceptance contract for the port: the narrator is done when every fixture
  passes, including the ones that assert silence.
- **The rules that are code.** Proposals gate, false accepts at zero, unknown
  verbs escalate, hooks exit 0 and print nothing, a yes binds only to the
  last-spoken prompt. Each arrives as a test before the code it guards.

What does not transfer is the runtime it all runs in, and that is the point.

| Bucket | Lines today | Fate |
|---|---|---|
| Pure logic: events, tracker, narrator, arbiter, router, head, adapters, hook, scrub, pending, proposals, addressing | ~4,700 | **Port**, fixture-driven |
| Audio, TTS ladder, STT, VAD, CUDA, ducking, desktop, PTY wrapper, sidecars, voice loop | ~6,000 | **Replace** with one ONNX runtime |
| Companion, impulse, memory, briefing, foreman, headless | ~2,000 | **Port later**, behind the flag, Phase 3 |

## The three facts the plan rests on (verified 2026-09-05)

1. **Claude Code hooks can answer permissions.** `PermissionRequest` returns
   `hookSpecificOutput.decision: allow|deny`; `PreToolUse` returns
   `permissionDecision: allow|deny`. Command hooks block synchronously up to a
   per-hook `timeout`. `Stop` blocks the stop with exit code 2. So voice
   approval is: hook blocks, daemon speaks the prompt, user says yes, hook
   returns allow. **No PTY, no keystroke injection, no ConPTY.**
2. **`sherpa-onnx-node` ships prebuilt** for darwin-arm64, darwin-x64,
   linux-x64, linux-arm64, win-x64. One runtime for VAD (Silero), STT
   (Whisper, Parakeet, SenseVoice), and TTS (Kokoro, Piper/VITS, Matcha).
   No torch anywhere.
3. **Hook payloads shift between Claude Code versions.** Every field lookup
   stays defensive, and the dropped-events test travels with the adapter.

## Decisions to make before the first commit

- [ ] **Name.** Not built on the Claude trademark. Free to change now, expensive
      after the first user.
- [ ] **Shape.** MIT core as a library; the desktop app and Companion as the paid
      product. The repo layout below assumes this.
- [ ] **Freeze the Python repo.** Bug fixes for the author's own daily use only.
      No new features on `drum` from the day the port starts. Dual maintenance
      is the way ports die.
- [ ] **Develop on a GPU-less machine** for at least half the time. The 3090
      hid a CPU fallback for weeks. Users have laptops.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript, Node ≥ 20 | Claude Code users already have Node; `npx <name>` becomes a real install |
| Package manager | pnpm workspaces | Core-vs-app split from day one |
| Audio runtime | `sherpa-onnx-node` | VAD + STT + TTS, prebuilt, CPU-first, < 2 GB RAM |
| Audio I/O | `audify` (RtAudio, prebuilt) | Input and output streams, barge-in needs real streams not file playback |
| Cloud voice | ElevenLabs (BYOK): Flash TTS, Scribe STT | Best voice, no-GPU STT, multilingual |
| Floor voice | `say` / SAPI via PowerShell / `spd-say` | Speaks on a fresh machine with nothing downloaded |
| Head | rules first; `@anthropic-ai/sdk` later, cheapest fast model | A status answer is not a reasoning problem |
| Work executor | `@anthropic-ai/claude-agent-sdk` headless sessions | Already the design in `adapters/headless.py` |
| Tests | vitest | Fast, TS-native |
| HUD | the existing Electron island, moved | Already JS; points at the new daemon |
| App shell (Phase 3) | Electron (island promoted) or Tauri | Decide after Phase 2 on measured RAM |

**Native risk, prototyped on day one:** Node audio I/O is the weakest link in
this stack. Before anything else, a throwaway script must play a Kokoro line
through `audify` on a Mac and on Windows with an abort mid-utterance. If
`audify` fails, the fallback is a tiny native helper process, and that decision
is made in week one, not week six.

## Repo layout

```
<name>/
  packages/
    core/        events, tracker, narrator, arbiter, router, head-rules, scrub
                 — zero native deps, zero I/O, MIT, the library
    daemon/      HTTP server, adapters, hook endpoints, TTS ladder, audio
    cli/         `ct` bin, `hook.js` (node builtins only), install/uninstall
    island/      the Electron HUD, moved
  evals/         the JSON fixtures, shared by every package's tests
  .github/workflows/
    test.yml     mac + windows + linux, node 20 + 22
    cold.yml     clean runner: npx <name> install → demo --no-audio → doctor
    release.yml  publish on tag, npm provenance, changelog
```

The **hook rule** carries over exactly: `hook.js` imports Node builtins only,
POSTs, exits 0, prints nothing on stdout. Its startup is measured in CI and
fails the build above 80 ms. (Today's Python hook: ~130 ms.)

---

## Phase 0 — skeleton and the one risky prototype · **done 2026-09-05**

- [x] Working name `earshot` (free on npm and GitHub; rename is a find-and-
      replace on `@earshot/` and one package name). Repo, MIT, pnpm workspace,
      vitest, biome. LF pinned in `.gitattributes` because the first Windows
      write came out CRLF and biome refused it.
- [x] `test.yml` matrix: macOS, Windows, Linux × Node 20, 22.
- [x] `cold.yml` written and **red**: it calls `install`, `demo`, `doctor`,
      `uninstall` and `bench hook`, none of which exist yet. It is the target.
- [x] `release.yml`: tag → lint, typecheck, test, build → npm publish with
      provenance → GitHub release.
- [x] Copied verbatim: `evals/` (12 narration + 20 impulse/fleet fixtures),
      VOICE.md, persona.yaml, brand/.
- [x] **Ported ahead of schedule:** events, the register (`scrub`), the
      narrator, the Claude Code adapter. **All 12 narration fixtures pass**,
      with the register invariants (speakable, no robot tells, ≤ 20 words a
      sentence). The clock is injected, so the settle fixtures jump time
      instead of patching a global, and the leak that bit the Python suite
      cannot recur.
- [x] Prototype: sherpa-onnx → audify, mid-line abort, Windows. Mac is owed.

### Prototype numbers (Ryzen 9 5900X, CPU only, default output device)

| Backend | Threads | Load | Time to first audio | RTF | Verdict |
|---|---|---|---|---|---|
| Kokoro **int8** en v0.19 | 2 | 0.98 s | **1.79 s** | 1.46 | rejected |
| Kokoro int8 | 6 | 0.98 s | 1.61 s | 1.30 | threads don't help |
| Kokoro **fp32** en v0.19 | 6 | 0.86 s | **0.40 s** | 0.33 | **the quality rung** |
| Piper en_GB alan medium | 2 | 1.0 s | **0.06 s** | 0.045 | **the fast rung, and the default** |

- The int8 Kokoro file is four times slower than fp32 on this CPU. Quantised
  ops are not a free lunch on onnxruntime's CPU provider. Ship fp32 (353 MB)
  for the quality rung; never int8.
- Piper matches the Python-era measurement (RTF 0.036 there) through Node.
  It is the rung that makes "hear a line within two minutes of install" true.
- Abort: `clearOutputQueue` returns in 0.1 ms and synthesis stops at the next
  chunk boundary. Chunk granularity is one sentence (`maxNumSentences: 1`),
  which is the right unit for this narrator.
- Kokoro's 400 ms first-audio is inside the 700 ms budget with 300 ms to
  spare for the hook and the daemon hop.

### Decisions that fell out

- **Audio I/O is `audify`.** Prebuilt N-API binaries exist for darwin arm64
  and x64, linux x64 and arm64, win32 x64. One gotcha, now in the repo:
  pnpm 10 blocks install scripts by default, so `onlyBuiltDependencies:
  [audify]` lives in `pnpm-workspace.yaml`, and CI must confirm the binary
  actually landed rather than trusting the install.
- `write()` wants exactly one frame per call. The daemon's speaker keeps a
  re-cutting buffer; the prototype has the reference implementation.
- A Mac run of the same prototype is the first task of Phase 1, before any
  daemon code, because the plan's whole premise is macOS first and the only
  numbers so far are from the author's Windows desk.

## Phase 1 — narration, shipped alone · weeks 1–3 · v0.1

Port order is by dependency, each module landing with its tests:

1. [ ] `core/events` — the `AgentEvent` shape, severities 0–4.
2. [ ] `core/tracker` — status board, bounded ring buffers, 15-min eviction.
3. [ ] `core/scrub` — the register: strip code, diffs, paths, markdown;
       `test_line_is_speakable`, `no_robot_tells`, `short_enough_to_hear`.
4. [ ] `core/narrator` — **acceptance: all 12 narration fixtures pass**,
       `every_fixture_says_why`, `suite_actually_covers_silence`.
5. [ ] `core/arbiter` — severity preemption, TTL drop, dedupe, repo announce,
       rate limit on chatter and never on alerts.
6. [ ] `daemon/adapters/claude-code` — the 17 mapped events, the dropped-events
       test, `last_assistant_message` preferred on Stop.
7. [ ] `cli/hook.js` — builtins only, < 80 ms, exit 0, silent. Measured in CI.
8. [ ] `daemon` — `/health /state /stream /hook/claude /speak /interrupt /mode
       /sessions`, loopback + token, **health-check before bind** (the
       double-daemon bug is the one thing that bit a real user; it is fixed
       structurally, not by a guard script).
9. [ ] TTS ladder — `streamTo(text, speaker, abort)` as the only interface,
       clause streaming from day one. Rungs: Kokoro (sherpa, fetched on
       demand) → ElevenLabs (BYOK) → system voice.
10. [ ] `ct install claude` — merge settings.json, mark ownership, back up,
        `uninstall` removes exactly that. Port the ownership tests, including
        "a foreign hook survives".
11. [ ] `ct demo / doctor / status / up / down / logs`.
12. [ ] Island moved, pointed at the new daemon.
13. [ ] README rewritten for narration only. The listening half is not
        mentioned as a feature until Phase 2 ships it.
14. [ ] **Ship 0.1 to npm. Twenty strangers.** Collect `doctor` output.

**SLOs, measured by a ported `ttfa_bench` in CI on the Mac runner:**

| Metric | Target |
|---|---|
| Agent turn end → first audio (Kokoro, CPU) | < 700 ms |
| Hook startup | < 80 ms |
| Cold install on a clean runner, all three OSes | < 2 min |
| Daemon idle RSS | < 400 MB |

**Frozen in this phase:** microphone, Companion, any second agent adapter.

## Phase 2 — voice approvals and the listening half · weeks 4–8 · v0.2

The unique thing: answer a permission prompt by voice, through hooks.

1. [ ] `PermissionRequest` hook with a ~20 s timeout. Daemon speaks the
       prompt with its repo name. Router binds yes/no to the **last-spoken
       prompt id only**. Silence, no, and timeout all deny. Port
       `test_permission_binding` and `test_voice_permission` first.
2. [ ] Mic loop on sherpa-onnx: Silero VAD → Smart Turn (ONNX, vendored with
       attribution) → STT. **Benchmark Whisper vs Parakeet vs SenseVoice on a
       CPU-only Mac** before choosing; keep `looks_unfinished` as the
       no-model fallback, exactly as PLAN.md argues.
3. [ ] `core/addressing` — the name gate, false accepts at zero, false-reject
       budget. Port its tests before its code.
4. [ ] `core/router` — CONTROL before anything else; social → ASK; WORK default.
       Port the "no control phrase ever reaches WORK" test.
5. [ ] Head, rules backend. Model backend behind a key, cheapest fast model,
       streamed by clause, reasoning blocks swallowed before the mouth.
6. [ ] Stop-hook hold (exit 2) for hands-free replies, `CT_STOP_HOLD`, off by
       default.
7. [ ] Work route → headless Agent SDK session in a registered repo; its
       events land in the same tracker and arbiter; its permissions come to
       the voice.
8. [ ] ElevenLabs Scribe as the STT rung for GPU-less machines, **gated
       locally**: the name gate runs on a local model, only addressed audio
       leaves the machine. This is a brand decision; it is documented in the
       README as such.
9. [ ] Push-to-talk through the island window, not a global keyboard hook.
10. [ ] Latency harness: replay a WAV through the loop, print the stage
        table from hub frames (`vad_close`, `stt`, `route`, `first_audio`),
        so an unmeasured stage shows as a gap, never a zero.
11. [ ] Island states: listening → heard you → speaking, held through agent
        chatter.

**SLOs, on a GPU-less Mac, warm cache:**

| Metric | p50 | p90 |
|---|---|---|
| End of speech → first audio, short command | < 1.2 s | < 2.0 s |
| "Yes" → hook returns allow | < 600 ms | < 1.0 s |
| Name-gate false accepts, over the eval set | 0 | 0 |

**Cutover point.** When Phase 2 reaches parity for the author's own daily
use, the Python repo is archived with a pointer. Until then it runs the
author's desk and receives bug fixes only.

## Phase 3 — the app and the paid tier · weeks 9–14 · v1.0

1. [ ] Shell: island promoted to the app. Tray icon, settings window,
       onboarding (pick a voice, hear a line, wire the hooks), lifecycle
       (start, health, single instance, spoken shutdown), bundled Node.
       Electron or Tauri decided on measured RAM after Phase 2.
2. [ ] Signed installers: Apple notarization, Windows Authenticode.
       Auto-update.
3. [ ] Companion port behind `CT_COMPANION`: proposals gate with the
       build-failing test, memory, impulse engine, **all 20 impulse and fleet
       fixtures pass**. Byte-identical behaviour with the flag off, asserted.
4. [ ] Opt-in crash reporting and `ct bundle`. No telemetry by default.
5. [ ] Security: threat model doc, `SECURITY.md`, never voice-approve a
       destructive command by default (deny-list in code, escalate unknown).
6. [ ] Licence audit: vendored BSD-2 files, model weights, ElevenLabs
       commercial terms for a cloned default voice, voice-clone consent text.
7. [ ] Pricing for the Companion tier, and whether ElevenLabs is BYOK or
       proxied and billed. Cost model: ~40 credits per narration line at
       Flash rates; a heavy day is ~8,000.

## Explicitly not ported

- The PTY wrapper and everything in `ptywrap/`. Hooks answer permissions now.
- Chatterbox and Soprano sidecars. The cloned voice is an ElevenLabs Instant
  Voice Clone from the same reference clip.
- The `cuda` extra, `keyboard`, `pycaw` ducking (Windows-only; revisit in
  Phase 3 if users ask), `desktop.py`.
- The opencode adapter. A second PUSH adapter (Codex) returns only when a
  user asks for it.
- Arabic and Turkish as a project. They become configuration on the
  ElevenLabs rung and on sherpa's multilingual models; the router's
  per-language control words are the one piece of real work, and it waits
  for a user who speaks them.

## What will go wrong

| Failure | Constraint |
|---|---|
| Node audio I/O is flaky on one OS | Prototyped day one; native helper as the documented fallback |
| Whisper on CPU is too slow on a Mac | Benchmarked in Phase 2 item 2 before choosing; Parakeet/SenseVoice/Scribe are the alternatives |
| Hook payload shape changes | Defensive lookups, dropped-events test, degrade narration never break the agent |
| The port drifts from the register | Every narrator line goes through the ported `scrub` tests; fixtures are shared |
| Two repos, one person | Python repo frozen the day the port starts; bug fixes only |
| Rebuilding the listening half before narration has users | Phase 1 ships and is used before Phase 2 opens |
| Anthropic ships native narration | Defensible ground is many agents, local-first, and the Companion; Phase 2 and 3 are built toward it on purpose |

## Verification

- Phase 1: `cold.yml` green on all three OSes; 12 narration fixtures green;
  TTFA bench under target on the Mac runner; twenty external `doctor` reports.
- Phase 2: latency harness table under SLO on a GPU-less Mac; the permission
  binding tests; a recorded soak session where two sessions narrate and it is
  tolerable to sit next to — a listening judgement, as always.
- Phase 3: a stranger installs from a signed installer, hears a line within
  two minutes, and can uninstall cleanly.
