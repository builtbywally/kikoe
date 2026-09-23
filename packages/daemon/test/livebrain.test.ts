import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-live-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let live: typeof import("../src/livebrain.js");
let dmod: typeof import("../src/daemon.js");
let cfg: typeof import("../src/config.js");
beforeAll(async () => {
  live = await import("../src/livebrain.js");
  dmod = await import("../src/daemon.js");
  cfg = await import("../src/config.js");
});

type Child = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: () => void;
};

/**
 * A stand-in for Claude Code. A talking session (`--input-format`) answers
 * every message line with `answer(message)`; a one-shot run answers its
 * stdin once with `once(prompt)` and exits. Every start is counted.
 */
function fakeCode(answer: (msg: string) => string, once: (prompt: string) => string = answer) {
  const started: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
  const messages: string[] = [];
  const spawnImpl = ((_bin: string, args: string[], opts: { env?: Record<string, string> }) => {
    started.push({ args, env: opts.env ?? {} });
    const child = new EventEmitter() as Child;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => child.emit("exit", 1);
    const reply = (text: string) => {
      child.stdout.write(
        `${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } })}\n`,
      );
      child.stdout.write(`${JSON.stringify({ type: "result", result: text, is_error: false })}\n`);
    };
    if (args.includes("--input-format")) {
      let buf = "";
      child.stdin.on("data", (d) => {
        buf += d;
        let i = buf.indexOf("\n");
        while (i >= 0) {
          const m = JSON.parse(buf.slice(0, i)).message.content as string;
          buf = buf.slice(i + 1);
          i = buf.indexOf("\n");
          messages.push(m);
          setTimeout(() => reply(answer(m)), 1);
        }
      });
    } else {
      let prompt = "";
      child.stdin.on("data", (d) => {
        prompt += d;
      });
      child.stdin.on("finish", () => {
        reply(once(prompt));
        child.stdout.end();
        setTimeout(() => child.emit("close", 0), 2);
      });
    }
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawnImpl, started, messages };
}

describe("the talking session", () => {
  it("stays open: two messages, one process, thinking off", async () => {
    const f = fakeCode(() => "Sure.");
    const b = new live.LiveBrain(
      { bin: "claude", model: "haiku", dir: path.join(HOME, "a"), spawnImpl: f.spawnImpl },
      "PERSONA",
    );
    await b.reply("hello", { system: "PERSONA\n\nRight now: nothing" });
    await b.reply("and now?", { system: "PERSONA\n\nRight now: one agent" });
    expect(f.started).toHaveLength(1);
    expect(f.started[0]?.env.MAX_THINKING_TOKENS).toBe("0");
    // the live picture rides on each message; the persona is not repeated
    expect(f.messages[1]).toContain("Right now: one agent");
    expect(f.messages[1]).not.toContain("PERSONA");
    expect(f.messages[1]).toContain('The user just said: "and now?"');
    b.close();
  });

  it("is told what Kik already said aloud, so it can own it", async () => {
    const f = fakeCode(() => "That was me thinking out loud.");
    const b = new live.LiveBrain(
      { bin: "claude", model: "haiku", dir: path.join(HOME, "b"), spawnImpl: f.spawnImpl },
      "P",
    );
    await b.reply("what do you mean let me look into that", {
      system: "P",
      asides: ['You said aloud while getting your answer ready: "Let me look into that."'],
    });
    expect(f.messages[0]).toContain(
      '[You said aloud while getting your answer ready: "Let me look into that."]',
    );
    b.close();
  });

  it("starts again when the process dies, instead of going quiet", async () => {
    const f = fakeCode(() => "Here.");
    const b = new live.LiveBrain(
      { bin: "claude", model: "haiku", dir: path.join(HOME, "c"), spawnImpl: f.spawnImpl },
      "P",
    );
    await b.reply("one", { system: "P" });
    b.close();
    await b.reply("two", { system: "P" });
    expect(f.started).toHaveLength(2);
    b.close();
  });
});

describe("the thinking session", () => {
  function daemon(f: ReturnType<typeof fakeCode>) {
    const d = new dmod.Daemon({
      settings: {
        ...cfg.DEFAULTS,
        tts: "none",
        port: 0,
        brain: true,
        brain_provider: "claude-code",
      },
      audio: false,
      persistBoard: false,
      jevKey: "",
      codeSpawn: f.spawnImpl,
    });
    d.agents.bin = () => "claude";
    return d;
  }
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  it("thinks in the background on Opus with thinking on, speaks the answer, and puts the detail on the canvas", async () => {
    const f = fakeCode(
      () => "",
      () =>
        "On the retry question: bound it at three tries.\n---\n## Why\n- unbounded retries hide outages",
    );
    const d = daemon(f);
    const said = d.think("should the retry be bounded?", "the fetch retries forever today");
    expect(said).toMatch(/thinking started/);
    expect((d.state() as { thinking: Array<{ status: string }> }).thinking[0]?.status).toBe(
      "thinking",
    );
    await tick();
    const run = f.started.at(-1);
    expect(run?.args[run.args.indexOf("--model") + 1]).toBe("opus");
    expect(Number(run?.env.MAX_THINKING_TOKENS)).toBeGreaterThan(0);
    const t = (d.state() as { thinking: Array<{ status: string; answer: string; pin: string }> })
      .thinking[0];
    expect(t?.status).toBe("done");
    expect(t?.answer).toBe("On the retry question: bound it at three tries.");
    const card = d.board.get(t?.pin ?? "");
    expect(card?.body).toContain("unbounded retries hide outages");
    await d.close();
  });

  it("tells the talking session what came back, on its next message", async () => {
    const f = fakeCode(
      () => "Yes, three tries.",
      () => "On the retry question: bound it at three tries.",
    );
    const d = daemon(f);
    d.think("should the retry be bounded?");
    await tick();
    d.typed("so what did you decide?");
    await tick(60);
    const msg = f.messages.find((m) => m.includes("so what did you decide?")) ?? "";
    expect(msg).toContain("Your thinking on");
    expect(msg).toContain("bound it at three tries");
    await d.close();
  });

  it("offers the tool to hand things over, and refuses an empty question", async () => {
    const d = daemon(fakeCode(() => ""));
    expect(d.brainTools().some((t) => t.name === "think_deeply")).toBe(true);
    expect(d.think("   ")).toMatch(/what should I think about/);
    await d.close();
  });
});
