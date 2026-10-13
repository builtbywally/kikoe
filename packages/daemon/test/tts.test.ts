/**
 * The local voices (Piper, Kokoro) through sherpa-onnx.
 *
 * Pinned here because it failed silently: Electron forbids external
 * ArrayBuffers, sherpa returns audio in them unless told otherwise, and so
 * in the app every local line failed "TTS settlement failed" and fell
 * through to the OS voice, while plain node (and every test) was fine.
 */

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.KIKOE_HOME = path.join(os.tmpdir(), "kikoe-tts-test");
process.env.KIKOE_CLAUDE_DIR = path.join(process.env.KIKOE_HOME, "claude");

describe("sherpa voices", () => {
  it("ask sherpa for audio Electron can hold", async () => {
    const { PiperRung } = await import("../src/tts.js");
    const requests: Record<string, unknown>[] = [];
    const fake = {
      sampleRate: 22050,
      numSpeakers: 1,
      generateAsync: async (req: Record<string, unknown>) => {
        requests.push(req);
        (req.onProgress as (p: { samples: Float32Array }) => boolean)({
          samples: new Float32Array(2205),
        });
      },
    };
    class FakePiper extends PiperRung {
      protected override modelConfig() {
        return { vits: { model: "fake.onnx", tokens: "tokens.txt", dataDir: "espeak" } };
      }
      say(text: string, speaker: Parameters<PiperRung["streamTo"]>[1]) {
        return this.generate(fake, text, speaker, new AbortController().signal);
      }
    }
    const pushed: number[] = [];
    const speaker = {
      rate: 48000,
      push: (s: Float32Array) => pushed.push(s.length),
      flush: () => {},
      drop: () => {},
      queuedSeconds: () => 0,
      quiet: async () => {},
      resetClock: () => {},
      info: () => ({ device: "test", rate: 48000, api: "test" }),
      close: () => {},
    };
    const res = await new FakePiper("unused").say("Hello.", speaker);
    expect(requests[0]?.enableExternalBuffer).toBe(false);
    expect(pushed).toEqual([2205]);
    expect(res.backend).toBe("piper");
  });
});

describe("the ladder", () => {
  const speaker = {
    rate: 48000,
    push: () => {},
    flush: () => {},
    drop: () => {},
    queuedSeconds: () => 0,
    quiet: async () => {},
    resetClock: () => {},
    info: () => ({ device: "test", rate: 48000, api: "test" }),
    close: () => {},
  };
  const rung = (name: string, fail?: string) => {
    const r = {
      name,
      tries: 0,
      available: () => true,
      async streamTo() {
        r.tries++;
        if (fail) throw new Error(fail);
        return { backend: name, ttfaMs: 1, audioS: 1 };
      },
    };
    return r;
  };

  it("rests an account that refuses, and tries it again after six hours", async () => {
    const { Ladder, BENCH_MS } = await import("../src/tts.js");
    const { DEFAULTS } = await import("../src/config.js");
    let now = 1_000_000;
    const eleven = rung("eleven", 'elevenlabs 401: {"detail":{"status":"payment_issue"}}');
    const piper = rung("piper");
    const ladder = new Ladder({ settings: DEFAULTS, rungs: [eleven, piper], now: () => now });
    const signal = new AbortController().signal;
    expect((await ladder.speak("one", speaker, signal)).backend).toBe("piper");
    expect((await ladder.speak("two", speaker, signal)).backend).toBe("piper");
    expect(eleven.tries).toBe(1);
    expect(Object.keys(ladder.resting)).toEqual(["eleven"]);
    now += BENCH_MS + 1;
    await ladder.speak("three", speaker, signal);
    expect(eleven.tries).toBe(2);
  });

  it("rests on the status code alone", async () => {
    const { Ladder } = await import("../src/tts.js");
    const { DEFAULTS } = await import("../src/config.js");
    const eleven = rung("eleven", "elevenlabs 401: unauthorized");
    const ladder = new Ladder({ settings: DEFAULTS, rungs: [eleven, rung("piper")] });
    await ladder.speak("one", speaker, new AbortController().signal);
    expect(Object.keys(ladder.resting)).toEqual(["eleven"]);
  });

  it("does not rest a voice for an ordinary failure", async () => {
    const { Ladder } = await import("../src/tts.js");
    const { DEFAULTS } = await import("../src/config.js");
    const kokoro = rung("kokoro", "TTS settlement failed");
    const piper = rung("piper");
    const ladder = new Ladder({ settings: DEFAULTS, rungs: [kokoro, piper] });
    await ladder.speak("one", speaker, new AbortController().signal);
    expect(ladder.resting).toEqual({});
  });
});
