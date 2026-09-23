import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-codebrain-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let cb: typeof import("../src/codebrain.js");
beforeAll(async () => {
  cb = await import("../src/codebrain.js");
});

/**
 * A stand-in for `claude -p`: records its arguments and stdin, then prints
 * the stream-json lines it was given, as the real one does.
 */
function fakeClaude(lines: unknown[], exitCode = 0) {
  const seen: { args: string[]; stdin: string; cwd: string } = { args: [], stdin: "", cwd: "" };
  const spawnImpl = ((_bin: string, args: string[], opts: { cwd: string }) => {
    seen.args = args;
    seen.cwd = opts.cwd;
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => child.emit("close", 1);
    child.stdin.on("data", (d) => {
      seen.stdin += d;
    });
    child.stdin.on("finish", () => {
      for (const l of lines) child.stdout.write(`${JSON.stringify(l)}\n`);
      child.stdout.end();
      setTimeout(() => child.emit("close", exitCode), 5);
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawnImpl, seen };
}

const delta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

describe("the tools, served to Claude Code over MCP", () => {
  it("lists Kik's tools and runs one when called, and nobody else gets in", async () => {
    const ran: unknown[] = [];
    const server = new cb.ToolServer([
      {
        name: "remember",
        description: "save a fact",
        input_schema: { type: "object", properties: { fact: { type: "string" } } },
        run: (i) => {
          ran.push(i);
          return "saved";
        },
      },
    ]);
    await server.start();
    const url = `http://127.0.0.1:${server.port}/mcp`;
    const rpc = async (method: string, params: unknown = {}, token = server.token) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return { status: r.status, body: r.status === 200 ? await r.json() : null };
    };
    const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
    expect(init.body.result.capabilities.tools).toBeDefined();
    const list = await rpc("tools/list");
    expect(list.body.result.tools[0].name).toBe("remember");
    expect(list.body.result.tools[0].inputSchema.type).toBe("object");
    const call = await rpc("tools/call", { name: "remember", arguments: { fact: "fridays" } });
    expect(call.body.result.content[0].text).toBe("saved");
    expect(ran).toEqual([{ fact: "fridays" }]);
    expect((await rpc("tools/list", {}, "wrong")).status).toBe(401);
    // the notification that follows initialize wants no answer
    const note = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(note.status).toBe(202);
    await server.stop();
  });
});

describe("thinking through Claude Code", () => {
  it("runs with no hooks, no built-in tools, and only Kik's own MCP server", () => {
    const args = cb.codeArgs({
      model: "m",
      systemFile: "s.md",
      settingsFile: "set.json",
      mcpFile: "mcp.json",
    });
    expect(args).toContain("-p");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__kik");
    expect(args[args.indexOf("--system-prompt-file") + 1]).toBe("s.md");
  });

  it("writes the setting that keeps Kikoe's hooks out of its own thinking", () => {
    const dir = path.join(HOME, "brain-a");
    new cb.CodeBrain({ bin: "claude", model: "m", dir });
    expect(JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"))).toEqual({
      disableAllHooks: true,
    });
  });

  it("speaks clause by clause as the text streams, and remembers the exchange", async () => {
    const { spawnImpl, seen } = fakeClaude([
      { type: "system", subtype: "init" },
      delta("Got it. "),
      delta("You ship on Fridays."),
      {
        type: "result",
        subtype: "success",
        result: "Got it. You ship on Fridays.",
        is_error: false,
      },
    ]);
    const b = new cb.CodeBrain({
      bin: "claude",
      model: "m",
      dir: path.join(HOME, "brain-b"),
      spawnImpl,
    });
    const clauses: string[] = [];
    const said = await b.reply("remember we ship on fridays", {
      system: "You are Kik.",
      onClause: (c) => clauses.push(c),
    });
    expect(clauses).toEqual(["Got it.", "You ship on Fridays."]);
    expect(said).toBe("Got it. You ship on Fridays.");
    expect(seen.stdin).toContain('The user just said: "remember we ship on fridays"');
    expect(b.recent()).toContain("You ship on Fridays.");
    // and the next question carries the conversation
    const second = fakeClaude([delta("Fridays."), { type: "result", result: "Fridays." }]);
    const b2 = new cb.CodeBrain({
      bin: "claude",
      model: "m",
      dir: path.join(HOME, "brain-b"),
      spawnImpl: second.spawnImpl,
    });
    b2.seed([{ at: Date.now(), you: "remember we ship on fridays", kik: said }]);
    await b2.reply("when do we ship", { system: "You are Kik." });
    expect(second.seen.stdin).toContain("User: remember we ship on fridays");
  });

  it("fails loudly on an error result, so the rules can answer instead", async () => {
    const { spawnImpl } = fakeClaude(
      [
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "usage limit reached",
        },
      ],
      1,
    );
    const b = new cb.CodeBrain({
      bin: "claude",
      model: "m",
      dir: path.join(HOME, "brain-c"),
      spawnImpl,
    });
    await expect(b.reply("hello", { system: "s" })).rejects.toThrow(/usage limit/);
  });

  it("answers a one-line compose, and a hyphen means nothing to say", async () => {
    const quiet = fakeClaude([{ type: "result", result: "-" }]);
    const b = new cb.CodeBrain({
      bin: "claude",
      model: "m",
      dir: path.join(HOME, "brain-d"),
      spawnImpl: quiet.spawnImpl,
    });
    expect(await b.compose("anything worth saying?", "s")).toBe("");
  });
});
