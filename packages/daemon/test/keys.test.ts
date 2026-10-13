/**
 * The holo keyboard's keys that are not words. The walkie hands them on
 * from a tablet, so the list of what they may do is short and fixed.
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-keys-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

describe("keyAction", () => {
  it("switches the view, opens push to talk, clears the board, and nothing else", async () => {
    const { Daemon } = await import("../src/daemon.js");
    const { DEFAULTS } = await import("../src/config.js");
    const d = new Daemon({
      settings: { ...DEFAULTS, tts: "none", port: 0, jev: false, brain: false },
      audio: false,
      persistBoard: false,
    });
    const frames: string[] = [];
    d.hub.listen((f) => {
      if (f.type === "view") frames.push(String(f.view));
    });
    expect(d.keyAction("view:desk")).toBe(true);
    expect(d.keyAction("view:settings")).toBe(false);
    expect(frames).toEqual(["desk"]);
    // no ear to open yet
    expect(d.keyAction("talk")).toBe(false);
    let talked = 0;
    d.onTalk = () => talked++;
    expect(d.keyAction("talk")).toBe(true);
    expect(talked).toBe(1);
    expect(d.keyAction("clear")).toBe(true);
    expect(d.keyAction("rm -rf /")).toBe(false);
    await d.close();
  });
});
