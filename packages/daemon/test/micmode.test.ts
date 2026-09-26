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

  it("tells the screens the mode and the key, and takes a mode from one", async () => {
    const d = daemon();
    d.settings.ptt_key = "CommandOrControl+Shift+Space";
    const frames: Array<Record<string, unknown>> = [];
    d.hub.listen((f) => frames.push(f as Record<string, unknown>));
    expect(d.micInfo()).toEqual({ mode: d.settings.mic_mode, key: "control shift space" });
    d.setMicMode("muted");
    expect(frames.find((f) => f.type === "mic")).toMatchObject({ phase: "muted", mode: "muted" });
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

  it("says so, rather than passing it on, when a named project is unknown", async () => {
    const d = daemon();
    const r = d.hear("kikoe, run the commerce project");
    expect(r.intent).toBe("run");
    expect(r.said).toMatch(/don't know a project called commerce/);
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

  it("sends a nameless follow-up to the project it just ran, not the last session", async () => {
    const d = daemon();
    const p = d.projects.ensure("Commerce Project", "C:/nowhere/Commerce Project");
    (d as unknown as { focusOn(p: unknown): void }).focusOn(p);
    // agents are on but the folder does not exist: the answer names where it went
    expect(d.instruct("add a search box above the product list")).toMatch(/commerce/i);
    await d.close();
  });

  it("stops a project's server by name, and a bare stop still silences Kik", async () => {
    const d = daemon();
    const p = d.projects.ensure("Commerce Project", "C:/nowhere/Commerce Project");
    const fake = { get: (id: string) => (id === p.id ? {} : undefined), stop: () => true };
    Object.assign(d.runner, fake);
    const r = d.hear("kikoe, stop the commerce project");
    expect(r.intent).toBe("stop-project");
    expect(r.said).toMatch(/Stopped Commerce Project/);
    expect(d.hear("kikoe, stop").intent).not.toBe("stop-project");
    await d.close();
  });

  it("drops a plan when there is none waiting", async () => {
    const d = daemon();
    expect(d.planDecide("go", "go ahead")).toMatch(/no plan/i);
    await d.close();
  });
});
