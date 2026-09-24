import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-remind-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let rem: typeof import("../src/reminders.js");
let dmod: typeof import("../src/daemon.js");
let cfg: typeof import("../src/config.js");
let core: typeof import("@kikoe/core");
beforeAll(async () => {
  rem = await import("../src/reminders.js");
  dmod = await import("../src/daemon.js");
  cfg = await import("../src/config.js");
  core = await import("@kikoe/core");
});

describe("hearing when", () => {
  it("reads a length", () => {
    expect(rem.duration("in 5 minutes")).toBe(300_000);
    expect(rem.duration("for ten minutes")).toBe(600_000);
    expect(rem.duration("in an hour")).toBe(3_600_000);
    expect(rem.duration("in half an hour")).toBe(1_800_000);
    expect(rem.duration("90 seconds")).toBe(90_000);
    expect(rem.duration("soon")).toBe(0);
  });
  it("reads a time of day as the next one, afternoon for a bare small hour", () => {
    const nine = new Date(2026, 8, 24, 9, 0, 0).getTime();
    expect(new Date(rem.clockTime("at 5", nine)).getHours()).toBe(17);
    expect(new Date(rem.clockTime("at 5:30 pm", nine)).getMinutes()).toBe(30);
    expect(new Date(rem.clockTime("at 8 am", nine)).getDate()).toBe(25);
    expect(rem.clockTime("at 25:00", nine)).toBe(0);
  });
});

describe("the list", () => {
  it("keeps reminders across a restart, and gives up the due ones once", () => {
    let now = 1_000_000;
    const file = path.join(HOME, "r.json");
    const a = new rem.Reminders(file, () => now);
    a.add("call the printer", now + 60_000);
    a.add("tea", now + 1000, true);
    const b = new rem.Reminders(file, () => now);
    expect(b.list().map((r) => r.text)).toEqual(["tea", "call the printer"]);
    now += 2000;
    expect(b.due().map((r) => r.text)).toEqual(["tea"]);
    expect(b.due()).toEqual([]);
    expect(b.cancel("printer")?.text).toBe("call the printer");
    expect(b.list()).toEqual([]);
  });
});

describe("in the daemon", () => {
  it("sets a timer by reflex, with no model", async () => {
    expect(core.route("kikoe set a timer for 5 minutes")).toMatchObject({
      kind: "control",
      intent: "remind",
    });
    const d = new dmod.Daemon({
      audio: false,
      persistBoard: false,
      settings: { ...cfg.DEFAULTS, tts: "none", port: 0 },
      jevKey: "",
    });
    expect(d.hear("kikoe set a timer for 5 minutes").said).toMatch(/timer set, in 5 minutes/i);
    expect(d.hear("kikoe remind me in 10 minutes to call the printer").said).toMatch(
      /remind you in 10 minutes: call the printer/,
    );
    expect(d.reminders.list()).toHaveLength(2);
    await d.close();
  });
});
