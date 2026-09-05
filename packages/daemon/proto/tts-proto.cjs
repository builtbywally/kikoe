// Phase 0 prototype: the one native risk in the stack, measured.
//
//   Kokoro (sherpa-onnx, CPU) --streams chunks--> audify (RtAudio) --> speakers
//
// Proves three things or fails loudly: the model loads and streams, a chunk
// reaches the sound card before synthesis finishes (TTFA), and an abort
// mid-line silences the speaker promptly. Numbers are printed, not assumed.
//
//   node proto/tts-proto.cjs [modelDir]

const path = require("node:path");
const os = require("node:os");
const sherpa = require("sherpa-onnx-node");
const { RtAudio, RtAudioFormat } = require("audify");

const MODELS = path.join(os.homedir(), ".earshot", "models");
const which = process.argv[2] || "kokoro";
const threads = Number(process.env.THREADS || 2);
const modelCfg =
  which === "piper"
    ? {
        vits: {
          model: path.join(MODELS, "vits-piper-en_GB-alan-medium", "en_GB-alan-medium.onnx"),
          tokens: path.join(MODELS, "vits-piper-en_GB-alan-medium", "tokens.txt"),
          dataDir: path.join(MODELS, "vits-piper-en_GB-alan-medium", "espeak-ng-data"),
        },
      }
    : which === "kokoro32"
      ? {
          kokoro: {
            model: path.join(MODELS, "kokoro-en-v0_19", "model.onnx"),
            voices: path.join(MODELS, "kokoro-en-v0_19", "voices.bin"),
            tokens: path.join(MODELS, "kokoro-en-v0_19", "tokens.txt"),
            dataDir: path.join(MODELS, "kokoro-en-v0_19", "espeak-ng-data"),
          },
        }
      : {
          kokoro: {
            model: path.join(MODELS, "kokoro-int8-en-v0_19", "model.int8.onnx"),
            voices: path.join(MODELS, "kokoro-int8-en-v0_19", "voices.bin"),
            tokens: path.join(MODELS, "kokoro-int8-en-v0_19", "tokens.txt"),
            dataDir: path.join(MODELS, "kokoro-int8-en-v0_19", "espeak-ng-data"),
          },
        };

const FLOAT32 = RtAudioFormat?.RTAUDIO_FLOAT32 || 0x10;
const t = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const t0 = t();
  const tts = new sherpa.OfflineTts({
    model: {
      ...modelCfg,
      numThreads: threads,
      debug: 0,
      provider: "cpu",
    },
    maxNumSentences: 1,
  });
  const loadMs = t() - t0;
  const rate = tts.sampleRate;

  const rt = new RtAudio();
  const dev = rt.getDefaultOutputDevice();
  const frame = 480; // 20 ms at 24 kHz
  rt.openStream(
    { deviceId: dev, nChannels: 1, firstChannel: 0 },
    null,
    FLOAT32,
    rate,
    frame,
    "earshot-proto",
    null,
    null,
  );
  rt.start();

  // audify's write() wants exactly one frame per call, so chunks of any size
  // are re-cut into frame-sized pieces; the tail is padded with silence.
  let pending = new Float32Array(0);
  function push(chunk) {
    const joined = new Float32Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    let off = 0;
    while (joined.length - off >= frame) {
      const f = joined.subarray(off, off + frame);
      rt.write(Buffer.from(f.buffer, f.byteOffset, f.byteLength));
      off += frame;
    }
    pending = joined.slice(off);
  }
  function flush() {
    if (pending.length) {
      const f = new Float32Array(frame);
      f.set(pending);
      rt.write(Buffer.from(f.buffer, f.byteOffset, f.byteLength));
      pending = new Float32Array(0);
    }
  }
  function drop() {
    pending = new Float32Array(0);
    rt.clearOutputQueue();
  }

  async function say(text, { abortAfterMs = 0 } = {}) {
    const start = t();
    let ttfa = null;
    let samples = 0;
    let chunks = 0;
    let aborted = false;
    let abortAt = null;
    let dropMs = 0;
    let timer = null;
    const arm = () => {
      if (!abortAfterMs || timer) return;
      timer = setTimeout(() => {
        aborted = true;
        abortAt = t();
        const d0 = t();
        drop();
        dropMs = t() - d0;
      }, abortAfterMs);
    };
    const res = await tts.generateAsync({
      text,
      sid: 0,
      speed: 1.0,
      onProgress: ({ samples: chunk }) => {
        chunks++;
        if (ttfa === null) {
          ttfa = t() - start;
          arm();
        }
        if (aborted) return false; // stop synthesis
        samples += chunk.length;
        push(chunk);
        return true;
      },
    });
    if (!aborted) flush();
    if (abortAfterMs) {
      // Synthesis may finish before the timer; the abort is about playback.
      const due = (ttfa ?? 0) + abortAfterMs + 80;
      await new Promise((r) => setTimeout(r, Math.max(0, due - (t() - start))));
    }
    if (timer) clearTimeout(timer);
    const synthMs = t() - start;
    const audioS = samples / rate;
    return { text, loadMs, synthMs, ttfa, audioS, chunks, aborted, abortAt, dropMs, start, res };
  }

  const line1 = "Tests pass. Eighteen passed, two failed, all Windows path stuff.";
  const r1 = await say(line1, { abortAfterMs: 900 });
  await sleep(300);
  const r2 = await say("Race is fixed. Three tests still failing.");
  await sleep(r2.audioS * 1000 + 200);
  rt.stop();
  rt.closeStream();

  const row = (k, v) => console.log(k.padEnd(34), v);
  row("backend / threads", which + " / " + threads);
  row("model load", loadMs.toFixed(0) + " ms");
  row("sample rate", rate + " Hz");
  row("device", rt.getDevices().find((d) => d.id === dev)?.name ?? dev);
  console.log("--- line 1 (aborted at ~900 ms) ---");
  row("time to first audio chunk", r1.ttfa?.toFixed(0) + " ms");
  row("chunks before abort", r1.chunks);
  row("aborted", r1.aborted);
  row("queue drop took", r1.dropMs.toFixed(1) + " ms");
  console.log("--- line 2 (full) ---");
  row("time to first audio chunk", r2.ttfa?.toFixed(0) + " ms");
  row("synth total", r2.synthMs.toFixed(0) + " ms");
  row("audio length", r2.audioS.toFixed(2) + " s");
  row("RTF", (r2.synthMs / 1000 / r2.audioS).toFixed(3));
  row("chunks", r2.chunks);
  if (!r1.aborted) process.exitCode = 2;
  if (r2.ttfa === null || r2.ttfa > 700) process.exitCode = 3;
}

main().catch((e) => {
  console.error("proto failed:", e);
  process.exit(1);
});
