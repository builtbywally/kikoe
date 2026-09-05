import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-hear-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let mod: typeof import("../src/daemon.js");
let cfg: typeof import("../src/config.js");
beforeAll(async () => {
  mod = await import("../src/daemon.js");
  cfg = await import("../src/config.js");
});
// Never the OS voice from a test: a ladder with no rungs.
const quiet = () => new mod.Daemon({ audio: false, settings: { ...cfg.DEFAULTS, tts: "none" } });

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("the ear, through the daemon", () => {
  it("routes control, questions, chatter and the unaddressed", async () => {
    const d = quiet();
    d.hook({
      hook_event_name: "PreToolUse",
      session_id: "s",
      cwd: HOME,
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
    });
    expect(d.hear("so anyway the kikoe thing").kind).toBe("overheard");
    expect(d.hear("kikoe go silent")).toMatchObject({ kind: "control", intent: "mode" });
    expect(d.narrator.mode).toBe("silent");
    const q = d.hear("hey kikoe what's it doing");
    expect(q.kind).toBe("question");
    expect(q.said).toContain("running a command");
    expect(d.hear("kikoe thanks").said).toBe("Anytime.");
    expect(d.hear("kikoe add a retry to the fetch call").kind).toBe("work");
    expect(d.heardLog.length).toBe(5);
    expect(d.state().heard[0]?.kind).toBe("work");
    await d.close();
  });

  it("a bare yes releases an asked pin, and only while it is asking", async () => {
    const d = quiet();
    expect(d.hear("yes").kind).toBe("overheard");
    const pin = d.board.add({ body: "x", ask: ["apply", "no"] });
    const waited = d.board.wait(pin.id, 2);
    await tick();
    expect(d.hear("yes")).toMatchObject({ kind: "answer", intent: "yes" });
    expect(await waited).toBe("apply");
    await d.close();
  });

  it("drops a transcript that echoes the line being spoken", async () => {
    const d = quiet();
    d.say("Tests: eighteen passed, two failed.", 2);
    await tick();
    expect(d.hear("tests eighteen passed two failed").kind).toBe("self");
    await d.close();
  });

  it("the echo test is loose but not blind", () => {
    expect(
      mod.similar("it wants to push to main shall I", "It wants to push to main. Shall I?"),
    ).toBe(true);
    expect(mod.similar("what time is it", "It wants to push to main. Shall I?")).toBe(false);
  });
});
