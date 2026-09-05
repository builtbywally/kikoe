# The desktop app — plan

ClaudeTalks as something a person downloads, double-clicks, and hears within
two minutes. This pulls "the app" forward from Phase 3 of [PLAN.md](PLAN.md)
to the shell that Phase 1 ships in. The CLI stays for developers; the app is
for everyone else.

Same rule as PLAN.md: status is real. `done` means a stranger installed it.

Written 2026-09-05.

## The shape, and why it is simpler than it was

In the Python design the app was a shell around a foreign runtime: an
Electron window managing a Python daemon, a bundled interpreter, and two
sidecars. The port removed all of that. The daemon is Node now, and Electron
*is* Node, so:

```
  Electron main process
  ├── the daemon         hook endpoint on 127.0.0.1:4570, narrator, arbiter,
  │                      TTS ladder, audio out (audify), later the mic loop
  ├── the tray           mode, pause, doctor, quit
  ├── lifecycle          single instance, start at login, spoken shutdown
  └── windows
      ├── island         the pill. Unchanged. Click-through, display only.
      ├── onboarding     first run: voice, hear a line, wire the hooks
      └── settings       voice, verbosity, mic, keys, hook status, doctor
```

One process tree, one runtime, no IPC to a foreign language. The native
modules are N-API (`audify` napi-v10, `sherpa-onnx-node` node-addon-api),
which load in Electron without a rebuild. **This is verified in week one,
before anything else, because it is the single assumption the whole shape
rests on.**

Tauri was considered. Its shell is a tenth of the memory, but it would put
the daemon back into a sidecar process with its own lifecycle, and the
memory problem this project actually had was torch, not Electron. Revisit
only if the shell itself becomes the bottleneck on a measured machine.

## The hook has no runtime at all

The hook is the one piece that runs on the agent's critical path, on every
tool call. Today's plan has it as a Node script, budgeted at 80 ms.

There is a better answer once the daemon owns the response: **the hook is
`curl`.** It ships with Windows 10+, macOS, and every Linux the audience
uses. Startup is about 10 ms. The command Claude Code runs is:

```
curl -sS -m 25 -K ~/.kikoe/hook.curlrc --data-binary @-
```

`hook.curlrc` holds the URL and the `Authorization` header, written by the
app at install time with mode 600, so the token never appears in
`settings.json`. Claude Code pipes the payload to stdin; the daemon answers;
curl prints the answer to stdout — which is exactly how a hook returns a
decision. So a `PermissionRequest` hook is: daemon speaks "It wants to push.
Shall I?", holds the request until you say yes or the timeout passes, and
responds `{"hookSpecificOutput":{"decision":"allow"}}` or nothing. A `Stop`
hook that should hold the session gets its JSON the same way. No Node, no
script, nothing to keep in sync with the app version.

Fallback: on a machine with no `curl`, the installer writes the Node hook
instead and `doctor` says so. Both variants are tested in `cold.yml`.

## Packaging

| | Windows | macOS | Linux |
|---|---|---|---|
| Builder | electron-builder | electron-builder | electron-builder |
| Artifact | NSIS `.exe` (per-user, no admin) | `.dmg`, universal or arm64 + x64 | AppImage, `.deb` |
| Signing | Azure Trusted Signing (~$10/mo, immediate SmartScreen reputation) or an OV cert | Apple Developer ID ($99/yr), hardened runtime, notarization | none required |
| Auto-update | electron-updater, GitHub Releases | electron-updater, GitHub Releases (needs signing) | AppImage update |
| Size | ~180 MB with Electron + sherpa + one Piper voice | same | same |

Kokoro (353 MB) and any other model are fetched on demand into
`~/.kikoe/models`, with a progress bar in settings, never bundled.

**Notarization trap, recorded now:** every Mach-O inside the bundle must be
signed, including sherpa's `.dylib`s and the `.node` addons. electron-builder
does this when they sit under the app's resources; a stray copy in
`node_modules` of a nested package will fail notarization with a message that
names the file, so the build step lists every binary it signed.

**macOS microphone:** `NSMicrophoneUsageDescription` in the plist and the
`audio-input` entitlement, or the mic loop silently reads zeros. Requested
only when the user enables listening, never at first launch.

## First run, the two minutes that decide it

1. Launch. Single-instance lock. Tray icon appears. Island appears, idle.
2. Onboarding window: "Pick a voice." Three rows: **Piper** (bundled, plays
   instantly), **Kokoro** (download, 353 MB), **ElevenLabs** (paste a key;
   stored in the OS keychain through Electron's `safeStorage`, never in a
   file). Each row has a play button that speaks one real narrator line.
3. "Connect Claude Code." The app finds `~/.claude/settings.json`, shows the
   exact hooks it will add, backs the file up, and adds them on click. Marks
   what it owns, so uninstall removes exactly that.
4. "Hear it work." The app replays one eval fixture through the real
   pipeline: three edits, a test run, a permission question. The user hears
   the product before they have used it.
5. Done. The window closes. The island stays. Nothing else is on screen.

Every step is skippable and every step is reachable again from settings.

## Lifecycle

- **Single instance.** A second launch focuses the first. The daemon
  health-checks before binding; a foreign process on the port is reported,
  never bound over. This is the bug that bit the first real user, fixed at
  the shell, not by a guard script.
- **Start at login**, off by default, one toggle.
- **Tray menu:** Silent / Attention / Normal / Verbose, Pause for an hour,
  Open settings, Doctor, Quit.
- **Quit** says goodbye if it is mid-sentence, drains, exits. Spoken "shut
  down" routes to the same path, exact phrases only.
- **Crash:** the daemon runs in the main process, so a daemon crash is an
  app crash. Electron's `crashReporter` is wired but **opt-in**, and the
  report contains no transcript, no audio, no repo path.

## Settings, all of it

Voice (rung, ElevenLabs key and voice picker, Kokoro download), verbosity,
microphone device and level meter (Phase 2), wake name (Phase 2), hooks
status with a "reinstall" button, log viewer, doctor output, "reset
everything". No account, no login, no telemetry toggle to find because
there is no telemetry.

## What changes in the existing plan

- Phase 1 delivers the daemon **inside the app** and the CLI as a thin
  developer wrapper around the same packages, not the other way round.
- `packages/app` joins the workspace: Electron main, preload, renderer.
  The island's existing HTML, CSS and JS move in unchanged.
- The hook becomes `curl` first, Node second. The 80 ms budget becomes a
  20 ms budget.
- `cold.yml` grows a second job: build the installer on each OS, install
  it silently, launch with `--smoke` (boots the daemon, speaks one line to
  a null device, exits 0), uninstall.
- `release.yml` publishes installers to GitHub Releases alongside the npm
  packages. Signing secrets live in the repo's environment, never in a
  workflow file.

## Milestones

**App A — it installs and narrates · weeks 1–3** · *started 2026-09-05*

1. [x] `packages/app` scaffold, electron-builder config. Windows installer
       builds locally. [ ] Both installers in CI on every push.
2. [x] Native modules load inside Electron on **Windows** (Electron 39,
       Node 22.22, N-API 10: audify and sherpa-onnx both load in the main
       process). [ ] macOS.
3. [x] Daemon in the main process: `/health /state /stream /hook/claude
       /event /speak /interrupt /mode /permission`, narrator, arbiter,
       tracker, TTS ladder (Piper bundled, Kokoro on demand, ElevenLabs by
       key, system voice floor), audio through audify, health-check before
       bind. Measured: a hook payload round-trips through curl in 79 ms.
4. [x] `curl` hook written by the app into `~/.kikoe/hook.curlrc`;
       token never in settings.json (tested). [x] Node fallback script,
       written when no curl is found. [x] `speak.curlrc` for the agent's
       own line; output style and skill installed with the hooks.
5. [x] Island moved in unchanged. Tray with modes, pause, stop talking,
       settings, doctor, quit. Single instance. Spoken shutdown.
6. [x] Onboarding: voice (play per rung, ElevenLabs key in the OS keychain,
       voice picker), connect Claude Code (preview, install, uninstall,
       profile), hear it work (scripted session through the real pipe),
       done. Doctor page with measured latency. [x] Kokoro download from
       settings. [x] Sessions page with the pending permission and the last
       fifty lines. [x] ClaudeTalks migration.
7. [x] `--smoke` boots the daemon, speaks one line to the null device, exits
       0. [x] `app.yml`: installers on three OSes, native-module check
       inside Electron, smoke of the unpacked build (first green run
       pending). [ ] Ten people.

**App B — it is trustworthy · weeks 4–5**

1. [ ] Apple Developer ID and notarization. Azure Trusted Signing.
2. [ ] Auto-update through GitHub Releases, with a "what's new" line in
       the tray on first launch after an update.
3. [ ] Settings window complete. Keychain storage for the ElevenLabs key.
4. [ ] Opt-in crash reporting. `Doctor` exports a support bundle.
5. [ ] Uninstall that removes hooks, then the app, then asks about
       `~/.kikoe`.

**App C — it listens · weeks 6–10** *(Phase 2 of PLAN.md, inside the app)*

1. [ ] Mic loop, name gate, push-to-talk from the island.
2. [ ] Permission by voice through the `curl` hook holding the request.
3. [ ] macOS mic entitlement and the first-enable permission flow.

**Deliberately after C:** the Companion, pricing, the paid tier. The app
has to be something people keep open all day before it is something they
pay for.

## Costs

| Item | Cost |
|---|---|
| Apple Developer Program | $99 / year |
| Azure Trusted Signing | ~$10 / month |
| GitHub Releases hosting | free |
| ElevenLabs, per user | their own key (App A–C); proxied and billed only with the paid tier |

## What will go wrong

| Failure | Constraint |
|---|---|
| A native module fails to load under Electron on one OS | Week-one check; `@electron/rebuild` is the fallback, a sidecar Node process the fallback to that |
| SmartScreen blocks the unsigned Windows build | App A testers are told to expect it; App B fixes it |
| Notarization rejects a nested binary | The build lists every signed binary; a miss is a named file, not a mystery |
| The app and the hook drift | The hook is curl and has no version; the daemon's response shape is the only contract, covered by the adapter tests |
| The user's own ElevenLabs key ends up in a log | Keys live in the keychain; the daemon redacts `xi-api-key` and `Authorization` in every log line, with a test |
| Two apps, two daemons, port 4570 twice | Single-instance lock at the shell, health check before bind at the daemon |
| Auto-update from a private repo | The repo goes public at App B, or updates are served from a static bucket |
