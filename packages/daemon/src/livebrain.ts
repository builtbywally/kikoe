/**
 * The talking session: one Claude Code process kept running, thinking
 * switched off, fed each thing the user says on stdin.
 *
 * Measured 2026-09-23: a fresh `claude -p` per thought is ~7 s to the first
 * word with Kik's prompt; one session kept open answers its first message in
 * ~1.4 s and every one after in ~0.5 s — faster than the API. Starting up was
 * the wait, not thinking.
 *
 * The user's own design: the talking session does not think. Anything that
 * needs real thought it hands to a separate thinking session (the
 * think_deeply tool), says it will come back, and keeps the conversation
 * going; the daemon speaks the thought when it lands.
 *
 * The persona is the session's system prompt, fixed at start. The live
 * picture (agents, canvas, notes) changes every utterance, so it rides on
 * each message instead. Kik's tools stay served for the life of the session.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { BrainTool, ReplyOptions } from "./brain.js";
import {
  CodeBrain,
  type CodeBrainOptions,
  REPLY_TIMEOUT_MS,
  SENTENCE_END,
  type StreamLine,
  ToolServer,
  codeArgs,
} from "./codebrain.js";

/** How many messages one session takes before it is started fresh. */
export const LIVE_TURNS = 30;
/** A session nobody has spoken to for this long is let go. */
export const LIVE_IDLE_MS = 20 * 60_000;

/** What the talking session is told about itself, after the persona. */
export const LIVE_RULES = `Each message from the user starts with the live picture — the agents, the canvas, your notes — as it is at that moment; it replaces any picture before it.

Your tools are the kik server's. You do not think at length here. When something needs real thought — a design question, a hard bug, a plan, a comparison, anything you would want to reason about before answering — call think_deeply with the question and what you know, tell the user in a few words that you are on it and will come back, and carry on the conversation. The answer is spoken when it lands.

Lines in square brackets before the user's words are things you already said aloud, or that came back from your thinking, since the last message. They are yours; own them.`;

export class LiveBrain extends CodeBrain {
  /** fast enough that a filler is rarely needed */
  readonly fast = true;
  private child: ChildProcess | null = null;
  private server: ToolServer | null = null;
  private turnsHere = 0;
  private lastUsed = 0;
  private idle: NodeJS.Timeout | null = null;
  /** the reader of the current turn; lines go here while a reply is running */
  private onLine: ((l: StreamLine) => void) | null = null;

  constructor(
    code: CodeBrainOptions,
    /** the part of the system prompt that does not change */
    private readonly persona: string,
  ) {
    super(code);
  }

  /** Is a session running right now? */
  get open(): boolean {
    return this.child !== null;
  }

  /** Start the session before the first word, so the first answer is warm too. */
  async warm(tools: BrainTool[]): Promise<void> {
    if (!this.child) await this.start(tools);
  }

  override reply(text: string, o: ReplyOptions): Promise<string> {
    const run = this.queue.then(() => this.talk(text, o));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Let the process go: on idle, after many turns, or on close. */
  close(): void {
    this.onLine = null;
    const child = this.child;
    this.child = null;
    child?.kill();
    void this.server?.stop();
    this.server = null;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  private async start(tools: BrainTool[]): Promise<void> {
    this.close();
    this.server = new ToolServer(tools, this.log);
    await this.server.start();
    const mcpFile = this.file("live-mcp.json");
    writeFileSync(mcpFile, JSON.stringify(this.server.config()));
    const systemFile = this.file("live-system.md");
    writeFileSync(systemFile, `${this.persona}\n\n${LIVE_RULES}`);
    const args = codeArgs({
      model: this.code.model,
      systemFile,
      settingsFile: this.file("settings.json"),
      mcpFile,
    });
    // a conversation that stays open: messages in on stdin, one after another
    args.splice(args.indexOf("--output-format"), 0, "--input-format", "stream-json");
    const child = (this.code.spawnImpl ?? spawn)(this.code.bin, args, {
      cwd: this.code.dir,
      windowsHide: true,
      shell: /\.(cmd|bat)$/i.test(this.code.bin),
      stdio: ["pipe", "pipe", "pipe"],
      // the talking session does not think; that is the thinking session's job
      env: { ...process.env, MAX_THINKING_TOKENS: "0" },
    });
    this.child = child;
    this.turnsHere = 0;
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      let i = out.indexOf("\n");
      while (i >= 0) {
        const l = out.slice(0, i);
        out = out.slice(i + 1);
        i = out.indexOf("\n");
        if (!l.trim()) continue;
        let j: StreamLine;
        try {
          j = JSON.parse(l);
        } catch {
          continue;
        }
        this.onLine?.(j);
      }
    });
    child.stderr?.on("data", () => {});
    const gone = () => {
      if (this.child !== child) return;
      this.child = null;
      this.log("claude code: the talking session ended");
      // a reply in flight learns it will not finish
      this.onLine?.({ type: "result", is_error: true, result: "the talking session ended" });
    };
    child.on("exit", gone);
    child.on("error", gone);
    this.log(`claude code: talking session open (${this.code.model}, thinking off)`);
  }

  private async talk(text: string, o: ReplyOptions): Promise<string> {
    if (
      !this.child ||
      this.turnsHere >= LIVE_TURNS ||
      (this.lastUsed && Date.now() - this.lastUsed > LIVE_IDLE_MS)
    )
      await this.start(o.tools ?? []);
    const child = this.child;
    if (!child?.stdin) throw new Error("claude code: no talking session");
    this.turnsHere++;
    this.lastUsed = Date.now();
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), LIVE_IDLE_MS);
    this.idle.unref?.();

    // The picture is the system prompt minus the persona the session already
    // has: everything after it changes from one utterance to the next.
    const picture = o.system.startsWith(this.persona)
      ? o.system.slice(this.persona.length).trim()
      : o.system;
    const asides = (o.asides ?? []).map((a) => `[${a}]`).join("\n");
    const content = `${picture}\n\n${asides ? `${asides}\n` : ""}The user just said: "${text}"`;
    const started = Date.now();
    let spoken = "";
    let pending = "";
    let first = 0;
    const say = (clause: string) => {
      const c = clause.trim();
      if (!c) return;
      spoken += (spoken ? " " : "") + c;
      o.onClause?.(c);
    };
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onLine = null;
        this.close();
        reject(new Error("claude code: no answer in time"));
      }, REPLY_TIMEOUT_MS);
      this.onLine = (j) => {
        if (j.type === "stream_event") {
          const ev = j.event;
          if (
            ev?.type === "content_block_delta" &&
            ev.delta?.type === "text_delta" &&
            ev.delta.text
          ) {
            if (!first) first = Date.now();
            pending += ev.delta.text;
            let m = SENTENCE_END.exec(pending);
            while (m && m.index !== undefined) {
              say(pending.slice(0, m.index + (m[1] ?? "").length));
              pending = pending.slice(m.index + m[0].length);
              m = SENTENCE_END.exec(pending);
            }
          } else if (ev?.type === "content_block_start" || ev?.type === "message_stop") {
            // a tool call, or the end of a message: say what was waiting
            say(pending);
            pending = "";
          }
        } else if (j.type === "result") {
          clearTimeout(timer);
          this.onLine = null;
          if (j.is_error) reject(new Error(`claude code: ${j.result || j.subtype || "failed"}`));
          else resolve();
        }
      };
    });
    child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
    await done;
    say(pending);
    this.log(
      `claude code: answered in ${Date.now() - started} ms${first ? `, first word at ${first - started} ms` : ""} (warm, turn ${this.turnsHere})`,
    );
    this.history.push({ at: Date.now(), you: text, kik: spoken });
    this.history = this.history.slice(-20);
    return spoken;
  }
}
