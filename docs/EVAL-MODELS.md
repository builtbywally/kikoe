# Sonnet 5 vs Haiku 4.5 for Kikoe

Run 2026-09-06 with `pnpm eval:models` (the script is `scripts/eval-models.mjs`;
it uses the real API and your key, and a throwaway home). Two jobs were
measured, because Kikoe uses a model in two places: the voice head that
answers when you talk to Kik, and the designer that builds pages.

## The voice head

Nine prompts, each against the same staged picture: one agent in
`storefront`, last test run 18 passed and 2 failed, a `git push` waiting
for approval. "First" is the time to the first spoken clause, which is
what you hear as the wait.

| Prompt | Haiku first / total | Sonnet first / total | Tools |
|---|---|---|---|
| what's it doing | 1.1 s / 1.4 s | 2.0 s / 2.5 s | both right |
| did the tests pass | 1.0 s / 1.4 s | 1.5 s / 2.1 s | both right |
| tell it to add a retry | 2.5 s / 2.9 s | 5.7 s / 6.3 s | both instructed |
| make me a release checklist | 2.3 s / 5.3 s | 6.8 s / 8.0 s | both made it |
| remember we ship on Fridays | 2.3 s / 2.4 s | 2.8 s / 4.9 s | Haiku remembered; Sonnet said "already noted" and did not |
| opinion on a Rust rewrite | 1.0 s / 2.3 s | 5.4 s / 6.4 s | Sonnet 65 words, over the limit |
| localhost 3000 on the canvas | 2.5 s / 2.5 s | 6.0 s / 6.2 s | both made the web card |
| cats vs dogs visually | 2.1 s / 3.5 s | 8.1 s / 12.8 s | both called the designer; Sonnet dropped the Next line |

Averages: Haiku 1.9 s to the first word, 2.7 s total. Sonnet 4.8 s to the
first word, 6.1 s total.

What the numbers do not show, from reading the replies:

- Sonnet nagged. In six of nine replies it repeated the same warning about
  the pending push with failing tests, including when asked to remember a
  fact. That is the kind of thing that makes a voice assistant tiring.
- Sonnet also made extra tool calls (read the board twice, pinned notes
  nobody asked for), which is where its time went.
- Haiku was terse and correct, a little plain, never over the word limit,
  and always ended with the Next line the chips need.

Verdict for the voice: **Haiku 4.5**, by a wide margin. Two and a half
times faster to the first word, and better behaved. Sonnet's extra
judgement shows up as lecturing, not as better answers.

## The designer

Two briefs, the same design brief, code judged by reading it.

| Brief | Haiku | Sonnet |
|---|---|---|
| Wallet settings | 25 s, 10 k chars, 5 pieces of state, saved as a boolean, no revoke, no ARIA | 107 s, 15 k chars, 19 pieces of state, idle / saving / saved, sessions revoke, a real form, switches with ARIA |
| Cats vs dogs | 25 s, 10 k chars, situation picker and a winner per row, one emoji against the brief | 81 s, 15 k chars, picker, winner per row, a chart, a verdict for the flat-dweller, no emoji |

Verdict for the designer: **Sonnet 5**. The pages are the ones a designer
would sign off on: real states, accessibility, the verdict the brief asked
for. The cost is time: a page takes one to two minutes, against twenty-five
seconds for Haiku's decent-but-shallow version.

## What this means for the settings

- `brain_model`: Haiku 4.5, the current default. Keep it.
- `artifact_model`: Sonnet 5, the current default. Keep it, and let Kik say
  "give me a minute" before it calls the designer, because the wait is
  real.
- A "quick mockup" path on Haiku would be worth adding for throwaway
  sketches; twenty-five seconds is a different experience from ninety.

## Caveats

One run, one staged picture, nine prompts, two briefs. Enough to choose
defaults, not enough to tune prompts. The "go ahead" prompt was dropped
from the table: in real use it is a reflex that never reaches the model,
and in the harness there was no held permission for either model to
approve.
