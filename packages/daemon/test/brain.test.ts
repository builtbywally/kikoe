import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-brain-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let Brain: typeof import("../src/brain.js").Brain;
let Daemon: typeof import("../src/daemon.js").Daemon;
let config: typeof import("../src/config.js");

beforeAll(async () => {
  Brain = (await import("../src/brain.js")).Brain;
  Daemon = (await import("../src/daemon.js")).Daemon;
  config = await import("../src/config.js");
});

/** An SSE body the way the Messages API streams it. */
function sse(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const e of events)
        controller.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
      controller.close();
    },
  });
}
const text = (s: string) => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ...s.split(" ").map((w, i) => ({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: (i ? " " : "") + w },
  })),
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
  { type: "message_stop" },
];
const toolCall = (name: string, input: Record<string, unknown>, lead = "") => [
  ...(lead
    ? [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: lead } },
        { type: "content_block_stop", index: 0 },
      ]
    : []),
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "tu_1", name, input: {} },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(input).slice(0, 5) },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(input).slice(5) },
  },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" } },
  { type: "message_stop" },
];

/** A fake API: answers from a script, records what it was sent. */
function fakeFetch(script: Record<string, unknown>[][]) {
  const sent: Record<string, unknown>[] = [];
  let n = 0;
  const f = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? "{}")));
    const events = script[Math.min(n++, script.length - 1)] ?? [];
    return new Response(sse(events), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, sent };
}

describe("the brain", () => {
  it("streams clauses as they finish and remembers the exchange", async () => {
    const { f, sent } = fakeFetch([text("Tests pass. Two are still failing on Windows paths.")]);
    const b = new Brain({ key: "k", model: "m", fetchImpl: f });
    const clauses: string[] = [];
    const said = await b.reply("kik did the tests pass", {
      system: "sys",
      onClause: (c) => clauses.push(c),
    });
    expect(clauses).toEqual(["Tests pass.", "Two are still failing on Windows paths."]);
    expect(said).toBe("Tests pass. Two are still failing on Windows paths.");
    expect(sent[0]?.system).toBe("sys");
    expect(sent[0]?.stream).toBe(true);
    await b.reply("and now", { system: "sys" });
    const msgs = sent[1]?.messages as Array<{ role: string }>;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("runs a tool and carries the result back", async () => {
    const { f, sent } = fakeFetch([
      toolCall("instruct_agent", { instruction: "add a retry" }, "On it."),
      text("Queued; it gets it when this turn ends."),
    ]);
    const b = new Brain({ key: "k", model: "m", fetchImpl: f });
    const ran: unknown[] = [];
    const said = await b.reply("kik tell it to add a retry", {
      system: "sys",
      tools: [
        {
          name: "instruct_agent",
          description: "",
          input_schema: { type: "object", properties: {} },
          run: (i) => {
            ran.push(i);
            return "queued for storefront";
          },
        },
      ],
    });
    expect(ran).toEqual([{ instruction: "add a retry" }]);
    expect(said).toBe("On it. Queued; it gets it when this turn ends.");
    const second = sent[1]?.messages as Array<{ role: string; content: unknown }>;
    expect(second[2]?.role).toBe("user");
    expect(JSON.stringify(second[2]?.content)).toContain("queued for storefront");
  });

  it("fails loudly on a bad status", async () => {
    const f = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const b = new Brain({ key: "k", model: "m", fetchImpl: f });
    await expect(b.reply("hi", { system: "s" })).rejects.toThrow(/401/);
  });
});

describe("the brain in the daemon", () => {
  function quiet(f: typeof fetch) {
    const settings = {
      ...config.DEFAULTS,
      tts: "none",
      brain: true,
      mic: false,
    } as typeof config.DEFAULTS;
    return new Daemon({ settings, audio: false, anthropicKey: "k", fetchImpl: f });
  }

  it("answers what is addressed to it, in the model's words, and opens the window", async () => {
    const { f } = fakeFetch([text("Nothing is running right now.")]);
    const d = quiet(f);
    expect(d.hear("kik what's it doing").kind).toBe("chat");
    await new Promise((r) => setTimeout(r, 50));
    expect(d.heardLog[0]?.said).toBe("Nothing is running right now.");
    expect(d.heardLog[0]?.kind).toBe("chat");
    // the window is open: no name needed for the follow-up
    expect(d.hear("since when").kind).toBe("chat");
    await d.close();
  });

  it("hands a voice instruction to the agent through its Stop hook, once", async () => {
    const { f } = fakeFetch([
      toolCall("instruct_agent", { instruction: "add a retry to fetch" }),
      text("Queued."),
    ]);
    const d = quiet(f);
    d.hook({
      hook_event_name: "PreToolUse",
      session_id: "s1",
      cwd: path.join(HOME, "storefront"),
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
    });
    d.hear("kik tell it to add a retry to fetch");
    await new Promise((r) => setTimeout(r, 50));
    expect(d.instructions.map((i) => i.repo)).toEqual(["storefront"]);
    expect(d.hookReply({ hook_event_name: "Stop", session_id: "s1" }, "other")).toBeNull();
    const r = d.hookReply({ hook_event_name: "Stop", session_id: "s1" }, "storefront");
    expect(r?.decision).toBe("block");
    expect(String(r?.reason)).toContain("add a retry to fetch");
    expect(d.hookReply({ hook_event_name: "Stop", session_id: "s1" }, "storefront")).toBeNull();
    await d.close();
  });

  it("falls back to the rules when the model is unreachable", async () => {
    const f = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    const d = quiet(f);
    d.hear("kik thanks");
    await new Promise((r) => setTimeout(r, 50));
    expect(d.heardLog[0]?.said).toBe("Anytime.");
    await d.close();
  });

  it("stays a rulebook without a key or with the switch off", async () => {
    const { f } = fakeFetch([text("should not be called")]);
    const settings = {
      ...config.DEFAULTS,
      tts: "none",
      brain: false,
      mic: false,
    } as typeof config.DEFAULTS;
    const d = new Daemon({ settings, audio: false, anthropicKey: "k", fetchImpl: f });
    expect(d.hear("kik thanks")).toMatchObject({ kind: "social", said: "Anytime." });
    await d.close();
  });
});

describe("conversation, the way the assistants do it", () => {
  it("decides a follow-up in the gray zone with the model, and keeps its window", async () => {
    const { f, sent } = fakeFetch([
      text("Nothing's running."),
      text("yes"),
      text("Since about noon."),
    ]);
    const settings = {
      ...config.DEFAULTS,
      tts: "none",
      brain: true,
      mic: false,
    } as typeof config.DEFAULTS;
    const d = new Daemon({ settings, audio: false, anthropicKey: "k", fetchImpl: f });
    d.hear("kik what's it doing");
    await new Promise((r) => setTimeout(r, 30));
    // close the window by hand; the exchange is still recent
    (d as unknown as { attentionUntil: number }).attentionUntil = 0;
    expect(d.hear("and since when has that been the case").kind).toBe("deciding");
    await new Promise((r) => setTimeout(r, 60));
    expect(String((sent[1]?.messages as Array<{ content: string }>)[0]?.content)).toContain(
      "since when",
    );
    expect(d.heardLog.at(-1)?.kind).toBe("chat");
    expect(d.heardLog.at(-1)?.text).toBe("and since when has that been the case");
    await d.close();
  });

  it("holds half a sentence for its other half", async () => {
    const settings = { ...config.DEFAULTS, tts: "none", mic: false } as typeof config.DEFAULTS;
    const d = new Daemon({ settings, audio: false });
    expect(d.hearSegment("kik how long has it", {}).kind).toBe("held");
    expect(d.hearSegment("been going?", {}).kind).toBe("question");
    expect(d.heardLog[0]?.text).toBe("kik how long has it been going?");
    expect(d.hearSegment("kik thanks.", {}).kind).toBe("social");
    await d.close();
  });
});
