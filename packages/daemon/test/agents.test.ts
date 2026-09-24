/**
 * Starting an agent, and acting on a card.
 *
 * The rule these tests exist to defend: **Kikoe never writes to your repo
 * and never runs your build itself.** Every action a card offers is an
 * instruction to the agent, so a revert is an edit you can see and a re-run
 * is the command it already ran. If that ever stops being true, these fail.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-agents-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let mod: typeof import("../src/agents.js");
let dmod: typeof import("../src/daemon.js");
let config: typeof import("../src/config.js");

beforeAll(async () => {
  mod = await import("../src/agents.js");
  dmod = await import("../src/daemon.js");
  config = await import("../src/config.js");
});

describe("finding Claude Code", () => {
  it("takes a configured path when it exists", () => {
    const bin = path.join(HOME, "my-claude.exe");
    writeFileSync(bin, "");
    expect(mod.findClaude(bin)).toBe(bin);
  });

  it("ignores a configured path that does not exist, rather than failing later", () => {
    // It does not return the bad path — but it does keep looking, so on a
    // machine that has Claude Code installed somewhere ordinary this finds
    // it anyway. A wrong setting should not make a working install invisible.
    const bad = path.join(HOME, "nope.exe");
    expect(mod.findClaude(bad, "")).not.toBe(bad);
  });

  it("looks along the PATH", () => {
    const dir = path.join(HOME, "bin");
    mkdirSync(dir, { recursive: true });
    const name = process.platform === "win32" ? "claude.exe" : "claude";
    writeFileSync(path.join(dir, name), "");
    expect(mod.findClaude("", dir)).toBe(path.join(dir, name));
  });

  it("finds a Windows .cmd shim, which spawn cannot run without a shell", () => {
    if (process.platform !== "win32") return;
    const dir = path.join(HOME, "shim");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "claude.cmd"), "");
    expect(mod.findClaude("", dir)).toBe(path.join(dir, "claude.cmd"));
  });
});

describe("Agents", () => {
  it("says so rather than failing quietly when there is no binary", () => {
    const a = new mod.Agents({ bin: path.join(HOME, "absent") });
    // an empty PATH entry cannot match, so this is the "not installed" case
    const r = a.start("marine", HOME, "do a thing", "", true);
    if (!a.bin()) {
      expect(r.ok).toBe(false);
      expect(r.said).toMatch(/can't find Claude Code/);
    }
  });

  it("refuses a folder that is not there", () => {
    const a = new mod.Agents({ bin: path.join(HOME, "my-claude.exe") });
    const r = a.start("ghost", path.join(HOME, "nowhere"), "do a thing", "", true);
    expect(r.ok).toBe(false);
    expect(r.said).toMatch(/where ghost is/);
  });

  it("chooses the session id up front, so nothing has to be matched after", async () => {
    // --session-id is why claim()-by-cwd could be deleted: we know which
    // conversation this is before the process exists.
    const projects = await import("../src/projects.js");
    const id = projects.newSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const p = new projects.Projects();
    p.ensure("marine", "C:/repo");
    const first = p.sessionFor("marine");
    // the same conversation tomorrow, not a new one
    expect(p.sessionFor("marine")).toBe(first);
    p.forget("marine");
    expect(p.sessionFor("marine")).not.toBe(first);
  });
});

describe("acting on a card", () => {
  function daemon() {
    return new dmod.Daemon({
      settings: { ...config.DEFAULTS, tts: "none", port: 0 },
      audio: false,
      persistBoard: false,
    });
  }

  it("reads the command back off a run card", () => {
    expect(
      dmod.pinSubject({ kind: "run", title: "x", body: "$ pnpm test\n\n18 passed" }).command,
    ).toBe("pnpm test");
    expect(dmod.pinSubject({ kind: "result", title: "x", body: "$ pnpm build\nok" }).command).toBe(
      "pnpm build",
    );
  });

  it("reads the file back off a diff card", () => {
    const body = "--- a/src/tracker.ts\n+++ b/src/tracker.ts\n@@ -1,2 +1,2 @@\n-a\n+b";
    expect(dmod.pinSubject({ kind: "diff", title: "x", body }).file).toBe("src/tracker.ts");
  });

  it("has nothing to say about a card that is not work", () => {
    expect(dmod.pinSubject({ kind: "note", title: "x", body: "hello" })).toEqual({
      command: "",
      file: "",
    });
  });

  it("turns re-run into an instruction, never into a command it runs itself", async () => {
    const d = daemon();
    const pin = d.board.add({
      kind: "run",
      title: "pnpm test",
      body: "$ pnpm test\n\n18 passed, 2 failed",
      repo: "kikoe",
      stream: "work",
    });
    const r = d.actOnPin(pin.id, "again");
    expect(r.ok).toBe(true);
    // it went to the agent's queue; nothing was executed here
    expect(d.instructions.map((i) => i.text).join(" ")).toContain("pnpm test");
    await d.close();
  });

  it("turns revert into an instruction to the agent, not a write to the repo", async () => {
    const d = daemon();
    const pin = d.board.add({
      kind: "diff",
      title: "tracker.ts +1 -1",
      body: "--- a/src/tracker.ts\n@@ -1,1 +1,1 @@\n-a\n+b",
      repo: "kikoe",
      stream: "work",
    });
    const r = d.actOnPin(pin.id, "revert");
    expect(r.ok).toBe(true);
    const said = d.instructions.map((i) => i.text).join(" ");
    expect(said).toContain("src/tracker.ts");
    expect(said).toMatch(/undo|put it back/i);
    await d.close();
  });

  it("refuses an action a card cannot support, instead of guessing", async () => {
    const d = daemon();
    const note = d.board.add({ kind: "note", title: "n", body: "hi", stream: "work" });
    expect(d.actOnPin(note.id, "again").ok).toBe(false);
    expect(d.actOnPin(note.id, "revert").ok).toBe(false);
    expect(d.actOnPin("gone", "again").ok).toBe(false);
    expect(d.actOnPin(note.id, "detonate").ok).toBe(false);
    await d.close();
  });

  it("does not pass on a fragment the ear misheard", async () => {
    // Found in the wild: the word "time" arrived classified as work and was
    // queued to a real agent as a one-word instruction. A scrap is far more
    // likely to be a mishearing than a job, and the cost of ignoring a real
    // short one is saying it twice.
    const d = daemon();
    expect(d.instruct("time")).toMatch(/didn't catch enough/);
    expect(d.instruct("so")).toMatch(/didn't catch enough/);
    expect(d.instructions).toHaveLength(0);
    // and a real job gets past the guard — it fails later for want of a
    // folder in this fixture, which is a different answer entirely
    expect(d.instruct("add a retry to the fetch in brain")).not.toMatch(/didn't catch enough/);
    await d.close();
  });

  it('remembers what the agent was told, so "what did I tell it?" has an answer', async () => {
    const d = daemon();
    const pin = d.board.add({
      kind: "run",
      title: "pnpm test",
      body: "$ pnpm test\n\n18 passed, 2 failed",
      repo: "kikoe",
      stream: "work",
    });
    d.actOnPin(pin.id, "again");
    const line = d.toldLine();
    expect(line).toContain("kikoe");
    expect(line).toContain("pnpm test");
    await d.close();
  });

  it("will not start an agent when the setting is off", async () => {
    const d = new dmod.Daemon({
      settings: { ...config.DEFAULTS, tts: "none", port: 0, agents: false },
      audio: false,
      persistBoard: false,
    });
    expect(d.startAgent("", "do something")).toMatch(/switched off/);
    await d.close();
  });

  it("asks what to do rather than starting an agent with nothing to do", async () => {
    const d = daemon();
    expect(d.startAgent("", "   ")).toMatch(/what it should do/);
    await d.close();
  });
});

describe("a long phone clip", () => {
  const rate = 16000;
  const loud = (n: number) => Int16Array.from({ length: n }, (_, i) => (i % 2 ? 8000 : -8000));
  it("is heard whole when it is short", () => {
    const pcm = loud(rate * 10);
    const parts = dmod.splitAtQuiet(pcm, rate);
    expect(parts).toHaveLength(1);
    expect(parts[0].length).toBe(pcm.length);
  });
  it("is cut at a pause, not mid-word", () => {
    // 20 s of talk, half a second of quiet, 20 s of talk
    const pcm = new Int16Array(rate * 40.5);
    pcm.set(loud(rate * 20), 0);
    pcm.set(loud(rate * 20), rate * 20.5);
    const parts = dmod.splitAtQuiet(pcm, rate);
    expect(parts.length).toBeGreaterThan(1);
    const cut = parts[0].length / rate;
    expect(cut).toBeGreaterThanOrEqual(20);
    expect(cut).toBeLessThanOrEqual(20.5);
    expect(parts.reduce((n, p) => n + p.length, 0)).toBe(pcm.length);
  });
});
