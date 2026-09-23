/**
 * Kik thinking through Claude Code: the user's own subscription, no API key.
 *
 * The API head (`brain.ts`) needs credit, and the account ran dry more than
 * once; Kik was the rulebook for days while a whole Claude sat idle on the
 * user's subscription. This head runs `claude -p` headless for each thing
 * Kik has to think about. It is slower — about six seconds to the first
 * word against one — which the daemon covers with a filler, and it is the
 * same Claude.
 *
 * Kik's tools (make a card, remember, tell the agent, …) reach it as an MCP
 * server this head starts on loopback for the length of one reply: a random
 * port, a random token, three JSON-RPC methods, and gone. Claude Code calls
 * them the way it calls any MCP tool, and each call runs the same function
 * the API head would have run.
 *
 * Three things are switched off in the child, on purpose:
 *  - **Kikoe's own hooks** (`disableAllHooks`), or Kik would narrate its own
 *    thinking as though it were an agent at work.
 *  - **Claude Code's built-in tools** (`--tools ""`): Kik's head does not edit
 *    files or run commands; the agent does, when Kik tells it to.
 *  - **Every other MCP server** (`--strict-mcp-config`): only Kik's own.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Brain, type BrainTool, type ReplyOptions } from "./brain.js";

export const CODE_PROVIDER = "claude-code";
/** A reply that has not finished in this long is abandoned. */
export const REPLY_TIMEOUT_MS = 120_000;
/** A page designed through the CLI can take minutes. */
const GENERATE_TIMEOUT_MS = 300_000;

export const SENTENCE_END = /([.!?])(\s+|$)/;

export interface CodeBrainOptions {
  /** the claude binary */
  bin: string;
  model: string;
  /** where the child runs and its files live (~/.kikoe/brain) */
  dir: string;
  log?: (line: string) => void;
  /** for tests: what starts the child */
  spawnImpl?: typeof spawn;
}

/** One line of `--output-format stream-json`, as far as this head reads it. */
export interface StreamLine {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
}

/**
 * Kik's tools as a Model Context Protocol server, for one reply. Streamable
 * HTTP with plain JSON answers: initialize, tools/list, tools/call, ping.
 */
export class ToolServer {
  private server: http.Server | null = null;
  readonly token = randomBytes(18).toString("hex");
  port = 0;
  constructor(
    private readonly tools: BrainTool[],
    private readonly log: (line: string) => void = () => {},
  ) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", () => resolve()));
    const a = this.server.address();
    this.port = a && typeof a === "object" ? a.port : 0;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    const closed = new Promise<void>((r) => s.close(() => r()));
    s.closeAllConnections();
    await closed;
  }

  /** The --mcp-config Claude Code is given: this server and nothing else. */
  config(): Record<string, unknown> {
    return {
      mcpServers: {
        kik: {
          type: "http",
          url: `http://127.0.0.1:${this.port}/mcp`,
          headers: { Authorization: `Bearer ${this.token}` },
        },
      },
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      // no server-sent stream: every answer comes back on its own POST
      res.writeHead(405).end();
      return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }
    // a notification wants no answer
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const answer = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    };
    switch (msg.method) {
      case "initialize":
        return answer({
          protocolVersion: String(msg.params?.protocolVersion ?? "2025-06-18"),
          capabilities: { tools: {} },
          serverInfo: { name: "kik", version: "1" },
        });
      case "ping":
        return answer({});
      case "tools/list":
        return answer({
          tools: this.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.input_schema,
          })),
        });
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const input = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        const tool = this.tools.find((t) => t.name === name);
        let out: string;
        let isError = false;
        try {
          out = tool ? String(await tool.run(input)) : `no such tool: ${name}`;
          isError = !tool;
        } catch (e) {
          out = `failed: ${(e as Error).message}`;
          isError = true;
        }
        this.log(
          `brain tool ${name} ${JSON.stringify(input).slice(0, 120)} -> ${out.slice(0, 120)}`,
        );
        return answer({ content: [{ type: "text", text: out }], isError });
      }
      default:
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `no method ${msg.method}` },
          }),
        );
    }
  }
}

/** The arguments for one headless run. Exported so a test can read them. */
export function codeArgs(o: {
  model: string;
  systemFile: string;
  settingsFile: string;
  mcpFile?: string | undefined;
}): string[] {
  const args = [
    "-p",
    "--model",
    o.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--system-prompt-file",
    o.systemFile,
    "--settings",
    o.settingsFile,
    "--tools",
    "",
    "--strict-mcp-config",
  ];
  if (o.mcpFile) args.push("--mcp-config", o.mcpFile, "--allowedTools", "mcp__kik");
  else args.push("--mcp-config", JSON.stringify({ mcpServers: {} }));
  return args;
}

export class CodeBrain extends Brain {
  protected history: Array<{ at: number; you: string; kik: string }> = [];
  protected readonly log: (line: string) => void;
  protected queue: Promise<unknown> = Promise.resolve();

  constructor(protected readonly code: CodeBrainOptions) {
    super({ key: "", model: code.model, provider: CODE_PROVIDER });
    this.log = code.log ?? (() => {});
    mkdirSync(code.dir, { recursive: true });
    // Kikoe's hooks are installed in the user's Claude Code settings; this
    // child must not fire them, or Kik narrates its own thinking.
    writeFileSync(this.file("settings.json"), JSON.stringify({ disableAllHooks: true }));
  }

  override get provider(): string {
    return CODE_PROVIDER;
  }

  protected file(name: string): string {
    return path.join(this.code.dir, name);
  }

  override forget(): void {
    this.history = [];
  }

  override seed(exchanges: Array<{ at: number; you: string; kik: string }>): void {
    this.history = [...exchanges.filter((e) => e.you && e.kik), ...this.history].slice(-20);
  }

  override recent(n = 6): string {
    return this.history
      .slice(-n)
      .map((e) => `User: ${e.you}\nKik: ${e.kik}`)
      .join("\n");
  }

  /** One at a time, like the API head: a second question waits for the first answer. */
  override reply(text: string, o: ReplyOptions): Promise<string> {
    const run = this.queue.then(() => this.think(text, o));
    this.queue = run.catch(() => {});
    return run;
  }

  private async think(text: string, o: ReplyOptions): Promise<string> {
    const tools = o.tools ?? [];
    const server = tools.length ? new ToolServer(tools, this.log) : null;
    await server?.start();
    const mine = this.history.filter((e) => Date.now() - e.at < 2 * 3600_000).slice(-8);
    const prompt = [
      mine.length
        ? `The conversation so far (speech transcripts, oldest first):\n${mine.map((e) => `User: ${e.you}\nKik: ${e.kik}`).join("\n")}\n`
        : "",
      `The user just said: "${text}"`,
    ].join("\n");
    let spoken = "";
    let pending = "";
    const say = (clause: string) => {
      const c = clause.trim();
      if (!c) return;
      spoken += (spoken ? " " : "") + c;
      o.onClause?.(c);
    };
    try {
      await this.run(
        prompt,
        `${o.system}\n\nYour tools are the kik server's. Use them the way the instructions above describe.`,
        {
          ...(server ? { mcp: server.config() } : {}),
          signal: o.signal,
          timeoutMs: REPLY_TIMEOUT_MS,
          onText: (chunk) => {
            pending += chunk;
            let m = SENTENCE_END.exec(pending);
            while (m && m.index !== undefined) {
              say(pending.slice(0, m.index + (m[1] ?? "").length));
              pending = pending.slice(m.index + m[0].length);
              m = SENTENCE_END.exec(pending);
            }
          },
          // a tool call ends the text before it: say what was pending
          onBreak: () => {
            say(pending);
            pending = "";
          },
        },
      );
    } finally {
      await server?.stop();
    }
    say(pending);
    this.history.push({ at: Date.now(), you: text, kik: spoken });
    this.history = this.history.slice(-20);
    return spoken;
  }

  override async compose(prompt: string, system: string, signal?: AbortSignal): Promise<string> {
    const text = (await this.run(prompt, system, { signal, timeoutMs: REPLY_TIMEOUT_MS })).trim();
    return text === "-" || text === "—" ? "" : text;
  }

  override async generate(
    prompt: string,
    system: string,
    o: { model?: string; maxTokens?: number; signal?: AbortSignal; think?: number } = {},
  ): Promise<string> {
    return (
      await this.run(prompt, system, {
        model: o.model,
        signal: o.signal,
        timeoutMs: GENERATE_TIMEOUT_MS,
        think: o.think,
      })
    ).trim();
  }

  override async directed(text: string, lastExchange: string): Promise<boolean> {
    const a = await this.compose(
      `The last exchange with Kik:\n${lastExchange || "(none)"}\n\nThe new sentence, as transcribed: "${text}"\n\nWas it addressed to Kik? Answer with exactly one word: yes or no.`,
      "You decide whether a sentence overheard by a voice assistant named Kik was addressed to Kik or to someone else in the room. You answer with one word.",
    );
    return a.toLowerCase().startsWith("yes");
  }

  /** One headless Claude Code run. Resolves to the final text. */
  private run(
    prompt: string,
    system: string,
    o: {
      model?: string | undefined;
      mcp?: Record<string, unknown> | undefined;
      signal?: AbortSignal | undefined;
      timeoutMs: number;
      /** a thinking budget in tokens; 0 switches thinking off */
      think?: number | undefined;
      onText?: (chunk: string) => void;
      onBreak?: () => void;
    },
  ): Promise<string> {
    const id = randomBytes(4).toString("hex");
    const systemFile = this.file(`system-${id}.md`);
    writeFileSync(systemFile, system);
    let mcpFile: string | undefined;
    if (o.mcp) {
      mcpFile = this.file(`mcp-${id}.json`);
      writeFileSync(mcpFile, JSON.stringify(o.mcp));
    }
    const args = codeArgs({
      model: o.model ?? this.code.model,
      systemFile,
      settingsFile: this.file("settings.json"),
      mcpFile,
    });
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = (this.code.spawnImpl ?? spawn)(this.code.bin, args, {
          cwd: this.code.dir,
          windowsHide: true,
          shell: /\.(cmd|bat)$/i.test(this.code.bin),
          stdio: ["pipe", "pipe", "pipe"],
          env:
            o.think === undefined
              ? process.env
              : { ...process.env, MAX_THINKING_TOKENS: String(o.think) },
        });
      } catch (e) {
        reject(e);
        return;
      }
      let out = "";
      let err = "";
      let final = "";
      let text = "";
      let failed = "";
      let first = 0;
      const timer = setTimeout(() => {
        failed = `claude code took over ${Math.round(o.timeoutMs / 1000)} s`;
        child.kill();
      }, o.timeoutMs);
      o.signal?.addEventListener("abort", () => {
        failed = "cancelled";
        child.kill();
      });
      const line = (l: string) => {
        if (!l.trim()) return;
        let j: StreamLine;
        try {
          j = JSON.parse(l);
        } catch {
          return;
        }
        if (j.type === "stream_event") {
          const ev = j.event;
          if (
            ev?.type === "content_block_delta" &&
            ev.delta?.type === "text_delta" &&
            ev.delta.text
          ) {
            if (!first) first = Date.now();
            text += ev.delta.text;
            o.onText?.(ev.delta.text);
          } else if (ev?.type === "content_block_start" || ev?.type === "message_stop") {
            o.onBreak?.();
          }
        } else if (j.type === "result") {
          final = String(j.result ?? "");
          if (j.is_error) failed = final || j.subtype || "claude code failed";
        }
      };
      child.stdout?.on("data", (d: Buffer) => {
        out += d.toString("utf8");
        let i = out.indexOf("\n");
        while (i >= 0) {
          line(out.slice(0, i));
          out = out.slice(i + 1);
          i = out.indexOf("\n");
        }
      });
      child.stderr?.on("data", (d: Buffer) => {
        err += d.toString("utf8");
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        line(out);
        for (const f of [systemFile, mcpFile]) {
          try {
            if (f) unlinkSync(f);
          } catch {
            /* a leftover prompt file is harmless */
          }
        }
        this.log(
          `claude code: ${code === 0 && !failed ? "answered" : "failed"} in ${Date.now() - started} ms${first ? `, first word at ${first - started} ms` : ""}`,
        );
        if (failed || (code !== 0 && !final && !text))
          reject(
            new Error(`claude code: ${failed || err.trim().split("\n")[0] || `exit ${code}`}`),
          );
        else resolve(final || text);
      });
      child.stdin?.end(prompt);
    });
  }
}
