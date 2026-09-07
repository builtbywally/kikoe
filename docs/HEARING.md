# Hearing: how Kik should listen, know it is spoken to, and answer

Researched 2026-09-07 from a day of the daemon log and the state of the
field (papers, model cards, the production voice stacks). This is the
plan for the ear and the first half of the head: speech detection, turn
taking, knowing who the user is talking to, and reading fragmentary
speech in context. It replaces items 5 to 8 of the plan in
`docs/AUDIT.md` and milestone 1 of `docs/ROADMAP.md` for the ear.

## First, the thing that is not a research problem

The Anthropic account ran out of credit at 20:29 on 2026-09-06. Every
call since then has failed with "credit balance is too low": 181
failures in the log, every reply, every judgement of "was that for me",
every reflection. So for the whole of 2026-09-07 Kik has been the rulebook
with a voice: the gray-zone judge answered "no" to everything, and
questions got the stock "I can't reach the model right now". Top up the
account before judging any of the rest. Separately, the daemon must say
this out loud once ("I can't reach my model; the account needs credit")
instead of failing quietly two hundred times; that is a small change in
`converse()` and `decideDirected()` and it is in phase 1 below.

## What the log says

One day of `hear_debug` (399 transcripts, 2026-09-06 to 07):

| Measure | Value |
|---|---|
| Transcripts | 399 |
| Taken as addressed | 204 (144 "work", 32 questions) |
| Addressed but two words or fewer | 38 of 204 |
| Whisper hallucinations ("(speaking in foreign language)", "(static)") | 26 |
| Transcription time, median / p90 / max | 242 ms / 920 ms / 3.9 s |
| Segment length, median / p90 / max | 1.7 s / 10.4 s / 40.9 s |
| Model judgements of a nameless sentence | 40 no, 9 yes |
| Barge-ins | 108 |

Three failures show in it plainly.

**A video call went to Kik.** At 11:20 on the 7th the user took a call.
"How are you", "take a look at this", "so yeah, what do you think?", "in
terms of UI/UX, what do you think about the way that dashboard looks" all
routed as addressed. The cause is structural, not a bug: the "you"
sentence rule (`YOU_QUESTION` in `core/src/router.ts`) takes any sentence
with "you" in it, and the twenty-second follow-up window
(`ATTENTION_MS`) takes everything after an exchange. On a call the user
says "you" in every sentence and never stops talking, so the window never
closes. Kik then spoke into the call, and each time it spoke, the next
sentence barged it (the ten barge-ins in that hour).

**Sentences arrive in pieces.** "and", "So", "the numb", "your love up",
"I will make Mac version and I will send you the app for a" are all
separate utterances. The VAD closes a segment after one second of
silence, Whisper transcribes the piece, and the merge in `hearSegment()`
only rejoins it if the next piece lands within 1.2 s and the first had no
final punctuation. A person pauses longer than that mid-thought, and
Whisper puts a full stop on almost anything.

**Whisper invents.** Twenty-six hallucinated captions in a day, all
routed as "work". Several long segments (up to forty seconds) were
Arabic or a mix; the `.en` model cannot say so and writes a caption
instead. sherpa-onnx's Whisper is greedy-only and exposes no
no-speech probability or log-probs, so there is nothing to threshold
(see the sources at the end).

There is a fourth failure the log cannot show: through speakers, Kik
cannot be cut off mid-word, only after its own echo has been
transcribed and dropped by text. The 108 barge-ins are mostly the VAD
"hearing" phase firing while Kik speaks, which on a headset is the user
and through speakers is Kik itself.

## The four problems, and the field's answer to each

### 1. When has the user finished? (endpointing)

Everyone has converged on the same shape: a short acoustic silence opens
a candidate end of turn, a semantic model or a text rule confirms it, and
a long hard timeout is the backstop. Fixed silence alone cannot work: a
500 ms window catches about half of real turn ends and fires on more than
half of mid-turn pauses; a 1 s window just shifts everything later.

The open model for the confirmation is **Pipecat Smart Turn v3.2**:
audio only, the last eight seconds of the turn, a Whisper-tiny encoder
with a linear head, 8.7 MB int8 ONNX for CPU, about 40 ms per call, BSD-2,
trained on exactly the trailing "and…", "so…", "um…" endings that split
today. English accuracy 94.7 percent on its test set. It runs on
`onnxruntime-node`, not sherpa-onnx, and needs a Whisper log-mel front
end (80 bins, n_fft 400, hop 160), which is a sixty-line port or the
WhisperFeatureExtractor from `@huggingface/transformers`. Pipecat's
recipe: VAD stop at 200 ms, then the model; if it says "not finished",
keep listening with a 3 s backstop.

LiveKit's detector is better on paper but its license forbids use outside
LiveKit Agents. Krisp's is closed. sherpa-onnx's streaming recognizers
have a built-in endpointer (trailing blank frames, rules 1 to 3) that
costs nothing extra and is a good second opinion once we stream.

Text rules that production stacks use on the partial transcript, cheap
and worth having as well: a trailing conjunction, filler or article means
keep waiting; a question mark or a full stop with a verb means done; a
trailing number means wait half a second because digits keep coming
(Vapi's published plan: punctuation 0.1 s, none 1.5 s, number 0.5 s).

### 2. What did they say? (recognition)

Whisper base.en is the wrong engine for an open mic: it hallucinates on
non-speech, cannot be biased toward the name, gives no confidence, and is
batch only. As of sherpa-onnx 1.13.7 (installed) the better options are
all transducer or CTC models, which cannot emit text they have not
aligned to audio frames and which return per-token log-probs and
timestamps:

| Model (asset name in the sherpa-onnx `asr-models` release) | Languages | Download | Why |
|---|---|---|---|
| `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` | English | 482 MB | Best local English accuracy, punctuation and casing, log-probs. The 622 MB encoder is the memory cost; RTF about 0.12 on a 7 s clip on the maintainer's machine. |
| `sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8` | English | 104 MB | Same family a fifth the size; LibriSpeech 2.4 / 5.2. The fallback if 0.6b is too heavy for the laptop. |
| `sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-v2-int8-2026-02-05` | 1600 incl. Arabic and English, no language token | 292 MB | Decodes a mixed Arabic and English sentence in one pass. Lowercase, no punctuation; run the online punctuation model after it. RTF about 0.22. |
| `sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25` | English | 464 MB | True streaming with punctuation, partial text every 560 ms, WER better than Whisper base. The way to answer before the sentence ends. |
| `sherpa-onnx-moonshine-base-en-quantized-2026-02-27` and `-base-ar-` | one each | 111 + 119 MB | The lightest pair; no confidence output. |

Whisper's own knobs do not fix it: `tailPaddings` toward 3000 reduces
hallucination but costs encoder time, and the maintainer says the rest
needs retraining. There is no `initial_prompt`, and hotwords exist only
for transducer models with modified beam search.

For the user's Arabic: Whisper multilingual mistranslates code-switched
speech; SenseVoice and Parakeet v3 have no Arabic; Dolphin has Arabic but
no English. Omnilingual is the one local model that takes both in one
utterance. sherpa's spoken-language-id (Whisper tiny, RTF 0.04) can route
a whole segment to the Arabic engine but cannot see a mid-sentence
switch.

### 3. Are they talking to me? (addressee detection)

This is a studied problem, "device-directed speech detection", and the
research is clear on what works and what does not.

What does not: a plain prompted LLM given the previous exchange and the
new sentence. In Apple's 2024 study on real follow-up conversations that
was the worst configuration tested, 46.7 percent false accepts, and
adding context to the untuned prompt made it worse (74.7 percent), because
the model treats any plausible continuation as directed. That is
`Brain.directed()` today, and it is why the judge said yes to a call.

What does, in order of cost: dialogue state (did Kik just ask a
question), recognizer uncertainty (n-best spread, the single most
informative feature in Amazon's work), second-person and imperative
words, then prosody. Amazon's fusion of acoustic, text and decoder
features reached 5.2 percent equal error rate; Apple's tuned multimodal
model 7.5 percent. The "unexpected second turn", the user speaking again
right after an answer with no question pending, is the hard case in every
paper and needs its own handling.

What the assistants actually do about follow-up: a short window, five to
ten seconds (Alexa 5, Meta glasses 5, Google about 10), extended only when
the reply asked something, closed by "thanks" or "stop", disabled outright
during calls and media playback, and closed when the user starts talking
to someone else. Nobody runs a twenty-second everything-is-addressed
window.

Signals we have or can get cheaply on this machine:

- **The owner's voice.** sherpa-onnx-node ships `SpeakerEmbeddingExtractor`
  and `SpeakerEmbeddingManager` with `verify`. `wespeaker_en_voxceleb_CAM++.onnx`
  is 27 MB and about 100 ms per utterance on a phone, so free on the
  desktop. Enrol once from three clips (threshold 0.6 in the upstream
  example). This rejects a video, a podcast, and the far end of a call
  coming out of the speakers. It does not reject the owner talking to a
  colleague, so it is a filter, not the answer.
- **Another voice in the room.** Embed every VAD segment; a segment that
  is not the owner within the last fifteen seconds means a conversation,
  and the follow-up window closes.
- **A call app holds the microphone.** Windows records it in the registry
  under `CapabilityAccessManager\ConsentStore\microphone`: an app's
  `LastUsedTimeStop` is zero while it is capturing. Poll it every few
  seconds, ignore Kikoe's own entry. Teams, Zoom, Discord and a browser
  Meet all show. While it is set, the follow-up window and the model gate
  are off, exactly Alexa's rule; only the name gets through.
- **Speech coming out of the speakers.** A WASAPI loopback stream (RtAudio
  supports it; audify exposes RtAudio) with Silero on it. Loopback speech
  alternating with owner speech is a call; loopback speech alone is a
  video. This is also the echo reference for problem 4, so it is one
  stream serving two purposes.

The name itself is a keyword-spotting job, not a transcription job.
sherpa-onnx's `KeywordSpotter` is already in the installed runtime;
`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` (18 MB) is
open-vocabulary English: a keyword is a line of BPE tokens made by
`text2token`, no training. One-syllable keywords collide ("kick", "quick",
"kid"), so register "hey kik" and "okay kik" with a raised threshold as
the reliable way in, and keep the transcript's `nameLike` as the fallback
for the bare name. openWakeWord would need a WASM runtime beside sherpa
and a Colab training run; Porcupine needs a key and licenses custom
words. Neither is worth it while the spotter is already loaded.

### 4. Reading fragmentary speech in context (the head)

Production stacks send only final transcripts to the model, aggregate the
user's pieces into one turn while the turn is open, and on a barge-in
truncate the assistant's own message to what was actually heard before
appending the user's new text. Interim transcripts drive turn-taking and
interruption, never the prompt.

Backchannels ("yeah", "mm", "okay", "right") during the assistant's speech
are filtered by duration and word count, not by model: under half a
second, or one or two words with no content word, is an acknowledgement
and does not stop the speaker. LiveKit adds a false-interruption resume:
if the VAD fired but no words were transcribed within two seconds, the
assistant carries on.

Recognition errors are best handled by telling the model what it is
reading: that the transcript is from speech recognition, which names it
may see misspelled, that short fragments continue the previous turn, and
that it should ask one short question when a critical word is uncertain.
Giving it low-confidence words marked (which the transducer models make
possible) beats an n-best list, which makes models over-correct.

Reference resolution ("this one", "the one on the left", "that page") is
solved the way Apple's ReALM does it: a compact list of what is on screen
with ids and positions plus what was last pointed at and last mentioned,
in the system prompt, and the model resolves the reference in language.
`brainSystem()` already lists the canvas; it needs positions and a
"last pointed at" line.

## The setup, in order

Each phase ships on its own: tests, a screenshot, a spoken demo, an
installer. Numbers are starting points to tune with the headset on.

### Phase 1: stop the bleeding (a day, no new models)

1. **Say when the model is gone.** In `converse()` and `decideDirected()`,
   on an API error with `credit`, `401`, `429` or a network failure, say
   one line once per hour ("I can't reach my model; the account needs
   credit") and show it on the agents card. Log the rest at one line per
   minute.
2. **Shrink the window.** `ATTENTION_MS` from 20 s to 8 s; extend to 15 s
   only when Kik's reply ended with a question mark or came from
   `ask_user`. Close it on "thanks", "okay thanks", "never mind", "stop".
3. **Drop the bare "you" rule.** Replace `YOU_QUESTION` with a narrower
   set that needs the name or an assistant-domain word alongside "you":
   "what do you think" alone is no longer enough; "kik, what do you
   think", "can you check the tests", "tell me what it's doing" are.
   Recall over precision was the right call in an empty room; a call is
   not an empty room, and phase 2 gives the room back.
4. **Call awareness, the cheap way.** A `callWatch()` in the daemon polls
   the ConsentStore registry key every three seconds (Windows only;
   `reg query` through `execFile`, no native code). While another process
   holds the mic: the window is off, the model gate is off, `hear_you` is
   off, only the name gate and reflexes work, and the Room shows "on a
   call". Setting `call_aware`, default on.
5. **A score, not a yes.** `Brain.directed()` returns 0 to 1 and gets the
   things the papers say matter: Kik's last line and whether it was a
   question, seconds since, word count, whether a call app holds the mic,
   whether another voice was heard (phase 2), and the instruction that
   narration, a call and reading aloud score low. Threshold 0.6; log the
   score. Add the negative examples to `brain.test.ts`.
6. **Backchannels.** In `hear()`, while the arbiter is speaking: a
   transcript under three words that is in the acknowledgement list does
   not barge in and is not answered; it is logged as "backchannel".
7. **Fragments.** In `hearSegment()`, hold a piece that ends on a
   conjunction, article, preposition, filler or number for 2.5 s instead
   of 1.2 s, and merge any piece under three words into the next one
   regardless of punctuation. Whisper's full stop is not a signal.
8. **`hear_debug` off by default** with a one-tap "what did you hear" for
   the last minute, as the audit already asks.

### Phase 2: the ear that knows the room (three days)

9. **Turn model.** Add `onnxruntime-node` and `smart-turn-v3.2-cpu.onnx`
   (8.7 MB, from the `pipecat-ai/smart-turn-v3` repository) to the mic
   process. VAD `minSilenceDuration` from 1.0 s to 0.3 s; on each VAD
   close, run the model on the last eight seconds; probability over 0.5
   ends the turn, otherwise keep the audio open and re-run on the next
   close, with a 3 s hard backstop. Post the turn as one `/heard`; the
   daemon's merge logic shrinks to the text rules in item 7. Log the
   probability with each turn for tuning. Test with recorded clips in
   `packages/app/test/turns/` (a trailing "and", a complete question, a
   list of numbers).
10. **Owner's voice.** Download `wespeaker_en_voxceleb_CAM++.onnx` in
    `models.ts`. Enrolment in Settings: "say three sentences", stored as
    `~/.kikoe/voice.bin` (an embedding, not audio). In the mic process,
    embed every VAD segment (about 100 ms, after transcription starts) and
    post `owner: true|false|unknown` and the similarity with the
    transcript. The daemon: not-owner segments are dropped as
    "someone else" (word count only, never text) and close the follow-up
    window for fifteen seconds. Setting `owner_only`, default on once
    enrolled.
11. **The name as a keyword.** `KeywordSpotter` on the gigaspeech 3.3M
    model in the mic process, fed the same frames as the VAD, keywords
    "hey kik", "okay kik", "kik" (the bare name at a higher threshold).
    A hit posts `/mic {phase: "name"}`; the daemon opens the window and
    the next transcript is addressed whatever Whisper spelled. Tune
    thresholds on the real mic with the log; keep `nameLike` as the
    fallback and shrink the alias list once the spotter carries it.
12. **Recognizer.** Replace Whisper base.en with Parakeet TDT 0.6b v2
    int8 behind the existing `stt_model` setting ("parakeet"; "parakeet-
    small" for the 110m); keep "base" and "tiny" as choices. Use the
    per-token log-probs: a turn whose mean log-prob is under a floor is
    posted with `low_confidence: true` and the daemon asks the model to
    treat it as such (item 15). Measure RTF on this laptop first; if the
    0.6b encoder is too slow, ship the 110m.
13. **Arabic.** Add Omnilingual 300M CTC as `stt_model: "omni"` and the
    Whisper-tiny language id as a router: a segment the id calls non-
    English goes to Omnilingual, then through the online punctuation
    model. Off by default; a setting "I also speak Arabic" turns it on
    and downloads both.

### Phase 3: interruptible through speakers (three days)

14. **Loopback reference.** The mic process opens a second RtAudio stream
    on the default output device with `loopbackEnabled` (WASAPI loopback;
    audify exposes the option). If that fails, the daemon streams its
    playback frames to the mic process over the local socket with
    timestamps.
15. **Echo cancellation.** `@ennuicastr/webrtcaec3.js` (WebRTC AEC3 in
    WASM, BSD-3, no native build) in the mic process at 48 kHz: analyze
    the reference, process the capture, then decimate to 16 kHz for the
    VAD. Behind it, keep the "we are playing" gate as a second layer:
    while Kik speaks, an interruption needs VAD speech over 0.5 s and at
    least two transcribed words; VAD without words within two seconds is
    a false interruption and Kik resumes. The text-similarity drop stays
    as the last net. GTCRN is a denoiser, not an echo canceller; it can
    follow the AEC, never replace it.
16. **Speech on the speakers as a room signal.** Silero on the loopback
    stream: speakers-speech alternating with owner speech means a call
    (closes the window even when the registry poll missed a browser
    tab); speakers-speech alone means media, which mutes the follow-up
    window the way Alexa does.
17. **Resume after a cut.** If barged in with more than a clause left,
    Kik offers "shall I finish?" once (audit item 10), and the
    conversation memory keeps only the clauses actually spoken before the
    cut, the way the Realtime stacks truncate.

### Phase 4: answering during the sentence (later)

18. Nemotron 560 ms streaming as `stt_model: "stream"`; the sherpa
    endpointer (rule 2 trailing silence 0.8 s) as a second opinion beside
    the turn model; the head gets partial text for the text rules only,
    finals for the prompt. Only worth it once phases 1 to 3 hold, and only
    if the 464 MB download is acceptable in the installer's model fetch.

### The head, across the phases

19. **The prompt knows it is hearing.** A block in `brainSystem()`: the
    transcript is speech recognition; the name may be misspelled (the
    alias list); a fragment continues the last turn; a turn marked low
    confidence gets one short clarifying question rather than a guess;
    what is on the canvas, with positions, and what was last pointed at
    and last mentioned, for "this" and "that".
20. **One turn, aggregated.** The daemon joins pieces of a turn before
    `Brain.reply` (item 7 and 9) and never sends a piece while a reply is
    in flight: it queues, then merges into the next turn if the user kept
    talking, or truncates Kik's stored reply on a barge-in.

## Settings this adds

`call_aware` (on), `owner_only` (on once enrolled), `turn_model` (on),
`stt_model` gains `parakeet`, `parakeet-small`, `omni`, `stream`,
`arabic` (off), `aec` (on when a loopback device opens),
`follow_up_s` (8), `hear_debug` (off).

## What not to do

- Do not use LiveKit's turn detector: its license is limited to LiveKit
  Agents.
- Do not move the mic into an Electron renderer for Chrome's echo
  canceller: it cancels only what Chromium itself plays, and the daemon
  plays through RtAudio. Electron issue 47043 was closed unresolved.
- Do not try Windows' built-in AEC through audify: RtAudio never sets the
  communications stream category, so the OS never inserts it.
- Do not keep tuning Whisper's alias list; the keyword spotter is already
  loaded and the alias list is a losing race.
- Do not ask the model yes or no with the last exchange and nothing else;
  the paper that tested exactly that found it the worst of every option.

## Sources

Turn taking: Pipecat Smart Turn (github.com/pipecat-ai/smart-turn,
huggingface.co/pipecat-ai/smart-turn-v3), the v3.1 post on daily.co,
LiveKit's end-of-turn posts and license (huggingface.co/livekit/turn-
detector), Deepgram "turn detection: silence, VAD, semantic models",
Silero VAD releases and `utils_vad.py`, Vapi voice pipeline
configuration, OpenAI Realtime VAD guide, sherpa endpointing docs.

Recognition: the sherpa-onnx `asr-models` release page, the NeMo and
Moonshine v2 pages in the sherpa docs, nvidia/parakeet-tdt-0.6b-v2 and
nemotron-speech-streaming-en-0.6b model cards, Moonshine v2 paper
(arXiv 2602.12241), sherpa-onnx discussions 2787, issues 2295, 2900 and
3035 (Whisper hallucination and confidence), the Whisper code-switching
study (arXiv 2412.00721).

Addressee: Amazon device-directed detection (arXiv 1808.02504,
Interspeech 2019 huang19i, arXiv 2010.01949), Apple multimodal DDSD
(arXiv 2403.14438) and the follow-up study with the prompt-only result
(arXiv 2411.00023), Apple ReALM (arXiv 2403.20329), Alexa Follow-Up Mode
and Google Continued Conversation help pages, sherpa KWS docs and issue
920, openWakeWord README, the CapabilityAccessManager registry
write-ups (davidarno.org, dfir.pubpub.org).

Echo: `@ennuicastr/webrtcaec3.js` on npm, Chrome's "more native echo
cancellation" post, Electron issue 47043, the Windows
`IAcousticEchoCancellationControl` and signal-processing-modes docs,
RtAudio's WASAPI loopback flag, LiveKit turn-handling options, Pipecat
user-turn start strategies, the GTCRN repository.
