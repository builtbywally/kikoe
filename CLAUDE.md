# Kikoe

Read `docs/HANDOVER.md` before doing anything: it holds the state, the
decisions, and the gotchas the code does not say. Then `docs/SENTIENCE.md`
(the goal) and `docs/ROADMAP.md`.

Rules that are not negotiable:

- Tests never touch the real `~/.claude` or the OS voice. `KIKOE_CLAUDE_DIR`
  and `tts: "none"` are set by the test files; keep them.
- Never print a key. They live in `~/.kikoe/*_key.txt` and `*.enc`.
- One daemon owns port 4570: stop the installed `kikoe.exe` before running
  from source.
- Write patch scripts with the Write tool and run them once; anchor-based
  edits re-applied duplicate code. Prefer the Edit tool for small changes.
- After a change: `pnpm test`, `pnpm lint`, `pnpm typecheck`, a screenshot
  (`npx electron . --screenshot out.png` from `packages/app`), one spoken
  line through `~/.kikoe/speak.curlrc`, then commit and push, then
  `pnpm app:dist` and a silent reinstall.
- Commit messages: a title, a paragraph of why, and the Co-Authored-By line.

Speak to the user at milestones with the `speak` skill; they work by voice.
