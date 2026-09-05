// Phase 0 end-to-end: real Claude Code hook payloads (the eval fixtures) run
// through the ported adapter and narrator, and every line that survives is
// spoken through sherpa-onnx into audify. What you hear is the product's
// judgement: most fixtures should produce nothing.
//
//   node proto/demo.mjs [piper|kokoro32] [--no-audio]

import { readFileSync, readdirSync } from "node:fs";
import https from "node:https";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter, Narrator } from "@kikoe/core";

const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx-node");
const { RtAudio, RtAudioFormat } = require("audify");

const which =
  process.argv.find((a) => !a.startsWith("--") && /^(piper|kokoro32|kokoro|eleven)$/.test(a)) ??
  "piper";
const noAudio = process.argv.includes("--no-audio");
const MODELS = path.join(os.homedir(), ".kikoe", "models");
const EVALS = fileURLToPath(new URL("../../../evals/", import.meta.url));
const CWD = "/repo/storefront";
const t = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const modelCfg =
  which === "piper"
    ? {
        vits: {
          model: path.join(MODELS, "vits-piper-en_GB-alan-medium", "en_GB-alan-medium.onnx"),
          tokens: path.join(MODELS, "vits-piper-en_GB-alan-medium", "tokens.txt"),
          dataDir: path.join(MODELS, "vits-piper-en_GB-alan-medium", "espeak-ng-data"),
        },
      }
    : {
        kokoro: {
          model: path.join(MODELS, "kokoro-en-v0_19", "model.onnx"),
          voices: path.join(MODELS, "kokoro-en-v0_19", "voices.bin"),
          tokens: path.join(MODELS, "kokoro-en-v0_19", "tokens.txt"),
          dataDir: path.join(MODELS, "kokoro-en-v0_19", "espeak-ng-data"),
        },
      };

const HOME = path.join(os.homedir(), ".kikoe");
function readCfg() {
  try {
    return JSON.parse(readFileSync(path.join(HOME, "config.local.json"), "utf8"));
  } catch {
    return {};
  }
}
function elevenKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  try {
    return readFileSync(path.join(HOME, "elevenlabs_key.txt"), "utf8").trim();
  } catch {
    return "";
  }
}

function makeElevenSpeaker() {
  const cfg = readCfg();
  const key = elevenKey();
  const voice = process.env.KIKOE_ELEVEN_VOICE || cfg.elevenlabs_voice;
  const model = process.env.KIKOE_ELEVEN_MODEL || cfg.elevenlabs_model || "eleven_flash_v2_5";
  if (!key) throw new Error("no ElevenLabs key: ~/.kikoe/elevenlabs_key.txt or ELEVENLABS_API_KEY");
  if (!voice)
    throw new Error("no ElevenLabs voice id: elevenlabs_voice in ~/.kikoe/config.local.json");
  const rate = 24000;
  const frame = rate / 50;
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  let rt = null;
  if (!noAudio) {
    rt = new RtAudio();
    rt.openStream(
      { deviceId: rt.getDefaultOutputDevice(), nChannels: 1, firstChannel: 0 },
      null,
      RtAudioFormat?.RTAUDIO_FLOAT32 || 0x10,
      rate,
      frame,
      "kikoe-demo",
      null,
      null,
    );
    rt.start();
  }
  let pending = new Float32Array(0);
  const push = (chunk) => {
    const joined = new Float32Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    let off = 0;
    for (; joined.length - off >= frame; off += frame) {
      const f = joined.subarray(off, off + frame);
      rt?.write(Buffer.from(f.buffer, f.byteOffset, f.byteLength));
    }
    pending = joined.slice(off);
  };
  const flush = () => {
    if (pending.length) {
      const f = new Float32Array(frame);
      f.set(pending);
      rt?.write(Buffer.from(f.buffer, f.byteOffset, f.byteLength));
      pending = new Float32Array(0);
    }
  };
  // Prime the connection: TLS + HTTP setup is the single worst latency on
  // the first line and invisible on every later one.
  const prime = () =>
    new Promise((resolve) => {
      const req = https.request(
        {
          host: "api.elevenlabs.io",
          path: "/v1/user",
          method: "GET",
          agent,
          headers: { "xi-api-key": key },
        },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      req.on("error", () => resolve());
      req.end();
    });
  return {
    rate,
    label: `eleven ${model} voice ${voice.slice(0, 6)}…`,
    prime,
    say(text) {
      return new Promise((resolve, reject) => {
        const start = t();
        let ttfa = null;
        let samples = 0;
        let carry = null;
        const body = JSON.stringify({ text, model_id: model });
        const req = https.request(
          {
            host: "api.elevenlabs.io",
            method: "POST",
            agent,
            path: `/v1/text-to-speech/${voice}/stream?output_format=pcm_24000`,
            headers: {
              "xi-api-key": key,
              "content-type": "application/json",
              accept: "audio/pcm",
              "content-length": Buffer.byteLength(body),
            },
          },
          (res) => {
            if (res.statusCode !== 200) {
              let err = "";
              res.on("data", (d) => {
                err += d;
              });
              res.on("end", () =>
                reject(new Error(`elevenlabs ${res.statusCode}: ${err.slice(0, 200)}`)),
              );
              return;
            }
            res.on("data", (incoming) => {
              if (ttfa === null) ttfa = t() - start;
              let buf = incoming;
              if (carry) {
                buf = Buffer.concat([carry, incoming]);
                carry = null;
              }
              const even = buf.length - (buf.length % 2);
              if (even < buf.length) carry = buf.subarray(even);
              const n = even / 2;
              const f = new Float32Array(n);
              for (let i = 0; i < n; i++) f[i] = buf.readInt16LE(i * 2) / 32768;
              samples += n;
              push(f);
            });
            res.on("end", async () => {
              flush();
              const audioS = samples / rate;
              if (rt) await sleep(audioS * 1000 + 150);
              resolve({ ttfa, audioS });
            });
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    },
    close() {
      agent.destroy();
      if (rt) {
        rt.stop();
        rt.closeStream();
      }
    },
  };
}

function makeSpeaker() {
  if (which === "eleven") return makeElevenSpeaker();
  const tts = new sherpa.OfflineTts({
    model: { ...modelCfg, numThreads: which === "piper" ? 2 : 6, debug: 0, provider: "cpu" },
    maxNumSentences: 1,
  });
  const rate = tts.sampleRate;
  const frame = Math.round(rate / 50);
  let rt = null;
  if (!noAudio) {
    rt = new RtAudio();
    rt.openStream(
      { deviceId: rt.getDefaultOutputDevice(), nChannels: 1, firstChannel: 0 },
      null,
      RtAudioFormat?.RTAUDIO_FLOAT32 || 0x10,
      rate,
      frame,
      "kikoe-demo",
      null,
      null,
    );
    rt.start();
  }
  let pending = new Float32Array(0);
  const push = (chunk) => {
    const joined = new Float32Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    let off = 0;
    for (; joined.length - off >= frame; off += frame) {
      const f = joined.subarray(off, off + frame);
      rt?.write(Buffer.from(f.buffer, f.byteOffset, f.byteLength));
    }
    pending = joined.slice(off);
  };
  const flush = () => {
    if (pending.length) {
      const f = new Float32Array(frame);
      f.set(pending);
      rt?.write(Buffer.from(f.buffer, f.byteOffset, f.byteLength));
      pending = new Float32Array(0);
    }
  };
  return {
    rate,
    async say(text) {
      const start = t();
      let ttfa = null;
      let samples = 0;
      await tts.generateAsync({
        text,
        sid: 0,
        speed: 1.0,
        onProgress: ({ samples: c }) => {
          if (ttfa === null) ttfa = t() - start;
          samples += c.length;
          push(c);
          return true;
        },
      });
      flush();
      const audioS = samples / rate;
      if (rt) await sleep(audioS * 1000 + 150);
      return { ttfa, audioS };
    },
    close() {
      if (rt) {
        rt.stop();
        rt.closeStream();
      }
    },
  };
}

function narrate(fixture) {
  let offset = 0;
  const now = () => Date.now() / 1000 + offset;
  const narrator = new Narrator({ mode: fixture.mode ?? "normal", now });
  const adapter = new ClaudeCodeAdapter({ cwd: CWD, now });
  const lines = [];
  for (const hook of fixture.hooks) {
    const e = adapter.ingestHook({ ...hook, session_id: "demo", cwd: CWD });
    if (e) lines.push(...narrator.narrate(e));
  }
  if (fixture.settle) offset += 60;
  lines.push(...narrator.tick());
  return lines;
}

const fixtures = readdirSync(EVALS)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(path.join(EVALS, f), "utf8")));

const speaker = makeSpeaker();
console.log(`voice: ${which} @ ${speaker.rate} Hz${noAudio ? " (no audio)" : ""}\n`);
let spoken = 0;
let silent = 0;
const ttfas = [];
for (const fx of fixtures) {
  const lines = narrate(fx);
  const hooks = fx.hooks
    .map((h) => h.hook_event_name + (h.tool_name ? ":" + h.tool_name : ""))
    .join(", ");
  console.log(`${fx.name}\n  hooks: ${hooks}`);
  if (!lines.length) {
    silent++;
    console.log("  → (silence)\n");
    continue;
  }
  for (const u of lines) {
    spoken++;
    const { ttfa } = await speaker.say(u.text);
    ttfas.push(ttfa);
    console.log(
      `  → [p${u.priority}${u.preempt ? " preempt" : ""}] "${u.text}"  (first audio ${ttfa.toFixed(0)} ms)`,
    );
  }
  console.log();
}
speaker.close();
ttfas.sort((a, b) => a - b);
console.log(`fixtures: ${fixtures.length}  silent: ${silent}  lines spoken: ${spoken}`);
console.log(
  `first audio: p50 ${ttfas[Math.floor(ttfas.length / 2)].toFixed(0)} ms  max ${ttfas[ttfas.length - 1].toFixed(0)} ms`,
);
