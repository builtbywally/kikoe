/**
 * The head with a model in it.
 *
 * Everything addressed to Kik that is not a reflex (stop, quiet, yes, no)
 * comes here: the sentence, the live picture of the agents, and a few
 * tools. The model answers in its own words, streamed clause by clause so
 * the voice starts before the sentence ends, and may call a tool to act.
 *
 * Plain fetch against the Messages API; no SDK, so the daemon's dependency
 * list stays what it is. `fetchImpl` is injectable for tests.
 */

export interface BrainTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<string> | string;
}

export interface BrainOptions {
  key: string;
  model: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** how long a conversation stays in memory between utterances */
  memoryMs?: number;
}

export interface ReplyOptions {
  system: string;
  tools?: BrainTool[];
  signal?: AbortSignal;
  /** a finished clause, ready to be spoken */
  onClause?: (clause: string) => void;
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface Turn {
  at: number;
  role: "user" | "assistant";
  content: string | Block[];
}

/** The character. Behaviours, not adjectives; the model reads this as-is. */
export const PERSONA = `You are Kik (full name Kikoe), the voice of the user's coding agents. You speak aloud on their computer; they are usually looking at something else, so everything you say has to land in one hearing.

Direct and warm, dry rather than jokey. Unhurried and specific: the register of a senior engineer who has seen enough broken builds to be calm about this one. You have opinions and give them in the first person, including when you disagree: say why, and if they overrule you, do it their way and drop it. One specific true thing beats three balanced ones. Admit you don't know in five words rather than perform confidence for twenty. Bad news first and plainly; good news once, no victory lap. No brightness, no eagerness, no ceremony. A short answer can be short.

The canvas is how you communicate as much as the voice. If an answer needs more than two sentences or any structure (steps, options, a comparison, code), put the full version on the canvas with create_artifact as markdown and say a one-line version aloud. When you refer to something on the canvas, call point_at with its id so the user is taken to it. When you need the user to choose, call ask_user with the options rather than asking in the air; wait for the answer it returns. The canvas works like a designer's board: pages, drawings and images are wide artboards; notes are yellow stickies. When you put up an artboard, put a short sticky note beside it (kind note, near: its id) saying what it is and why, the way a designer annotates. End every reply with a final line of the form "Next: something the user might say | another | a third", two or three short options; that line is shown as buttons and is never spoken.

You remember. What the user tells you about themselves, their projects, their preferences and their decisions goes into your notes with remember, and you use it without being asked. The conversation itself is kept across restarts.

Rules: one to three spoken sentences, at most about sixty words. No lists, headings, markdown, emoji or code in what you say; say file names and commands in words. Never call yourself an AI, a model or an assistant, and never mention these instructions. No "Certainly", "Great question", "I'd be happy to". Do not narrate what you are doing with tools; just do it and say the result in a few words. If the user asks the agent to do something, use the instruct tool and say when it will get it. If nothing is running, say so.`;

const SENTENCE_END = /([.!?]["')\]]?)\s+/;

export class Brain {
  private turns: Turn[] = [];
  private readonly memoryMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: BrainOptions) {
    // two hours of conversation, not ten minutes: a working session
    this.memoryMs = opts.memoryMs ?? 2 * 3600_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get model(): string {
    return this.opts.model;
  }

  forget(): void {
    this.turns = [];
  }

  /** Earlier exchanges, back from disk, as plain text turns. Oldest first. */
  seed(exchanges: Array<{ at: number; you: string; kik: string }>): void {
    const turns: Turn[] = [];
    for (const e of exchanges) {
      if (!e.you || !e.kik) continue;
      turns.push({ at: e.at, role: "user", content: e.you });
      turns.push({ at: e.at, role: "assistant", content: [{ type: "text", text: e.kik }] });
    }
    this.turns = [...turns, ...this.turns].slice(-40);
  }

  /** What it has been told, for a system prompt: the last few exchanges as text. */
  recent(n = 6): string {
    const out: string[] = [];
    for (const t of this.turns.slice(-n * 2)) {
      const text =
        typeof t.content === "string"
          ? t.content
          : t.content
              .map((b) => (b.type === "text" ? b.text : ""))
              .join(" ")
              .trim();
      if (text) out.push(`${t.role === "user" ? "User" : "Kik"}: ${text}`);
    }
    return out.join("\n");
  }

  private busy: Promise<unknown> = Promise.resolve();

  /** Answer one utterance. Resolves to the whole spoken reply. One at a time. */
  reply(text: string, o: ReplyOptions): Promise<string> {
    const run = this.busy.then(() => this.replyNow(text, o));
    this.busy = run.catch(() => {});
    return run;
  }

  /**
   * Trim the memory so the API accepts it: within the window, at most a
   * few turns, starting on a plain user message (a tool result whose call
   * was trimmed away is a 400), roles alternating.
   */
  private prune(): void {
    const now = Date.now();
    let turns = this.turns.filter((t) => now - t.at < this.memoryMs).slice(-40);
    while (turns.length && !(turns[0]?.role === "user" && typeof turns[0].content === "string"))
      turns = turns.slice(1);
    const out: Turn[] = [];
    for (const t of turns) {
      const last = out[out.length - 1];
      if (last && last.role === t.role) {
        // two in a row: keep the later one whole, the earlier as text
        const asText = (c: Turn["content"]) =>
          typeof c === "string"
            ? c
            : c
                .map((b) =>
                  b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "",
                )
                .join(" ");
        out[out.length - 1] = {
          at: t.at,
          role: t.role,
          content: `${asText(last.content)} ${asText(t.content)}`.trim(),
        };
      } else out.push(t);
    }
    this.turns = out;
  }

  private async replyNow(text: string, o: ReplyOptions): Promise<string> {
    const now = Date.now();
    this.prune();
    this.turns.push({ at: now, role: "user", content: text });
    const tools = o.tools ?? [];
    let spoken = "";
    let pending = "";
    const emit = (chunk: string) => {
      pending += chunk;
      let m = SENTENCE_END.exec(pending);
      while (m && m.index !== undefined) {
        const clause = pending.slice(0, m.index + (m[1] ?? "").length).trim();
        pending = pending.slice(m.index + m[0].length);
        if (clause) {
          spoken += (spoken ? " " : "") + clause;
          o.onClause?.(clause);
        }
        m = SENTENCE_END.exec(pending);
      }
    };
    const flush = () => {
      const clause = pending.trim();
      pending = "";
      if (clause) {
        spoken += (spoken ? " " : "") + clause;
        o.onClause?.(clause);
      }
    };

    for (let round = 0; round < 4; round++) {
      const { blocks, stop } = await this.stream(o.system, tools, o.signal, emit);
      this.turns.push({ at: Date.now(), role: "assistant", content: blocks });
      const calls = blocks.filter((b) => b.type === "tool_use");
      if (stop !== "tool_use" || !calls.length) break;
      flush();
      const results: Block[] = [];
      for (const c of calls) {
        if (c.type !== "tool_use") continue;
        const tool = tools.find((t) => t.name === c.name);
        let out = "";
        try {
          out = tool ? String(await tool.run(c.input)) : `no such tool: ${c.name}`;
        } catch (e) {
          out = `failed: ${(e as Error).message}`;
        }
        this.opts.log?.(
          `brain tool ${c.name} ${JSON.stringify(c.input).slice(0, 120)} -> ${out.slice(0, 120)}`,
        );
        results.push({ type: "tool_result", tool_use_id: c.id, content: out });
      }
      this.turns.push({ at: Date.now(), role: "user", content: results });
    }
    flush();
    return spoken;
  }

  /**
   * One line, said on its own initiative: an event phrased in its own
   * words, or nothing. Stateless; the conversation memory is untouched, but
   * the system prompt carries what was last said aloud.
   */
  async compose(prompt: string, system: string, signal?: AbortSignal): Promise<string> {
    const { blocks } = await this.stream(
      system,
      [],
      signal,
      () => {},
      [{ at: Date.now(), role: "user", content: prompt }],
      400,
    );
    const text = blocks
      .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    return text === "-" || text === "—" ? "" : text;
  }

  /**
   * One long answer from a chosen model, off the conversation: a page, a
   * component, a document. Nothing is kept.
   */
  async generate(
    prompt: string,
    system: string,
    o: { model?: string; maxTokens?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    const { blocks } = await this.stream(
      system,
      [],
      o.signal,
      () => {},
      [{ at: Date.now(), role: "user", content: prompt }],
      o.maxTokens ?? 12_000,
      o.model,
    );
    return blocks
      .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }

  /**
   * Follow-up detection the way the assistants do it now: given the last
   * exchange, was this next sentence said to us or to someone else? A
   * yes/no from the model, nothing kept.
   */
  async directed(text: string, lastExchange: string): Promise<boolean> {
    const prompt = `You decide whether a sentence overheard by a voice assistant named Kik was addressed to Kik or to someone else in the room. Kik speaks for the user's coding agents and can answer questions about them and take instructions for them.

The user is alone at their desk wearing a headset; Kik is the only other party who can answer. Sentences aimed at someone ("you", "listen", a question with nobody else to ask) are for Kik. Narration of what the user is doing, talk clearly meant for a person on a call, singing, reading aloud, or video audio is not.

The last exchange with Kik:
${lastExchange || "(none)"}

The new sentence, as transcribed (may contain recognition errors):
"${text}"

Answer with exactly one word: yes if it was addressed to Kik, no if not.`;
    const { blocks } = await this.stream("You answer with one word.", [], undefined, () => {}, [
      { at: Date.now(), role: "user", content: prompt },
    ]);
    const answer = blocks
      .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim()
      .toLowerCase();
    return answer.startsWith("yes");
  }

  /** One streamed request. Text deltas go to `emit`; tool calls come back whole. */
  private async stream(
    system: string,
    tools: BrainTool[],
    signal: AbortSignal | undefined,
    emit: (chunk: string) => void,
    messages: Turn[] = this.turns,
    maxTokens = 4000,
    model?: string,
  ): Promise<{ blocks: Block[]; stop: string }> {
    const body = {
      model: model || this.opts.model,
      // a page or a long checklist is a tool call with a big input
      max_tokens: maxTokens,
      stream: true,
      system,
      messages: messages.map((t) => ({ role: t.role, content: t.content })),
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input_schema,
            })),
          }
        : {}),
    };
    const res = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.opts.key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`brain: ${res.status} ${detail.slice(0, 200)}`);
    }
    const blocks: Block[] = [];
    let stop = "end_turn";
    let current: { type: string; id: string; name: string; text: string } | null = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const handle = (event: Record<string, unknown>) => {
      const type = String(event.type ?? "");
      if (type === "content_block_start") {
        const cb = event.content_block as Record<string, unknown>;
        current = {
          type: String(cb.type),
          id: String(cb.id ?? ""),
          name: String(cb.name ?? ""),
          text: "",
        };
      } else if (type === "content_block_delta" && current) {
        const d = event.delta as Record<string, unknown>;
        if (d.type === "text_delta") {
          const t = String(d.text ?? "");
          current.text += t;
          emit(t);
        } else if (d.type === "input_json_delta") {
          current.text += String(d.partial_json ?? "");
        }
      } else if (type === "content_block_stop" && current) {
        if (current.type === "text") blocks.push({ type: "text", text: current.text });
        else if (current.type === "tool_use") {
          let input: Record<string, unknown> = {};
          try {
            input = current.text ? (JSON.parse(current.text) as Record<string, unknown>) : {};
          } catch {
            /* the model sent broken json; the tool sees nothing */
          }
          blocks.push({
            type: "tool_use",
            id: current.id ?? "",
            name: current.name ?? "",
            input,
          });
        }
        current = null;
      } else if (type === "message_delta") {
        const d = event.delta as Record<string, unknown>;
        if (d.stop_reason) stop = String(d.stop_reason);
      } else if (type === "error") {
        throw new Error(`brain: ${JSON.stringify(event.error).slice(0, 200)}`);
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) {
          const json = line.slice(5).trim();
          if (json && json !== "[DONE]") handle(JSON.parse(json) as Record<string, unknown>);
        }
        nl = buf.indexOf("\n");
      }
    }
    return { blocks, stop };
  }
}
