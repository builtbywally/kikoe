# Upgrades

Ranked ways to make the app better, written the day App A first ran
(2026-09-05). Measured state at the time: the app idles at ~370 MB across
four processes, main process 114 MB; a hook round-trips in 79 ms; ElevenLabs
first sound ~180 ms, Piper ~60 ms, Kokoro ~400–700 ms.

Each item says what it changes and roughly what it costs. Status is real:
an item is done when it is in the app and a stranger has used it.

## What you hear

1. **Claude writes its own line.** *done 2026-09-05* *(~1 day)* The old project's best
   narration came from its output style: Claude ends each turn with one
   spoken sentence via `ct speak`. Ship `kikoe speak` (CLI → `/speak`
   with `source: "agent"`), install the output style and the `speak` skill
   alongside the hooks, and have a self-spoken line suppress the Stop hook's
   summary for that session for ~20 s so both are never heard. The biggest
   quality jump available.
2. **One voice per repo.** *done 2026-09-05* *(~half a day)* Registered repos get a voice;
   identity by voice beats "In storefront, …". The ladder already takes a
   voice per call; the narrator carries the repo.
3. **Earcons.** *done 2026-09-05* *(~half a day)* A soft tick for progress, a chime for done,
   a two-tone for a question, in place of words at the low severities.
   Verbose mode becomes bearable.
4. **Clause streaming.** *done 2026-09-05 (ElevenLabs); WebSocket pending* *(~half a day)* `splitClauses` exists in core and
   the ladder ignores it. Then the ElevenLabs WebSocket input-streaming
   endpoint for the head (Phase 2).
5. **Kokoro download from settings.** *done 2026-09-05* *(~half a day)* The row exists, the
   download does not. Resumable, with a progress bar, into `~/.kikoe/models`.

## What makes it a product

6. **Migrate from ClaudeTalks.** *done 2026-09-05* *(~2 hours)* Detect the old hooks (twelve
   entries on the author's machine) and output style; offer one-click
   removal. Otherwise an upgrader has two hook sets and a dead daemon.
7. **Session board and history.** *done 2026-09-05* *(~half a day)* A settings page with every
   live session from the tracker, and the last twenty spoken lines. "What
   did it just say?" is the commonest question and the mic is not here yet.
8. **Toast fallback.** *done 2026-09-05* *(~2 hours)* When paused or silent, a permission
   request raises an OS notification with the command text.
9. **Crash resilience.** *done 2026-09-05* *(~2 hours)* Top-level handlers in main; a daemon
   exception restarts the daemon in place, logs, and shows in doctor.
10. **Start at login, auto-update.** *start at login done 2026-09-05; auto-update waits on signing* *(~1 day + accounts)* The toggle is
    unwired. Auto-update needs the signing accounts in APP-PLAN.md.
11. **CI for the app.** *workflow and Node fallback written 2026-09-05; green run pending* *(~1 day)* Installers on all three OSes on every
    push; `--smoke` in the cold-install job; the Node fallback hook.

## Faster and safer

12. **Precise playback state.** *done 2026-09-05* *(~half a day)* Use audify's frame-output
    callback for an exact "quiet" moment instead of an estimate. The
    island's speaking state and barge-in both need it.
13. **Metrics that cannot lie.** *done 2026-09-05* *(~half a day)* Hub frames for hook
    receipt, first audio, playback end; derive latency per line; a latency
    section in doctor. The SLOs become measured.
14. **Unload idle models.** *done 2026-09-05* *(~1 hour)* Drop a loaded Kokoro after ten
    idle minutes; reload on demand.
15. **Token file ACLs on Windows.** *done 2026-09-05* *(~1 hour)* Mode 600 is a no-op on
    NTFS; set an owner-only ACL with `icacls` when writing the token and
    the curl config.

## The big one

16. **The listening half** *(Phase 2 of PLAN.md, weeks)*: mic loop on
    sherpa (VAD, turn detection, STT), the name gate, yes/no bound to the
    last spoken permission through the held `curl` request, questions
    answered from the tracker by rules. Everything above is smaller.

## Measured after the upgrades (2026-09-05)

- The agent's own line through `/speak`: event to first sound 304 ms on
  ElevenLabs; the Stop hook's summary for that turn was not spoken.
- A `PermissionRequest` hook held open 4.2 s and denied with an empty body
  on timeout; a yes released it with the allow decision.
- Legacy detection on the author's machine: twelve old ClaudeTalks hook
  events found, none adopted.

## Order

1, 6, 7, 2 first: each under a day and each changes the daily experience.
Then 11, so strangers can install it. Then 16.
