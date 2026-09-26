// Slice 4 of docs/REQUESTS.md: each case a sentence from the daemon log.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-mend-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let core: typeof import("@kikoe/core");
let jev: typeof import("../src/jev.js");
let dmod: typeof import("../src/daemon.js");
let cfg: typeof import("../src/config.js");
beforeAll(async () => {
  core = await import("@kikoe/core");
  jev = await import("../src/jev.js");
  dmod = await import("../src/daemon.js");
  cfg = await import("../src/config.js");
});
const quiet = () =>
  new dmod.Daemon({
    audio: false,
    persistBoard: false,
    settings: { ...cfg.DEFAULTS, tts: "none", port: 0 },
    jevKey: "",
  });

describe("the reflexes heard wrong", () => {
  it("clears the canvas however it is said, and can bring it back", () => {
    for (const t of [
      "kikoe clear the canvas",
      "kikoe clear the cameras",
      "kikoe clear the boards",
      "kikoe close all windows that are currently on the board",
    ])
      expect(core.route(t)).toMatchObject({ kind: "control", intent: "board", arg: "clear" });
    for (const t of ["kikoe undo", "kikoe bring them back", "kikoe put it back"])
      expect(core.route(t)).toMatchObject({ kind: "control", intent: "board", arg: "undo" });
  });

  it("goes to sleep, rather than to a project called sleep", () => {
    expect(core.route("kikoe go to sleep")).toMatchObject({ kind: "control", intent: "shutdown" });
  });

  it("switches boards only to a project, and hands anything else on", async () => {
    const d = quiet();
    d.projects.ensure("storefront", HOME);
    expect(d.hear("kikoe switch to storefront").kind).toBe("control");
    // not a project: no board switch, it goes where work goes
    expect(d.hear("kikoe switch to chrome").kind).not.toBe("control");
    await d.close();
  });
});

describe("nothing removed is gone", () => {
  it("clears to a bin, and undo brings the lot back in one go", async () => {
    const d = quiet();
    const a = d.board.add({ body: "a design", title: "Mamma Mia" });
    d.board.add({ body: "b" });
    d.board.add({ body: "kept", sticky: true });
    expect(d.hear("kikoe clear the canvas").said).toMatch(/undo/i);
    expect(d.board.list().some((p) => p.id === a.id)).toBe(false);
    expect(d.hear("kikoe undo").said).toMatch(/2 cards/);
    expect(d.board.list().some((p) => p.id === a.id)).toBe(true);
    await d.close();
  });

  it("brings back a run of single removals as one batch", async () => {
    const d = quiet();
    const ids = [1, 2, 3].map((i) => d.board.add({ body: `card ${i}`, sticky: i === 1 }).id);
    const remove = d.brainTools().find((t) => t.name === "remove_artifact");
    for (const id of ids) await remove?.run({ id });
    expect(d.board.list()).toHaveLength(0);
    const restore = d.brainTools().find((t) => t.name === "restore_artifacts");
    expect(await restore?.run({})).toBe("brought back 3");
    await d.close();
  });
});

describe("what is heard, and not guessed", () => {
  it("collapses Whisper's loops, and leaves a real 'no, no' alone", () => {
    expect(dmod.collapseRepeats("what what what what")).toBe("what");
    expect(dmod.collapseRepeats("open the page open the page open the page now")).toBe(
      "open the page now",
    );
    expect(dmod.collapseRepeats("no, no, that one")).toBe("no, no, that one");
  });

  it("never makes a site out of a word it does not know", () => {
    expect(jev.siteByName("open lo-fi on the canvas")).toBe("");
    expect(jev.siteByName("open the file")).toBe("");
    expect(jev.siteByName("open youtube on the tv")).toBe("https://www.youtube.com");
    expect(jev.siteByName("pull up a photo from flickr")).toBe("https://www.flickr.com");
    expect(jev.searchFor("open lo-fi on the canvas please")).toBe("lo-fi");
    expect(jev.searchFor("Open it, just open it on a new window.")).toBe("");
  });

  it("a note Kik pins is kept, not faded", async () => {
    const d = quiet();
    await d
      .brainTools()
      .find((t) => t.name === "pin_note")
      ?.run({ title: "t", body: "b" });
    expect(d.board.list()[0]?.sticky).toBe(true);
    await d.close();
  });
});
