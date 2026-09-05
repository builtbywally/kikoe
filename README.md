# earshot

**Hear your coding agents from across the room.**

A local voice layer for coding agents. It speaks one good line when a turn
finishes, when something breaks, and when an agent needs a decision, and it
stays quiet through everything else. Say yes out loud and the agent's
permission prompt is answered.

> Working name. The project is a clean second implementation of
> [ClaudeTalks](https://github.com/builtbywally/claudetalks): same thesis,
> same register, same evals, one language, one audio runtime, no sidecars.
> The plan is in [docs/PLAN.md](docs/PLAN.md).

```
claude hook ──▶ earshot daemon ──▶ narrator ──▶ arbiter ──▶ speaker
                                  (what's worth   (one mouth,
                                   saying)         many agents)
```

## Status

Phase 0 done. The narrator, the register, and the Claude Code adapter are
ported and pass every narration fixture. The audio prototype runs Kokoro and
Piper through one ONNX runtime with a mid-line abort; numbers are in the
plan. Nothing is published yet.

```bash
pnpm install
pnpm test
```

## Layout

| Package | What |
|---|---|
| `packages/core` | events, narrator, arbiter, router, the register. Pure logic, no I/O. |
| `packages/daemon` | the long-lived process: hook endpoints, TTS ladder, audio |
| `packages/cli` | the `earshot` binary and the hook entry |
| `evals/` | narration, impulse and fleet fixtures, the acceptance contract |
| `docs/` | [PLAN](docs/PLAN.md) · [VOICE](docs/VOICE.md) · persona |

## License

MIT.
