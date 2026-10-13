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
