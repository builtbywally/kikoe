/**
 * Model downloads, on demand, into `~/.kikoe/models`. Nothing large is
 * bundled. Archives are sherpa-onnx's own `.tar.bz2` releases, unpacked with
 * the platform's `tar` (bsdtar on Windows 10+, macOS and every Linux).
 */

import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MODELS, log } from "./config.js";

export interface ModelSpec {
  name: string;
  dir: string;
  url: string;
  /** bytes, for the progress bar; the download reports the real total */
  size: number;
  /** a file that only exists when the unpack completed */
  marker: string;
}

const BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/";

export const KOKORO: ModelSpec = {
  name: "kokoro",
  dir: "kokoro-en-v0_19",
  url: `${BASE}kokoro-en-v0_19.tar.bz2`,
  size: 319_625_534,
  marker: "voices.bin",
};

export const PIPER: ModelSpec = {
  name: "piper",
  dir: "vits-piper-en_GB-alan-medium",
  url: `${BASE}vits-piper-en_GB-alan-medium.tar.bz2`,
  size: 67_220_121,
  marker: "tokens.txt",
};

const ASR = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/";

export const WHISPER_TINY: ModelSpec = {
  name: "whisper-tiny",
  dir: "sherpa-onnx-whisper-tiny.en",
  url: `${ASR}sherpa-onnx-whisper-tiny.en.tar.bz2`,
  size: 118_071_777,
  marker: "tiny.en-tokens.txt",
};

export const WHISPER_BASE: ModelSpec = {
  name: "whisper-base",
  dir: "sherpa-onnx-whisper-base.en",
  url: `${ASR}sherpa-onnx-whisper-base.en.tar.bz2`,
  size: 208_576_005,
  marker: "base.en-tokens.txt",
};

/** The VAD is a single file, not an archive. */
export const VAD_URL = `${ASR}silero_vad.onnx`;

export const SPECS: Record<string, ModelSpec> = {
  kokoro: KOKORO,
  piper: PIPER,
  "whisper-tiny": WHISPER_TINY,
  "whisper-base": WHISPER_BASE,
};

/** Fetch the VAD file if it is missing. Small, so no progress. */
export async function fetchVad(): Promise<string> {
  const file = path.join(MODELS, "silero_vad.onnx");
  if (existsSync(file)) return file;
  mkdirSync(MODELS, { recursive: true });
  const res = await fetch(VAD_URL, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(file));
  log("model vad: installed");
  return file;
}

export function installed(spec: ModelSpec): boolean {
  return existsSync(path.join(MODELS, spec.dir, spec.marker));
}

export type Progress = (p: {
  phase: "download" | "unpack" | "done";
  received: number;
  total: number;
}) => void;

/** Download and unpack. Idempotent: an installed model returns at once. */
export async function fetchModel(
  spec: ModelSpec,
  onProgress: Progress = () => {},
): Promise<string> {
  const dest = path.join(MODELS, spec.dir);
  if (installed(spec)) {
    onProgress({ phase: "done", received: spec.size, total: spec.size });
    return dest;
  }
  mkdirSync(MODELS, { recursive: true });
  const archive = path.join(MODELS, `${spec.dir}.tar.bz2.part`);
  log(`model ${spec.name}: downloading ${spec.url}`);

  const res = await fetch(spec.url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? spec.size) || spec.size;
  let received = 0;
  const counter = new (await import("node:stream")).Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      onProgress({ phase: "download", received, total });
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(archive));
  if (statSync(archive).size < 1024) throw new Error("download produced an empty file");

  onProgress({ phase: "unpack", received: total, total });
  rmSync(dest, { recursive: true, force: true });
  await new Promise<void>((resolve, reject) => {
    execFile("tar", ["-xjf", archive, "-C", MODELS], { windowsHide: true }, (err, _out, stderr) => {
      if (err) return reject(new Error(`tar failed: ${stderr || err.message}`));
      resolve();
    });
  });
  rmSync(archive, { force: true });
  if (!installed(spec)) throw new Error(`unpacked, but ${spec.marker} is missing`);
  log(`model ${spec.name}: installed at ${dest}`);
  onProgress({ phase: "done", received: total, total });
  return dest;
}

export function removeModel(spec: ModelSpec): void {
  rmSync(path.join(MODELS, spec.dir), { recursive: true, force: true });
}
