/**
 * The computer's mic: open, muted with the phone still heard, or push to
 * talk; and the voice reflexes for run and plan reaching the daemon.
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-mic-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let mm: typeof import("../src/micmode.js");
let dmod: typeof import("../src/daemon.js");
let config: typeof import("../src/config.js");

beforeAll(async () => {
  mm = await import("../src/micmode.js");
  dmod = await import("../src/daemon.js");
  config = await import("../src/config.js");
});

function daemon() {
  return new dmod.Daemon({
    settings: { ...config.DEFAULTS, tts: "none", port: 0, jev: false, brain: false },
    audio: false,
    persistBoard: false,
  });
}

describe("micModeAsk", () => {
  it("hears the three modes", () => {
    expect(mm.micModeAsk("mute the computer")).toBe("muted");
    expect(mm.micModeAsk("mute your mic on the PC")).toBe("muted");
    expect(mm.micModeAsk("only listen to me on my phone")).toBe("muted");
    expect(mm.micModeAsk("unmute")).toBe("open");
    expect(mm.micModeAsk("turn on the computer mic")).toBe("open");
    expect(mm.micModeAsk("switch to push to talk")).toBe("push");
    expect(mm.micModeAsk("run Marine")).toBeNull();
  });

  it("says the key out loud", () => {
    expect(mm.spokenKey("CommandOrControl+Shift+Space")).toBe("control shift space");
  });
});

describe("the daemon", () => {
  it("mutes the computer by voice and tells the app", async () => {
    const d = daemon();
    const told: string[] = [];
    d.onMicMode = (m) => told.push(m);
    const r = d.hear("kikoe, mute the computer", {}, { via: "phone" });
    expect(r.intent).toBe("mic:muted");
    expect(r.said).toMatch(/phone/);
    expect(told).toEqual(["muted"]);
    expect(d.settings.mic_mode).toBe("muted");
    await d.close();
  });

  it("takes a push-to-talk sentence as addressed, with no name", async () => {
    const d = daemon();
    const r = d.hearSegment("mute the computer", {}, true);
    expect(r.kind).toBe("command");
    await d.close();
  });

  it("does not run a project it does not know", async () => {
    const d = daemon();
    const r = d.hear("kikoe, run Atlantis");
    expect(r.intent).not.toBe("run");
    await d.close();
  });

  it("finds the project a plan names, the longest name first", async () => {
    const d = daemon();
    d.projects.ensure("kikoe", "C:/p/kikoe");
    d.projects.ensure("kikoe-website", "C:/p/kikoe-website");
    expect(d.projectNamedIn("add a changelog to the kikoe website")?.id).toBe("kikoe-website");
    expect(d.projectNamedIn("fix the ear in kikoe")?.id).toBe("kikoe");
    expect(d.projectNamedIn("add dark mode")).toBeUndefined();
    await d.close();
  });

  it("drops a plan when there is none waiting", async () => {
    const d = daemon();
    expect(d.planDecide("go", "go ahead")).toMatch(/no plan/i);
    await d.close();
  });
});
