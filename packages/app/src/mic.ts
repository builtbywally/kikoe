/**
 * The ear. Runs as its own process (Electron's utility process), because
 * transcription blocks for a few hundred milliseconds and the main process
 * owns the windows and the speaker.
 *
 *   microphone (audify, 16 kHz mono) → Silero VAD → a speech segment →
 *   Whisper (sherpa-onnx, CPU) → text → POST /heard to the daemon
 *
 * Nothing is recorded: the VAD holds a few seconds in memory and a segment
 * is dropped the moment it has been transcribed. Phases (hearing,
 * transcribing) go to the daemon too, so the island and the Room can show
 * what the ear is doing.
 */

import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.env.KIKOE_PORT || 4570);
const TOKEN = process.env.KIKOE_TOKEN || "";
const MODELS = process.env.KIKOE_MODELS || "";
const DEVICE = process.env.KIKOE_MIC_DEVICE || "";
const MODEL = process.env.KIKOE_STT_MODEL || "tiny";
/** drop the recognizer after this long without speech; the VAD stays */
const UNLOAD_MS = 10 * 60 * 1000;
const RATE = 16000;
const FRAME = 320; // 20 ms

let chain: Promise<void> = Promise.resolve();
/** Posts are serialised: each leaves after the last was answered, so the
 *  daemon sees phases in the order they happened. */
function post(route: string, body: unknown): void {
  chain = chain.then(() => send(route, body)).catch(() => {});
}
function send(route: string, body: unknown): Promise<void> {
  return new Promise<void>((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: route,
        method: "POST",
        timeout: 3000,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "content-length": data.length,
        },
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
        res.on("error", () => resolve());
      },
    );
    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.end(data);
  });
}

function say(msg: string): void {
  process.stderr.write(`[mic] ${msg}\n`);
  post("/mic", { phase: "log", text: msg });
}

function main(): void {
  const sherpa = require("sherpa-onnx-node");
  const { RtAudio, RtAudioFormat } = require("audify");

  const vadModel = path.join(MODELS, "silero_vad.onnx");
  // "multi" is base Whisper for every language, finding the language itself;
  // the others hear English only.
  const multi = MODEL === "multi";
  const size = MODEL === "base" || multi ? "base" : "tiny";
  const stem = multi ? size : `${size}.en`;
  const whisperDir = path.join(MODELS, `sherpa-onnx-whisper-${stem}`);
  const encoder = path.join(whisperDir, `${stem}-encoder.int8.onnx`);
  const decoder = path.join(whisperDir, `${stem}-decoder.int8.onnx`);
  const tokens = path.join(whisperDir, `${stem}-tokens.txt`);
  for (const f of [vadModel, encoder, decoder, tokens]) {
    if (!existsSync(f)) {
      say(`model missing: ${f}`);
      post("/mic", { phase: "dead", text: `model missing: ${path.basename(f)}` });
      process.exit(2);
    }
  }

  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: vadModel,
        threshold: 0.5,
        // a person pauses after the name; that pause must not end the segment
        minSilenceDuration: 1.0,
        minSpeechDuration: 0.25,
        maxSpeechDuration: 15,
        windowSize: 512,
      },
      sampleRate: RATE,
      numThreads: 1,
      debug: 0,
    },
    30,
  );
  let recognizer: any = null;
  let lastSpeechAt = Date.now();
  function loadRecognizer(): any {
    if (recognizer) return recognizer;
    const t0 = Date.now();
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: RATE, featureDim: 80 },
      modelConfig: {
        // an empty language asks the multilingual model to find it
        whisper: {
          encoder,
          decoder,
          language: multi ? "" : "en",
          task: "transcribe",
          tailPaddings: -1,
        },
        tokens,
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
    });
    say(`whisper ${size} loaded in ${Date.now() - t0} ms`);
    return recognizer;
  }
  loadRecognizer();
  // An idle ear holds only the VAD. The first sound after a quiet spell
  // pays the load again, well under a second.
  setInterval(() => {
    if (recognizer && Date.now() - lastSpeechAt > UNLOAD_MS) {
      recognizer = null;
      say("whisper unloaded after a quiet spell");
      post("/mic", { phase: "unloaded" });
    }
  }, 60_000);

  const rt = new RtAudio();
  const devices: any[] = rt.getDevices();
  let id = rt.getDefaultInputDevice();
  if (DEVICE) {
    const hit = devices.find(
      (d) => d.inputChannels > 0 && String(d.name).toLowerCase().includes(DEVICE.toLowerCase()),
    );
    if (hit) id = hit.id;
  }
  const dev = devices.find((d) => d.id === id);
  const FLOAT32 = RtAudioFormat?.RTAUDIO_FLOAT32 || 0x10;

  // Prefer 16 kHz at the device; fall back to 48 kHz and decimate by three.
  let rate = RATE;
  let decimate = 1;
  const open = (r: number, frames: number) =>
    rt.openStream(
      null,
      { deviceId: id, nChannels: 1, firstChannel: 0 },
      FLOAT32,
      r,
      frames,
      "kikoe-mic",
      onInput,
      null,
    );
  try {
    open(RATE, FRAME);
  } catch (e) {
    say(`16 kHz refused (${(e as Error).message}); opening at 48 kHz`);
    rate = 48000;
    decimate = 3;
    open(48000, FRAME * 3);
  }

  let hearing = false;
  let lastPhaseAt = 0;
  let livePeak = 0;
  let liveAt = 0;

  // The mode (daemon/src/micmode.ts). Muted and push-to-talk close the
  // device's stream, so the OS shows the mic as off; the process stays up,
  // because the phone's clips are transcribed here too.
  let mode = (process.env.KIKOE_MIC_MODE || "open") as "open" | "muted" | "push";
  let talking = false;
  let talkTimer: ReturnType<typeof setTimeout> | null = null;
  let streaming = false;
  const live = () => mode === "open" || (mode === "push" && talking);
  function setStream(on: boolean): void {
    if (on === streaming) return;
    try {
      if (on) rt.start();
      else rt.stop();
      streaming = on;
    } catch (e) {
      say(`could not ${on ? "open" : "close"} the stream: ${(e as Error).message}`);
    }
    if (!on) {
      try {
        vad.reset?.();
      } catch {
        /* an older sherpa has no reset; the next speech starts it over */
      }
      if (hearing) post("/mic", { phase: "idle" });
      hearing = false;
    }
  }
  /** One push-to-talk sentence is over: hear what is left, then close. */
  function endTalk(): void {
    if (talkTimer) clearTimeout(talkTimer);
    talkTimer = null;
    if (!talking) return;
    talking = false;
    try {
      vad.flush?.();
    } catch {
      /* nothing buffered */
    }
    while (!vad.isEmpty()) {
      const seg = vad.front(false);
      vad.pop();
      transcribe(seg.samples, seg.samples.length / RATE, true);
    }
    // never from inside the audio callback: stopping a stream there can wait
    // on the callback itself
    setImmediate(() => {
      if (!live()) setStream(false);
      post("/mic", { phase: mode });
    });
  }
  let peak = 0;
  let frames = 0;

  function onInput(buf: Buffer): void {
    let samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (decimate > 1) {
      const out = new Float32Array(Math.floor(samples.length / decimate));
      for (let i = 0; i < out.length; i++) {
        const j = i * decimate;
        out[i] = ((samples[j] ?? 0) + (samples[j + 1] ?? 0) + (samples[j + 2] ?? 0)) / 3;
      }
      samples = out;
    }
    for (const v of samples) if (v > peak) peak = v;
    frames++;
    // While push to talk is open, the level goes out often enough to draw a
    // meter: the proof, before a word lands, that the key did something.
    if (talking) {
      for (const v of samples) if (v > livePeak) livePeak = v;
      if (Date.now() - liveAt > 120) {
        liveAt = Date.now();
        post("/mic", { phase: "level", live: true, peak: Number(livePeak.toFixed(3)) });
        livePeak = 0;
      }
    }
    vad.acceptWaveform(samples);
    const detected: boolean = vad.isDetected();
    if (detected) {
      lastSpeechAt = Date.now();
      if (!recognizer) loadRecognizer();
    }
    if (detected !== hearing) {
      hearing = detected;
      post("/mic", { phase: hearing ? "hearing" : "idle" });
    }
    if (Date.now() - lastPhaseAt > 10_000) {
      lastPhaseAt = Date.now();
      post("/mic", { phase: "level", peak: Number(peak.toFixed(3)), frames });
      peak = 0;
    }
    while (!vad.isEmpty()) {
      // Electron forbids external ArrayBuffers; ask for a copy
      const seg = vad.front(false);
      vad.pop();
      const pushed = mode === "push" && talking;
      transcribe(seg.samples, seg.samples.length / RATE, pushed);
      // push to talk is one sentence
      if (pushed) endTalk();
    }
  }

  function recognize(samples: Float32Array): string {
    const rec = loadRecognizer();
    const stream = rec.createStream();
    // A quarter second of silence on each side: without it Whisper dropped
    // the last words of a clip that ends as the speech does (Lebanese Arabic,
    // 2026-09-24: "شو عم تعمل هلق" came out "شرم تعم"; padded, it was right).
    const pad = Math.round(RATE * 0.25);
    const padded = new Float32Array(samples.length + pad * 2);
    padded.set(samples, pad);
    stream.acceptWaveform({ samples: padded, sampleRate: RATE });
    rec.decode(stream);
    return String(rec.getResult(stream).text ?? "").trim();
  }

  function transcribe(samples: Float32Array, durS: number, pushed = false): void {
    post("/mic", { phase: "transcribing" });
    const t = Date.now();
    const text = recognize(samples);
    post("/heard", {
      text,
      dur_s: Number(durS.toFixed(2)),
      stt_ms: Date.now() - t,
      ...(pushed ? { ptt: true } : {}),
    });
  }

  /**
   * A clip from somewhere that is not this microphone — the phone, held as a
   * walkie-talkie. It arrives as the 16 kHz Int16 the page already made, and
   * the answer goes back the way it came rather than to /heard, because the
   * daemon is waiting on it to answer an HTTP request.
   */
  process.parentPort?.on(
    "message",
    (e: { data?: { type?: string; id?: number; pcm?: unknown; mode?: string; on?: boolean } }) => {
      const m = e?.data;
      if (m?.type === "mode") {
        mode = m.mode === "muted" || m.mode === "push" ? m.mode : "open";
        talking = false;
        if (talkTimer) clearTimeout(talkTimer);
        setStream(live());
        say(`mode ${mode}`);
        post("/mic", { phase: mode });
        return;
      }
      if (m?.type === "talk") {
        if (mode !== "push") return;
        // the key again, while talking, ends the sentence
        if (talking || m.on === false) return endTalk();
        talking = true;
        setStream(true);
        post("/mic", { phase: "push-open" });
        // nothing said in 20 s closes it again
        talkTimer = setTimeout(endTalk, 20_000);
        return;
      }
      if (m?.type !== "clip" || typeof m.id !== "number") return;
      let text = "";
      try {
        const pcm = m.pcm as Int16Array;
        const samples = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) samples[i] = (pcm[i] ?? 0) / 32768;
        lastSpeechAt = Date.now();
        const t = Date.now();
        text = recognize(samples);
        say(`walkie clip ${(pcm.length / RATE).toFixed(1)}s -> "${text}" in ${Date.now() - t} ms`);
      } catch (err) {
        say(`walkie clip failed: ${(err as Error).message}`);
      }
      process.parentPort?.postMessage({ type: "clip", id: m.id, text });
    },
  );

  setStream(live());
  post("/mic", { phase: "ready", text: String(dev?.name ?? id), rate });
  if (mode !== "open") post("/mic", { phase: mode });
  say(`${mode === "open" ? "listening" : mode} on ${dev?.name ?? id} at ${rate} Hz`);

  process.on("SIGTERM", () => {
    try {
      if (streaming) rt.stop();
      rt.closeStream();
    } catch {
      /* closing */
    }
    process.exit(0);
  });
}

try {
  main();
} catch (e) {
  process.stderr.write(`[mic] failed: ${(e as Error).stack ?? e}\n`);
  post("/mic", { phase: "dead", text: (e as Error).message });
  setTimeout(() => process.exit(1), 200);
}
