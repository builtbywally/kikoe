/**
 * The TTS ladder. Each rung streams audio into the speaker as it is made;
 * the first rung that works is promoted. `streamTo` is the only interface,
 * and a rung that fails mid-line lets the next one try, unless strict mode
 * says this voice and no other.
 *
 *   piper    bundled, local, ~60 ms to first sound      the default
 *   kokoro   downloaded, local, ~400 ms                  the quality rung
 *   eleven   cloud, your key, ~180 ms                    the best voice
 *   system   say / PowerShell / spd-say                  always there
 *
 * A line may carry a voice hint (which rung, which voice) so that different
 * repos can sound different. The hint is tried first; the ladder is the
 * fallback.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import https from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import { splitClauses } from "@kikoe/core";
import { MODELS, type Settings, elevenKeyFromFile, log } from "./config.js";
import type { Speaker } from "./speaker.js";

const require = createRequire(import.meta.url);

export interface SpokenResult {
  backend: string;
  ttfaMs: number;
  audioS: number;
}

/** Which rung and which voice within it. Both optional. */
export interface VoiceHint {
  backend?: string;
  /** ElevenLabs voice id, or a Kokoro speaker number */
  voice?: string;
}

export interface Rung {
  readonly name: string;
  /** cheap check: can this rung possibly work right now? */
  available(): boolean;
  /** synthesise and push into the speaker; honour the signal */
  streamTo(
    text: string,
    speaker: Speaker,
    signal: AbortSignal,
    voice?: string,
  ): Promise<SpokenResult>;
  close?(): void;
}

// --- sherpa-onnx local rungs ------------------------------------------------

type SherpaModel = { vits?: Record<string, string>; kokoro?: Record<string, string> };

/**
 * Loaded engines outlive the ladder that made them: switching voices rebuilds
 * the ladder, and reloading a 350 MB model on every switch is how the main
 * process ends up a gigabyte heavier per click. Idle heavy engines are
 * dropped after a while and reloaded on demand.
 */
const ENGINES = new Map<
  string,
  { tts: any; lastUsed: number; heavy: boolean; busy: Promise<void> }
>();
export const UNLOAD_AFTER_MS = 10 * 60 * 1000;

export function unloadIdleEngines(now = Date.now()): string[] {
  const dropped: string[] = [];
  for (const [key, e] of ENGINES) {
    if (e.heavy && now - e.lastUsed > UNLOAD_AFTER_MS) {
      ENGINES.delete(key);
      dropped.push(key.includes("kokoro") ? "kokoro" : "piper");
    }
  }
  return dropped;
}

export function loadedEngines(): string[] {
  return [...ENGINES.keys()].map((k) => (k.includes("kokoro") ? "kokoro" : "piper"));
}

abstract class SherpaRung implements Rung {
  abstract readonly name: string;
  protected abstract modelConfig(): SherpaModel | null;
  protected threads = 2;
  protected heavy = false;

  available(): boolean {
    return this.modelConfig() !== null;
  }

  protected engine(): any {
    const cfg = this.modelConfig();
    if (!cfg) throw new Error(`${this.name}: model files missing`);
    const key = JSON.stringify(cfg);
    const cached = ENGINES.get(key);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached.tts;
    }
    const sherpa = require("sherpa-onnx-node");
    const tts = new sherpa.OfflineTts({
      model: { ...cfg, numThreads: this.threads, debug: 0, provider: "cpu" },
      maxNumSentences: 1,
    });
    ENGINES.set(key, { tts, lastUsed: Date.now(), heavy: this.heavy, busy: Promise.resolve() });
    return tts;
  }

  async streamTo(
    text: string,
    speaker: Speaker,
    signal: AbortSignal,
    voice?: string,
  ): Promise<SpokenResult> {
    const tts = this.engine();
    // sherpa's engines are not re-entrant: a preempted line is still inside
    // generateAsync until its next chunk, so the next line waits for it.
    const key = JSON.stringify(this.modelConfig());
    const slot = ENGINES.get(key)!;
    const previous = slot.busy;
    let release: () => void = () => {};
    slot.busy = new Promise<void>((r) => {
      release = r;
    });
    await previous.catch(() => {});
    if (signal.aborted) {
      release();
      throw new Error("cancelled");
    }
    try {
      return await this.generate(tts, text, speaker, signal, voice);
    } finally {
      release();
    }
  }

  private async generate(
    tts: any,
    text: string,
    speaker: Speaker,
    signal: AbortSignal,
    voice?: string,
  ): Promise<SpokenResult> {
    const rate: number = tts.sampleRate;
    const speakers: number = tts.numSpeakers ?? 1;
    const sid = Math.max(0, Math.min(speakers - 1, Number.parseInt(voice ?? "0", 10) || 0));
    const start = performance.now();
    let ttfa = -1;
    let samples = 0;
    await tts.generateAsync({
      text,
      sid,
      speed: 1.0,
      onProgress: ({ samples: chunk }: { samples: Float32Array }) => {
        if (signal.aborted) return false;
        if (ttfa < 0) ttfa = performance.now() - start;
        samples += chunk.length;
        speaker.push(chunk, rate);
        return true;
      },
    });
    if (signal.aborted) throw new Error("cancelled");
    speaker.flush();
    return { backend: this.name, ttfaMs: ttfa, audioS: samples / rate };
  }
}

export class PiperRung extends SherpaRung {
  readonly name = "piper";
  private readonly dir: string;
  constructor(dir?: string) {
    super();
    this.dir = dir ?? findPiperDir();
  }
  protected modelConfig(): SherpaModel | null {
    if (!this.dir) return null;
    const onnx = firstFile(this.dir, /\.onnx$/);
    const tokens = path.join(this.dir, "tokens.txt");
    const data = path.join(this.dir, "espeak-ng-data");
    if (!onnx || !existsSync(tokens) || !existsSync(data)) return null;
    return { vits: { model: onnx, tokens, dataDir: data } };
  }
}

export const KOKORO_DIR = () => path.join(MODELS, "kokoro-en-v0_19");

export class KokoroRung extends SherpaRung {
  readonly name = "kokoro";
  protected threads = 6;
  protected heavy = true;
  protected modelConfig(): SherpaModel | null {
    const dir = KOKORO_DIR();
    const model = path.join(dir, "model.onnx"); // fp32: int8 is four times slower on CPU
    const voices = path.join(dir, "voices.bin");
    const tokens = path.join(dir, "tokens.txt");
    const data = path.join(dir, "espeak-ng-data");
    if (![model, voices, tokens, data].every(existsSync)) return null;
    return { kokoro: { model, voices, tokens, dataDir: data } };
  }
}

function firstFile(dir: string, re: RegExp): string {
  try {
    const hit = readdirSync(dir).find((f) => re.test(f));
    return hit ? path.join(dir, hit) : "";
  } catch {
    return "";
  }
}

/** The bundled Piper voice, or the one in the models directory. */
export function findPiperDir(): string {
  const candidates = [
    process.env.KIKOE_PIPER_DIR ?? "",
    path.join(MODELS, "vits-piper-en_GB-alan-medium"),
    path.join(
      (process as unknown as { resourcesPath?: string }).resourcesPath ?? "",
      "models",
      "vits-piper-en_GB-alan-medium",
    ),
  ].filter(Boolean);
  return candidates.find((d) => existsSync(path.join(d, "tokens.txt"))) ?? "";
}

// --- ElevenLabs -------------------------------------------------------------

export class ElevenRung implements Rung {
  readonly name = "eleven";
  private readonly key: string;
  private readonly voice: string;
  private readonly model: string;
  private readonly agent = new https.Agent({ keepAlive: true, maxSockets: 2 });
  private primed = false;

  constructor(opts: { key?: string; voice: string; model: string }) {
    this.key = opts.key ?? elevenKeyFromFile();
    this.voice = opts.voice;
    this.model = opts.model;
  }

  available(): boolean {
    return Boolean(this.key && this.voice);
  }

  /** TLS and HTTP setup are the worst latency on the first line; pay it early. */
  prime(): Promise<void> {
    if (this.primed || !this.available()) return Promise.resolve();
    this.primed = true;
    return new Promise((resolve) => {
      const req = https.request(
        {
          host: "api.elevenlabs.io",
          path: "/v1/user",
          method: "GET",
          agent: this.agent,
          headers: { "xi-api-key": this.key },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", () => resolve());
      req.end();
    });
  }

  /**
   * Long lines go clause by clause: the cloud starts each request from the
   * beginning, so a forty-word sentence pays its whole synthesis before the
   * first sound. Two short requests on a kept-alive socket start sooner.
   */
  async streamTo(
    text: string,
    speaker: Speaker,
    signal: AbortSignal,
    voice?: string,
  ): Promise<SpokenResult> {
    const clauses = splitClauses(text, 90);
    if (clauses.length <= 1) return this.one(text, speaker, signal, voice);
    let ttfa = -1;
    let audio = 0;
    for (const c of clauses) {
      const r = await this.one(c, speaker, signal, voice);
      if (ttfa < 0) ttfa = r.ttfaMs;
      audio += r.audioS;
    }
    return { backend: this.name, ttfaMs: ttfa, audioS: audio };
  }

  private one(
    text: string,
    speaker: Speaker,
    signal: AbortSignal,
    voice?: string,
  ): Promise<SpokenResult> {
    const rate = 24000;
    const voiceId = voice || this.voice;
    return new Promise((resolve, reject) => {
      const start = performance.now();
      let ttfa = -1;
      let samples = 0;
      let carry: Buffer | null = null;
      const body = JSON.stringify({ text, model_id: this.model });
      const req = https.request(
        {
          host: "api.elevenlabs.io",
          method: "POST",
          agent: this.agent,
          path: `/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000`,
          headers: {
            "xi-api-key": this.key,
            "content-type": "application/json",
            accept: "audio/pcm",
            "content-length": Buffer.byteLength(body),
          },
          timeout: 15000,
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
          res.on("data", (incoming: Buffer) => {
            if (signal.aborted) {
              req.destroy();
              return;
            }
            if (ttfa < 0) ttfa = performance.now() - start;
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
            speaker.push(f, rate);
          });
          res.on("end", () => {
            if (signal.aborted) return reject(new Error("cancelled"));
            speaker.flush();
            resolve({ backend: this.name, ttfaMs: ttfa, audioS: samples / rate });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("elevenlabs: timed out")));
      req.on("error", (e) => reject(signal.aborted ? new Error("cancelled") : e));
      signal.addEventListener("abort", () => req.destroy(), { once: true });
      req.end(body);
    });
  }

  close(): void {
    this.agent.destroy();
  }
}

// --- the system voice, the floor --------------------------------------------

export class SystemRung implements Rung {
  readonly name = "system";
  available(): boolean {
    return ["win32", "darwin", "linux"].includes(process.platform);
  }
  streamTo(text: string, _speaker: Speaker, signal: AbortSignal): Promise<SpokenResult> {
    const start = performance.now();
    return new Promise((resolve, reject) => {
      let cmd: string;
      let args: string[];
      if (process.platform === "darwin") {
        cmd = "say";
        args = [text];
      } else if (process.platform === "win32") {
        cmd = "powershell";
        const safe = text.replace(/'/g, "''");
        args = [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${safe}')`,
        ];
      } else {
        cmd = "spd-say";
        args = ["-w", text];
      }
      const child = execFile(cmd, args, { windowsHide: true }, (err) => {
        if (signal.aborted) return reject(new Error("cancelled"));
        if (err) return reject(err);
        resolve({ backend: this.name, ttfaMs: performance.now() - start, audioS: 0 });
      });
      signal.addEventListener("abort", () => child.kill(), { once: true });
    });
  }
}

// --- the ladder -------------------------------------------------------------

export interface LadderOptions {
  settings: Settings;
  elevenKey?: string;
}

export class Ladder {
  readonly rungs: Rung[];
  readonly strict: boolean;
  private readonly byName = new Map<string, Rung>();
  private promoted: Rung | null = null;
  lastBackend = "";

  constructor(opts: LadderOptions) {
    const s = opts.settings;
    const eleven = new ElevenRung({
      key: opts.elevenKey ?? elevenKeyFromFile(),
      voice: s.elevenlabs_voice,
      model: s.elevenlabs_model,
    });
    const piper = new PiperRung();
    const kokoro = new KokoroRung();
    const system = new SystemRung();
    for (const r of [eleven, piper, kokoro, system]) if (r.available()) this.byName.set(r.name, r);
    const order: Rung[] = [];
    switch (s.tts) {
      case "eleven":
        order.push(eleven, piper, kokoro, system);
        break;
      case "kokoro":
        order.push(kokoro, piper, eleven, system);
        break;
      case "piper":
        order.push(piper, kokoro, eleven, system);
        break;
      case "system":
        order.push(system);
        break;
      case "none":
        // Nothing speaks. Tests use this so a suite never reaches the OS voice.
        break;
      default:
        order.push(eleven.available() ? eleven : piper, piper, kokoro, system);
    }
    this.rungs = [...new Set(order)].filter((r) => r.available());
    this.strict = s.tts_strict;
    if (eleven.available()) void eleven.prime();
    log(
      `tts ladder: ${this.rungs.map((r) => r.name).join(" > ") || "(none)"}${this.strict ? " strict" : ""}`,
    );
  }

  get names(): string[] {
    return this.rungs.map((r) => r.name);
  }

  async speak(
    text: string,
    speaker: Speaker,
    signal: AbortSignal,
    hint: VoiceHint = {},
  ): Promise<SpokenResult> {
    const order: Rung[] = [];
    const hinted = hint.backend ? this.byName.get(hint.backend) : undefined;
    if (hinted) order.push(hinted);
    if (this.promoted) order.push(this.promoted);
    order.push(...this.rungs);
    const tried = [...new Set(order)];
    let lastErr: unknown = new Error("no TTS backend available");
    for (const rung of this.strict ? tried.slice(0, 1) : tried) {
      if (signal.aborted) throw new Error("cancelled");
      try {
        const res = await rung.streamTo(
          text,
          speaker,
          signal,
          rung === hinted ? hint.voice : undefined,
        );
        if (rung !== hinted) this.promoted = rung;
        this.lastBackend = rung.name;
        return res;
      } catch (e) {
        lastErr = e;
        if ((e as Error).message === "cancelled") throw e;
        log(`tts ${rung.name} failed: ${(e as Error).message}`);
        if (rung === this.promoted) this.promoted = null;
        speaker.drop();
      }
    }
    throw lastErr;
  }

  close(): void {
    for (const r of this.rungs) r.close?.();
  }
}
