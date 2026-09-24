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

  it("gets shorter as the credit runs out, instead of going quiet", async () => {
    // What an account with a few hundred tokens left actually says. It does
    // not truncate the reply; it refuses the request and names the budget it
    // would have taken.
    const refusal = JSON.stringify({
      type: "error",
      error: {
        type: "billing_error",
        message:
          "This request requires more credits, or fewer max_tokens. You requested up to 4000 tokens, but can only afford 981.",
      },
    });
    const sent: Record<string, unknown>[] = [];
    let n = 0;
    const f = (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      if (n++ === 0) return new Response(refusal, { status: 402 });
      return new Response(sse(text("Two failing, both Windows paths.")), { status: 200 });
    }) as unknown as typeof fetch;

    const b = new Brain({ key: "k", model: "m", fetchImpl: f });
    const said = await b.reply("kik how are the tests", { system: "sys" });
    expect(said).toBe("Two failing, both Windows paths.");
    expect(sent[0]?.max_tokens).toBe(4000);
    // asked again for what was actually left, with a little room to spare
    expect(sent[1]?.max_tokens).toBe(882);
  });

  it("gives up rather than hammering an account with nothing left", async () => {
    const broke = JSON.stringify({
      error: { message: "You requested up to 4000 tokens, but can only afford 12." },
    });
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(broke, { status: 402 });
    }) as unknown as typeof fetch;
    const b = new Brain({ key: "k", model: "m", fetchImpl: f });
    await expect(b.reply("kik hello", { system: "sys" })).rejects.toThrow(/402/);
    // twelve tokens is not an answer, so it never asked twice
    expect(calls).toBe(1);
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

  it("goes through OpenRouter with a bearer key and the vendor-prefixed model name", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; model: string }> = [];
    const f = (async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        model: String(JSON.parse(String(init?.body)).model),
      });
      return new Response(sse(text("Hi.")), { status: 200 });
    }) as unknown as typeof fetch;
    const b = new Brain({
      key: "or-k",
      model: "claude-haiku-4-5-20251001",
      provider: "openrouter",
      fetchImpl: f,
    });
    await b.reply("hi", { system: "s" });
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/messages");
    expect(calls[0]?.headers.authorization).toBe("Bearer or-k");
    expect(calls[0]?.headers["x-api-key"]).toBeUndefined();
    expect(calls[0]?.model).toBe("anthropic/claude-haiku-4.5");
    // the default is Anthropic itself, with the key in its own header
    const a = new Brain({ key: "ak", model: "claude-sonnet-5", fetchImpl: f });
    await a.reply("hi", { system: "s" });
    expect(calls[1]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[1]?.headers["x-api-key"]).toBe("ak");
    expect(calls[1]?.model).toBe("claude-sonnet-5");
  });

  it("names models the way each provider wants", async () => {
    const { providerModel } = await import("../src/brain.js");
    expect(providerModel("anthropic", "claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(providerModel("openrouter", "claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
    expect(providerModel("openrouter", "google/gemini-2.5-flash")).toBe("google/gemini-2.5-flash");
    expect(providerModel("openrouter", "claude-opus-6")).toBe("anthropic/claude-opus-6");
  });
});

describe("the provider setting", () => {
  it("uses the OpenRouter key when the setting says so, and none otherwise", async () => {
    const { f } = fakeFetch([text("Hi.")]);
    const settings = {
      ...config.DEFAULTS,
      tts: "none",
      brain: true,
      brain_provider: "openrouter",
    } as typeof config.DEFAULTS;
    const anthropicOnly = new Daemon({ settings, audio: false, anthropicKey: "k", fetchImpl: f });
    expect(anthropicOnly.brain()).toBeNull();
    expect(anthropicOnly.state().brain).toMatchObject({ on: false, provider: "openrouter" });
    await anthropicOnly.close();
    const d = new Daemon({ settings, audio: false, openrouterKey: "or", fetchImpl: f });
    expect(d.brain()?.provider).toBe("openrouter");
    expect(d.state().brain).toMatchObject({ on: true, provider: "openrouter", key: true });
    // switching the setting back swaps the brain, not just its model
    d.reconfigure({ ...settings, brain_provider: "anthropic" }, undefined, "ak");
    expect(d.brain()?.provider).toBe("anthropic");
    await d.close();
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

describe("artifacts by voice", () => {
  it("creates an artifact on the canvas and can read it back", async () => {
    const { f } = fakeFetch([
      toolCall("create_artifact", {
        kind: "checklist",
        title: "release",
        body: "- [ ] tag\n- [ ] notes",
        sticky: true,
      }),
      text("It's on the canvas."),
    ]);
    const settings = {
      ...config.DEFAULTS,
      tts: "none",
      brain: true,
      mic: false,
    } as typeof config.DEFAULTS;
    const d = new Daemon({ settings, audio: false, anthropicKey: "k", fetchImpl: f });
    d.hear("kik make me a release checklist");
    await new Promise((r) => setTimeout(r, 60));
    const pin = d.board.list()[0];
    expect(pin?.kind).toBe("checklist");
    expect(pin?.by).toBe("kik");
    expect(pin?.sticky).toBe(true);
    expect(d.typed("thanks").kind).toBe("chat");
    await d.close();
  });

  it("never starts the model's memory on a tool result", async () => {
    const { f, sent } = fakeFetch([
      toolCall("read_board", {}),
      text("Empty."),
      text("Still empty."),
    ]);
    const b = new Brain({ key: "k", model: "m", fetchImpl: f, memoryMs: 60_000 });
    const tools = [
      {
        name: "read_board",
        description: "",
        input_schema: { type: "object", properties: {} },
        run: () => "nothing",
      },
    ];
    await b.reply("what's on the board", { system: "s", tools });
    // pretend the first user turn aged out: the memory would start on the tool result
    (b as unknown as { turns: Array<{ at: number }> }).turns[0]!.at = 0;
    (b as unknown as { turns: Array<{ at: number }> }).turns[1]!.at = 0;
    await b.reply("and now", { system: "s", tools });
    const msgs = sent.at(-1)?.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[0]?.role).toBe("user");
    expect(typeof msgs[0]?.content).toBe("string");
  });
});

describe("the canvas is how it communicates", () => {
  it("asks with buttons and points at things; the Next line is shown, not spoken", async () => {
    const { f } = fakeFetch([
      toolCall("ask_user", {
        question: "Ship tonight or tomorrow?",
        options: ["tonight", "tomorrow"],
      }),
      toolCall("point_at", { id: "PIN" }),
      text("Tonight it is. Next: what's left | show me the list"),
    ]);
    const settings = {
      ...config.DEFAULTS,
      tts: "none",
      brain: true,
      mic: false,
    } as typeof config.DEFAULTS;
    const d = new Daemon({ settings, audio: false, anthropicKey: "k", fetchImpl: f });
    const frames: Record<string, unknown>[] = [];
    d.hub.listen((fr) => frames.push(fr));
    d.hear("kik when should we ship");
    await new Promise((r) => setTimeout(r, 40));
    const ask = d.board.asking();
    expect(ask?.ask).toEqual(["tonight", "tomorrow"]);
    expect(ask?.by).toBe("kik");
    // the user clicks a button
    expect(d.board.answer(ask!.id, "tonight")).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(frames.some((fr) => fr.type === "focus" && fr.id === ask!.id)).toBe(true);
    expect(frames.some((fr) => fr.type === "suggest")).toBe(true);
    const sug = frames.find((fr) => fr.type === "suggest") as { options: string[] };
    expect(sug.options).toEqual(["what's left", "show me the list"]);
    expect(d.heardLog.at(-1)?.said).toBe("Tonight it is.");
    expect(d.state().look.backdrop).toBe("grid");
    await d.close();
  });
});

describe("memory", () => {
  it("remembers across a restart: the notes and the conversation", async () => {
    const { f } = fakeFetch([
      toolCall("remember", { fact: "the user ships on Fridays" }),
      text("Noted."),
      text("Fridays, you said."),
    ]);
    const settings = {
      ...config.DEFAULTS,
      tts: "none",
      brain: true,
      mic: false,
    } as typeof config.DEFAULTS;
    const d = new Daemon({
      settings,
      audio: false,
      anthropicKey: "k",
      fetchImpl: f,
      persistBoard: true,
    });
    d.hear("kik we ship on fridays");
    await new Promise((r) => setTimeout(r, 60));
    expect(d.memory()).toContain("the user ships on Fridays");
    await d.close();
    // a new daemon, same home: the picture carries the note and the exchange
    const { f: f2, sent } = fakeFetch([text("Friday.")]);
    const d2 = new Daemon({
      settings,
      audio: false,
      anthropicKey: "k",
      fetchImpl: f2,
      persistBoard: true,
    });
    d2.hear("kik when do we ship");
    await new Promise((r) => setTimeout(r, 60));
    expect(String(sent[0]?.system)).toContain("ships on Fridays");
    const msgs = sent[0]?.messages as Array<{ role: string; content: unknown }>;
    expect(JSON.stringify(msgs)).toContain("we ship on fridays");
    await d2.close();
  });
});

describe("presence and the inner thread", () => {
  const settings = () =>
    ({
      ...config.DEFAULTS,
      tts: "none",
      brain: true,
      mic: false,
      morning_brief: false,
    }) as typeof config.DEFAULTS;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("rewrites its inner note after an exchange and thinks from it next time", async () => {
    const { f, sent } = fakeFetch([
      text("Nothing is running."),
      text("Nothing running; the user asked what was up; I expect a session to start soon."),
      text("Still nothing."),
    ]);
    const d = new Daemon({
      settings: settings(),
      audio: false,
      anthropicKey: "k",
      fetchImpl: f,
      reflectMs: 5,
    });
    d.hear("kik what's up");
    await wait(80);
    expect(d.inner()).toContain("expect a session to start");
    expect(d.state().inner).toContain("expect a session");
    expect(String(sent[1]?.messages && JSON.stringify(sent[1].messages))).toContain("inner note");
    d.hear("and now");
    await wait(30);
    expect(String(sent[2]?.system)).toContain("What you were thinking a moment ago");
    expect(String(sent[2]?.system)).toContain("expect a session to start");
    await d.close();
  });

  it("checks in as a diff against what it expected", async () => {
    const { f, sent } = fakeFetch([
      text("I expect the test run to go green."),
      text("The tests have been red for a while now."),
    ]);
    const d = new Daemon({
      settings: settings(),
      audio: false,
      anthropicKey: "k",
      fetchImpl: f,
      reflectMs: 5,
    });
    d.hook({
      hook_event_name: "PreToolUse",
      session_id: "s",
      cwd: HOME,
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
    });
    await d.reflectNow();
    await d.checkIn();
    expect(JSON.stringify(sent[1]?.messages)).toContain("Compare your inner note");
    expect(String(sent[1]?.system)).toContain("I expect the test run to go green");
    await d.close();
  });

  it("says hello on its own when you come back after a while", async () => {
    const { f, sent } = fakeFetch([text("Morning. The timer page is still up.")]);
    const d = new Daemon({
      settings: settings(),
      audio: false,
      anthropicKey: "k",
      fetchImpl: f,
      reflectMs: 5,
    });
    d.presence.seen = Date.now() - 9 * 3600_000;
    // overheard, not addressed: the words never reach the model, the gap does
    expect(d.hear("right then, coffee first").kind).toBe("deciding");
    await wait(60);
    const hello = sent
      .map((s) => JSON.stringify(s.messages))
      .find((m) => m.includes("come back after 9 hours"));
    expect(hello).toBeDefined();
    expect(hello).not.toContain("coffee");
    expect(d.presence.greeted).toBeGreaterThan(0);
    // not twice
    d.presence.seen = Date.now() - 9 * 3600_000;
    d.hear("kik hello");
    await wait(30);
    expect(String(sent[sent.length - 1]?.system)).not.toContain("just come back");
    await d.close();
  });

  it("folds the hello into the reply when the first thing said is for it", async () => {
    const { f, sent } = fakeFetch([text("Hey. Nothing ran overnight.")]);
    const d = new Daemon({
      settings: settings(),
      audio: false,
      anthropicKey: "k",
      fetchImpl: f,
      reflectMs: 5,
    });
    d.presence.seen = Date.now() - 2 * 3600_000;
    d.hear("kik what happened overnight");
    await wait(40);
    expect(String(sent[0]?.system)).toContain("just come back after 2 hours");
    expect(sent.length).toBeGreaterThanOrEqual(1);
    // the hook keeps presence fresh: no hello for someone who has been typing
    d.presence.greeted = 0;
    d.hook({
      hook_event_name: "PreToolUse",
      session_id: "s",
      cwd: HOME,
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    d.hear("kik and now");
    await wait(30);
    expect(String(sent[sent.length - 1]?.system)).not.toContain("just come back");
    await d.close();
  });

  it("says hm when the model is slow, and not when it is quick", async () => {
    const { f } = fakeFetch([text("Quick answer.")]);
    const slow = (async (url: unknown, init?: RequestInit) => {
      await wait(60);
      return f(url as string, init);
    }) as unknown as typeof fetch;
    const d = new Daemon({
      settings: settings(),
      audio: false,
      anthropicKey: "k",
      fetchImpl: slow,
      fillerMs: 15,
      reflectMs: 5,
    });
    const said: string[] = [];
    d.hub.listen((fr) => {
      if (fr.type === "speech" && fr.phase === "speaking") said.push(String(fr.text));
    });
    d.hear("kik what's it doing");
    await wait(150);
    expect(said.some((s) => ["Hm.", "One sec.", "Let me look.", "Mm."].includes(s))).toBe(true);
    expect(said).toContain("Quick answer.");
    await d.close();
    const { f: f2 } = fakeFetch([text("Quick answer.")]);
    const d2 = new Daemon({
      settings: settings(),
      audio: false,
      anthropicKey: "k",
      fetchImpl: f2,
      fillerMs: 50,
      reflectMs: 5,
    });
    const said2: string[] = [];
    d2.hub.listen((fr) => {
      if (fr.type === "speech" && fr.phase === "speaking") said2.push(String(fr.text));
    });
    d2.hear("kik what's it doing");
    await wait(120);
    expect(said2.some((s) => ["Hm.", "One sec.", "Let me look.", "Mm."].includes(s))).toBe(false);
    await d2.close();
  });
});

describe("a life in memory", () => {
  it("journals the days before today, once, and reads them back into the picture", async () => {
    const { appendFileSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { dayOf } = await import("../src/daemon.js");
    const home = HOME;
    const day = 86_400_000;
    const yesterday = Date.now() - day;
    const old = Date.now() - 40 * day;
    mkdirSync(home, { recursive: true });
    const conv = path.join(home, "conversation.jsonl");
    appendFileSync(
      conv,
      `${JSON.stringify({ at: yesterday, you: "kik make me a standup timer", kik: "Done, it is on the board." })}\n`,
    );
    appendFileSync(
      conv,
      `${JSON.stringify({ at: yesterday + 60_000, you: "we ship on fridays", kik: "Noted." })}\n`,
    );
    appendFileSync(
      conv,
      `${JSON.stringify({ at: Date.now(), you: "kik what's up", kik: "Nothing yet." })}\n`,
    );
    writeFileSync(path.join(home, "journal.md"), `- ${dayOf(old)}: something from long ago\n`);
    const { f, sent } = fakeFetch([
      text(
        `- ${dayOf(yesterday)}: made a standup timer page for the user\n- ${dayOf(yesterday)}: they ship on Fridays`,
      ),
      text("You made a timer yesterday."),
    ]);
    const settings = {
      ...config.DEFAULTS,
      tts: "none",
      brain: true,
      mic: false,
    } as typeof config.DEFAULTS;
    const d = new Daemon({
      settings,
      audio: false,
      anthropicKey: "k",
      fetchImpl: f,
      persistBoard: true,
    });
    expect(await d.consolidate()).toBe(1);
    const asked = JSON.stringify(sent[0]?.messages);
    expect(asked).toContain("standup timer");
    expect(asked).not.toContain("what's up");
    const journal = d.journal();
    expect(journal).toContain("made a standup timer page");
    expect(journal).toContain("ship on Fridays");
    expect(journal).not.toContain("long ago");
    // a second pass has nothing new
    expect(await d.consolidate()).toBe(0);
    expect(sent.length).toBe(1);
    d.hear("kik what did we do yesterday");
    await new Promise((r) => setTimeout(r, 40));
    expect(String(sent[1]?.system)).toContain("Your journal of earlier days");
    expect(String(sent[1]?.system)).toContain("made a standup timer page");
    expect(d.state().journal_days).toBe(2);
    await d.close();
  });
});

describe("reasons to speak", () => {
  const hook = (d: InstanceType<typeof Daemon>, name: string, extra: Record<string, unknown>) =>
    d.hook({ hook_event_name: name, session_id: "w", cwd: path.join(HOME, "shop"), ...extra });
  const quiet = () =>
    new Daemon({
      settings: { ...config.DEFAULTS, tts: "none", mic: false } as typeof config.DEFAULTS,
      audio: false,
    });
  // what the watchers raised; the permission question keeps the floor, so
  // the spoken line itself waits behind it
  const spoken = (d: InstanceType<typeof Daemon>) => {
    const out: string[] = [];
    d.hub.listen((fr) => {
      if (fr.type === "concern") out.push(String(fr.text));
    });
    return out;
  };

  it("mentions an agent kept waiting, once", async () => {
    const d = quiet();
    const said = spoken(d);
    hook(d, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "git push" } });
    // first seen four minutes ago, by the clock the register also reads
    const now = Date.now();
    expect(d.watch(now - 4 * 60_000)).toEqual([]);
    expect(d.watch(now)).toHaveLength(1);
    expect(d.watch(now + 60_000)).toEqual([]);
    await new Promise((r) => setTimeout(r, 30));
    expect(said.some((s) => /waiting on you for \d minutes: .*git push/.test(s))).toBe(true);
    // the register knows too, and never says so
    expect(d.brainSystem()).toContain("Register right now");
    expect(d.brainSystem()).toContain("waiting on the user");
    await d.close();
  });

  it("mentions tests red for half an hour, and the same error three times", async () => {
    const d = quiet();
    const said = spoken(d);
    hook(d, "PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: "Tests: 18 passed, 2 failed",
    });
    const now = Date.now();
    expect(d.watch(now)).toEqual([]);
    expect(d.watch(now + 10 * 60_000)).toEqual([]);
    expect(d.watch(now + 31 * 60_000)).toHaveLength(1);
    for (let i = 0; i < 3; i++)
      hook(d, "PostToolUseFailure", { tool_name: "Bash", error: "ECONNREFUSED 127.0.0.1:5432" });
    expect(d.watch(now + 32 * 60_000)).toHaveLength(1);
    expect(d.watch(now + 33 * 60_000)).toEqual([]);
    await new Promise((r) => setTimeout(r, 30));
    expect(said.some((s) => /red for 31 minutes/.test(s))).toBe(true);
    expect(said.some((s) => /same error three times: ECONNREFUSED/.test(s))).toBe(true);
    // three failures in the hour is not a mood; four is
    hook(d, "PostToolUseFailure", { tool_name: "Bash", error: "boom" });
    expect(d.brainSystem()).toContain("failures: drier");
    // green again after red: quietly pleased
    hook(d, "PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: "Tests: 20 passed",
    });
    expect(d.brainSystem()).toContain("just went green");
    await d.close();
  });
});

describe("anything on the canvas", () => {
  it("puts a live web page on the canvas from a URL, a host, or a port", async () => {
    const { f } = fakeFetch([
      toolCall("create_artifact", { kind: "web", title: "the shop", body: "3000" }),
      text("It is on the canvas."),
    ]);
    const settings = {
      ...config.DEFAULTS,
      tts: "none",
      brain: true,
      mic: false,
    } as typeof config.DEFAULTS;
    const d = new Daemon({ settings, audio: false, anthropicKey: "k", fetchImpl: f });
    d.hear("kik open the shop on the canvas");
    await new Promise((r) => setTimeout(r, 60));
    const web = d.board.list().find((p) => p.kind === "web");
    expect(web?.body).toBe("http://localhost:3000");
    expect(web?.size).toBe("wide");
    const tool = d.brainTools().find((t) => t.name === "create_artifact");
    expect(await tool?.run({ kind: "web", title: "x", body: "ftp://nope" })).toContain("http://");
    await tool?.run({ kind: "web", title: "docs", body: "https://example.com/docs" });
    expect(d.board.list().filter((p) => p.kind === "web")).toHaveLength(2);
    await d.close();
  });
});

describe("turn-taking and being wrong well", () => {
  it("stops talking when spoken to over it, through speakers too", async () => {
    const d = new Daemon({
      settings: { ...config.DEFAULTS, tts: "none", mic: false } as typeof config.DEFAULTS,
      audio: false,
    });
    const phases: string[] = [];
    d.hub.listen((fr) => {
      if (fr.type === "speech") phases.push(String(fr.phase));
    });
    d.say("The build is green and the deploy went out a minute ago.", 2);
    await new Promise((r) => setTimeout(r, 10));
    // a voiceless test run finishes a line at once; hold the floor as a real speaker would
    (d.arbiter as unknown as { pending: () => boolean }).pending = () => true;
    // its own echo is not a barge-in
    expect(d.hear("the build is green and the deploy went out").kind).toBe("self");
    expect(phases).not.toContain("interrupted");
    d.hear("kik whats waiting on me");
    expect(phases).toContain("interrupted");
    await d.close();
  });

  it("takes a correction: the reply is told, the note is rewritten", async () => {
    const { f, sent } = fakeFetch([text("Thursdays, got it."), text("note")]);
    const settings = {
      ...config.DEFAULTS,
      tts: "none",
      brain: true,
      mic: false,
    } as typeof config.DEFAULTS;
    const d = new Daemon({ settings, audio: false, anthropicKey: "k", fetchImpl: f, reflectMs: 5 });
    d.hear("kik no that's wrong, we ship on thursdays");
    await new Promise((r) => setTimeout(r, 60));
    expect(String(sent[0]?.system)).toContain("The user is correcting you");
    expect(String(sent[0]?.system)).toContain("with remember");
    await d.close();
  });
});

describe("the designer", () => {
  it("builds a page from a brief with the designer model and the design brief", async () => {
    const { f, sent } = fakeFetch([
      toolCall("design_artifact", {
        title: "Cats vs dogs",
        brief: "a visual comparison of cats and dogs as pets",
      }),
      text(
        '```jsx\nimport { useState } from "react";\nexport default function App() { return <h1 className="text-2xl">Cats vs dogs</h1>; }\n```',
      ),
      text("It is on the canvas."),
    ]);
    const settings = {
      ...config.DEFAULTS,
      tts: "none",
      brain: true,
      mic: false,
    } as typeof config.DEFAULTS;
    const d = new Daemon({ settings, audio: false, anthropicKey: "k", fetchImpl: f });
    d.hear("kik compare cats and dogs visually");
    await new Promise((r) => setTimeout(r, 80));
    const design = sent[1];
    expect(design?.model).toBe("claude-opus-5-5");
    expect(String(design?.system)).toContain("You design and build screens");
    expect(JSON.stringify(design?.messages)).toContain("cats and dogs");
    const pin = d.board.list().find((p) => p.kind === "react");
    expect(pin?.body.startsWith("import { useState }")).toBe(true);
    expect(pin?.body).not.toContain("```");
    expect(pin?.size).toBe("wide");
    await d.close();
  });
});

describe("the designer's manners", () => {
  it("says the wait itself, and sketches quickly on the voice model when asked", async () => {
    const { f, sent } = fakeFetch([
      toolCall("design_artifact", { title: "Sketch", brief: "a rough timer", quick: true }),
      text("export default function App() { return <p>t</p>; }"),
      text("Sketched."),
    ]);
    const settings = {
      ...config.DEFAULTS,
      tts: "none",
      brain: true,
      mic: false,
    } as typeof config.DEFAULTS;
    const d = new Daemon({ settings, audio: false, anthropicKey: "k", fetchImpl: f });
    const said: string[] = [];
    d.hub.listen((fr) => {
      if (fr.type === "speech" && fr.phase === "speaking") said.push(String(fr.text));
    });
    d.hear("kik quick sketch of a timer");
    await new Promise((r) => setTimeout(r, 80));
    expect(said.some((s) => /twenty seconds/.test(s))).toBe(true);
    expect(sent[1]?.model).toBe(config.DEFAULTS.brain_model);
    expect(sent[1]?.max_tokens).toBe(6000);
    expect(String(sent[1]?.system)).toContain("quick sketch");
    expect(d.board.list().some((p) => p.kind === "react")).toBe(true);
    await d.close();
  });
});
