/**
 * The speaker: one RtAudio output stream, fed float32 mono frames.
 *
 * audify's write() wants exactly one frame per call, so incoming chunks of
 * any size are re-cut into frame-sized pieces and the tail is padded with
 * silence at the end of an utterance. `drop()` clears the queue for barge-in
 * and preemption; it returns in well under a millisecond.
 *
 * Playback position is exact, not estimated: audify calls back once per
 * frame it has finished playing, so "queued" is frames written minus frames
 * played, and `quiet()` resolves on the frame boundary where the mouth is
 * actually free. The island's speaking state and barge-in both need that.
 *
 * Backends at other sample rates are resampled here with linear
 * interpolation, which is fine for speech and keeps the device open at one
 * rate for the life of the process.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface SpeakerInfo {
  device: string;
  rate: number;
  api: string;
}

export interface Speaker {
  readonly rate: number;
  push(samples: Float32Array, sourceRate: number): void;
  /** pad the tail so the last few milliseconds are heard */
  flush(): void;
  /** stop now: clear the queue */
  drop(): void;
  /** seconds of audio handed over and not yet played */
  queuedSeconds(): number;
  /** resolves when everything written has been played, or the queue was dropped */
  quiet(): Promise<void>;
  resetClock(): void;
  info(): SpeakerInfo;
  close(): void;
}

/** Where a tapped speaker sends a copy of what it plays. */
export interface Tap {
  pcm(samples: Float32Array, sourceRate: number): void;
  /** the line was cut off: stop playing what was sent */
  drop(): void;
}

/**
 * A speaker that also hands every sample to a tap: the phone hears what the
 * desk hears, as it is played, including being cut off. It wraps rather than
 * replaces, so the desk's own playback is untouched whether or not anyone is
 * listening elsewhere.
 */
export class TappedSpeaker implements Speaker {
  constructor(
    private readonly inner: Speaker,
    private readonly tap: Tap,
  ) {}
  get rate(): number {
    return this.inner.rate;
  }
  push(samples: Float32Array, sourceRate: number): void {
    this.inner.push(samples, sourceRate);
    try {
      this.tap.pcm(samples, sourceRate);
    } catch {
      /* a listener's trouble is never the speaker's */
    }
  }
  flush(): void {
    this.inner.flush();
  }
  drop(): void {
    this.inner.drop();
    try {
      this.tap.drop();
    } catch {
      /* as above */
    }
  }
  queuedSeconds(): number {
    return this.inner.queuedSeconds();
  }
  quiet(): Promise<void> {
    return this.inner.quiet();
  }
  resetClock(): void {
    this.inner.resetClock();
  }
  info(): SpeakerInfo {
    return this.inner.info();
  }
  close(): void {
    this.inner.close();
  }
}

/** A speaker that plays nothing, for tests and `--no-audio`. */
export class NullSpeaker implements Speaker {
  readonly rate = 24000;
  private seconds = 0;
  push(samples: Float32Array, sourceRate: number): void {
    this.seconds += samples.length / sourceRate;
  }
  flush(): void {}
  drop(): void {
    this.seconds = 0;
  }
  queuedSeconds(): number {
    return this.seconds;
  }
  quiet(): Promise<void> {
    const s = this.seconds;
    this.seconds = 0;
    // Pretend to play it: the arbiter's ordering stays honest in tests too.
    return new Promise((r) => setTimeout(r, Math.min(s * 1000, 50)));
  }
  resetClock(): void {
    this.seconds = 0;
  }
  info(): SpeakerInfo {
    return { device: "none", rate: this.rate, api: "null" };
  }
  close(): void {}
}

export class RtAudioSpeaker implements Speaker {
  readonly rate: number;
  private readonly rt: any;
  private readonly frame: number;
  private readonly deviceName: string;
  private readonly apiName: string;
  private pending = new Float32Array(0);
  private written = 0;
  private played = 0;
  private waiters: Array<() => void> = [];

  constructor(opts: { rate?: number; device?: string } = {}) {
    const { RtAudio, RtAudioFormat } = require("audify");
    this.rt = new RtAudio();
    const devices: any[] = this.rt.getDevices();
    let id = this.rt.getDefaultOutputDevice();
    if (opts.device) {
      const needle = opts.device.toLowerCase();
      const hit = devices.find(
        (d) => d.outputChannels > 0 && String(d.name).toLowerCase().includes(needle),
      );
      if (hit) id = hit.id;
    }
    const dev = devices.find((d) => d.id === id);
    this.rate = opts.rate ?? 24000;
    this.frame = Math.round(this.rate / 50); // 20 ms
    this.deviceName = dev?.name ?? String(id);
    this.apiName = String(this.rt.getCurrentApi?.() ?? "");
    const FLOAT32 = RtAudioFormat?.RTAUDIO_FLOAT32 || 0x10;
    this.rt.openStream(
      { deviceId: id, nChannels: 1, firstChannel: 0 },
      null,
      FLOAT32,
      this.rate,
      this.frame,
      "kikoe",
      null,
      () => this.onFramePlayed(),
    );
    this.rt.start();
  }

  private onFramePlayed(): void {
    this.played++;
    if (this.played >= this.written) this.wake();
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  private write(f: Float32Array): void {
    this.rt.write(Buffer.from(f.buffer, f.byteOffset, f.byteLength));
    this.written++;
  }

  push(samples: Float32Array, sourceRate: number): void {
    const chunk = sourceRate === this.rate ? samples : resample(samples, sourceRate, this.rate);
    const joined = new Float32Array(this.pending.length + chunk.length);
    joined.set(this.pending);
    joined.set(chunk, this.pending.length);
    let off = 0;
    for (; joined.length - off >= this.frame; off += this.frame) {
      this.write(joined.subarray(off, off + this.frame));
    }
    this.pending = joined.slice(off);
  }

  flush(): void {
    if (this.pending.length) {
      const f = new Float32Array(this.frame);
      f.set(this.pending);
      this.write(f);
      this.pending = new Float32Array(0);
    }
  }

  drop(): void {
    this.pending = new Float32Array(0);
    try {
      this.rt.clearOutputQueue();
    } catch {
      /* stream may be closed */
    }
    this.played = this.written;
    this.wake();
  }

  queuedSeconds(): number {
    return (Math.max(0, this.written - this.played) * this.frame) / this.rate;
  }

  quiet(): Promise<void> {
    if (this.written <= this.played) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      // A stalled device must not hang the mouth forever.
      setTimeout(resolve, this.queuedSeconds() * 1000 + 1500);
    });
  }

  resetClock(): void {
    /* exact counters need no reset */
  }

  info(): SpeakerInfo {
    return { device: this.deviceName, rate: this.rate, api: this.apiName };
  }

  close(): void {
    try {
      this.rt.setFrameOutputCallback(null);
      this.rt.stop();
      this.rt.closeStream();
    } catch {
      /* already closed */
    }
    this.wake();
  }
}

export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = input[j] ?? 0;
    const b = input[j + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export function listOutputDevices(): Array<{
  id: number;
  name: string;
  rate: number;
  default: boolean;
}> {
  const { RtAudio } = require("audify");
  const rt = new RtAudio();
  const def = rt.getDefaultOutputDevice();
  return (rt.getDevices() as any[])
    .filter((d) => d.outputChannels > 0)
    .map((d) => ({
      id: d.id,
      name: String(d.name),
      rate: d.preferredSampleRate,
      default: d.id === def,
    }));
}

// --- earcons ----------------------------------------------------------------
//
// Short synthesized cues, generated rather than shipped: a soft tick for
// progress, a rising two-note for a question, a settled two-note for done,
// a low buzz for an error. Each is under 300 ms and sits well under speech
// level so a cue never startles.

export type Earcon = "tick" | "question" | "done" | "error";

function tone(rate: number, notes: Array<[hz: number, ms: number]>, gain = 0.18): Float32Array {
  const total = notes.reduce((n, [, ms]) => n + Math.round((rate * ms) / 1000), 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const [hz, ms] of notes) {
    const n = Math.round((rate * ms) / 1000);
    for (let i = 0; i < n; i++) {
      // sine with a raised-cosine envelope so there is no click at the edges
      const env = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      out[off + i] = Math.sin((2 * Math.PI * hz * i) / rate) * env * gain;
    }
    off += n;
  }
  return out;
}

export function earcon(kind: Earcon, rate: number): Float32Array {
  switch (kind) {
    case "tick":
      return tone(rate, [[1400, 45]], 0.1);
    case "question":
      return tone(rate, [
        [660, 110],
        [880, 160],
      ]);
    case "done":
      return tone(rate, [
        [784, 110],
        [523, 170],
      ]);
    case "error":
      return tone(
        rate,
        [
          [220, 140],
          [180, 160],
        ],
        0.22,
      );
  }
}
