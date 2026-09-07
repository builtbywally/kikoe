# Kikoe

Read `docs/HANDOVER.md` before doing anything: it holds the state, the
decisions, and the gotchas the code does not say. Then `docs/SENTIENCE.md`
(the goal: Kik feels like someone in the room), `docs/AUDIT.md` (every
flow, its gaps, and the plan), and `docs/ROADMAP.md`. `docs/EVAL-MODELS.md`
says why the voice runs on Haiku and the designer on Sonnet.
`docs/HEARING.md` is the researched plan for the ear: endpointing, the
recognizer, knowing who the user is talking to, echo cancellation.

Rules that are not negotiable:

- Tests never touch the real `~/.claude` or the OS voice. `KIKOE_CLAUDE_DIR`
  and `tts: "none"` are set by the test files; keep them.
- Never print a key. They live in `~/.kikoe/*_key.txt` and `*.enc`. The
  daemon and viewer tokens are not keys, but keep them out of commits.
- One daemon owns port 4570: stop the installed `kikoe.exe` before running
  from source or taking a screenshot (`taskkill //IM kikoe.exe //F`).
- Write patch scripts with the Write tool and run them once; anchor-based
  edits re-applied duplicate code, and Bash heredocs mangle backslashes on
  this machine (a `\n` in a heredoc is not a `\n` in the file). Prefer the
  Edit tool for small changes.
- Never edit the user's real `~/.kikoe` data as a test. If a demo must
  change it (a fact in `memory.md`), put it back the same way.
- After a change: `pnpm test`, `pnpm lint`, `pnpm typecheck`, a screenshot
  (`npx electron . --screenshot out.png` from `packages/app`, app stopped),
  one spoken line through `~/.kikoe/speak.curlrc`, then commit and push,
  then the installer and a silent reinstall.
- The installer: from `packages/app`, `pnpm exec electron-builder
  --config.directories.output=<a directory outside the repo>`. Under pnpm,
  never npx (npx drops audify and sherpa-onnx and the ear dies silently),
  and outside the repo (Orca's watcher locks `out/`). Check
  `win-unpacked/resources/app.asar.unpacked/node_modules` lists audify,
  sherpa-onnx-node and sherpa-onnx-win-x64, stop the app, run the
  installer with `/S`, then check `/state` shows `mic.phase` listening.
- Commit messages: a title, a paragraph of why, and the Co-Authored-By line.
- Docs are part of the change: `docs/HANDOVER.md` for anything the next
  session needs, `docs/AUDIT.md` when a flow or gap changes.

Speak to the user at milestones with the `speak` skill; they work by voice
and approve with "go ahead". When they say go, do the whole list, and do
not ask before each commit.
