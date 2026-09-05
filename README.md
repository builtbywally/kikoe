# Kikoe

**Hear your coding agents from across the room.**

A local voice layer for coding agents. It speaks one good line when a turn
finishes, when something breaks, and when an agent needs a decision, and it
stays quiet through everything else. Say yes out loud and the agent's
permission prompt is answered.

> Kikoe (聞こえ) means "audibility": the voice can be heard. The project is
> a clean second implementation of
> [ClaudeTalks](https://github.com/builtbywally/claudetalks): same thesis,
> same register, same evals, one language, one audio runtime, no sidecars.
> The plan is in [docs/PLAN.md](docs/PLAN.md).

```
claude hook ──▶ kikoe daemon ──▶ narrator ──▶ arbiter ──▶ speaker
                                  (what's worth   (one mouth,
                                   saying)         many agents)
```

## Status

Phase 0 done; the desktop app (App A) is running on the author's desk. The
narrator, register, tracker, arbiter and Claude Code adapter are ported and
pass every narration fixture. The Electron app hosts the daemon in its main
process, wires Claude Code through a `curl` hook, shows the island, and
speaks through Piper, Kokoro, ElevenLabs or the system voice. Nothing is
published or signed yet. See [docs/APP-PLAN.md](docs/APP-PLAN.md).

```bash
pnpm install
pnpm test
pnpm app          # build and launch the desktop app
pnpm app:dist     # build the installer into out/app
```

```bash
pnpm install
pnpm test
```

## Layout

| Package | What |
|---|---|
| `packages/core` | events, narrator, arbiter, router, the register. Pure logic, no I/O. |
| `packages/daemon` | the long-lived process: hook endpoints, TTS ladder, audio |
| `packages/cli` | the `kikoe` binary and the hook entry |
| `packages/app` | the desktop app: Electron shell, island, settings, tray |
| `evals/` | narration, impulse and fleet fixtures, the acceptance contract |
| `docs/` | [PLAN](docs/PLAN.md) · [VOICE](docs/VOICE.md) · persona |

## License

MIT.
