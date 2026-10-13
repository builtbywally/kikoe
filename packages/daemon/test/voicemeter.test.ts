/**
 * The voice meter: how loud Kik is, timed to when it is heard. The
 * hologram's mouth follows it, so a level sent when the audio was made
 * (generation runs seconds ahead) would move her lips before the sound.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceMeter } from "../src/speaker.js";

describe("VoiceMeter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends each slice's level when that slice is played", () => {
    const levels: [number, number][] = [];
    const start = Date.now();
    // two seconds were already queued before this chunk
    const meter = new VoiceMeter(
      () => 2.12,
      (l) => levels.push([Date.now() - start, l]),
    );
    const loud = new Float32Array(1200).fill(0.2); // 120 ms at 10 kHz
    meter.pcm(loud, 10000);
    vi.advanceTimersByTime(1990);
    expect(levels).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(levels.map(([t]) => t)).toEqual([2000, 2060]);
    expect(levels[0]![1]).toBeGreaterThan(0.5);
  });

  it("closes the mouth when the line is cut off", () => {
    const levels: number[] = [];
    const meter = new VoiceMeter(
      () => 1,
      (l) => levels.push(l),
    );
    meter.pcm(new Float32Array(600).fill(0.3), 10000);
    meter.drop();
    vi.advanceTimersByTime(5000);
    expect(levels).toEqual([0]);
  });

  it("reads silence as a closed mouth", () => {
    const levels: number[] = [];
    const meter = new VoiceMeter(
      () => 0.06,
      (l) => levels.push(l),
    );
    meter.pcm(new Float32Array(600), 10000);
    vi.runAllTimers();
    expect(levels).toEqual([0]);
  });
});
