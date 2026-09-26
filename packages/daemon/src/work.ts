/**
 * The work feed: what the agent did, on the canvas.
 *
 * Kikoe has always been able to *say* what an agent is doing. This is the
 * other half — showing it. Claude Code hands us the whole hook payload, and
 * inside a PostToolUse for an edit is `structuredPatch`, a finished diff we
 * computed nothing to get. Until now it was dropped one line into the adapter
 * because the flattener that feeds the voice has no key for it.
 *
 * So: an edit becomes a diff card, a command becomes a run card, a test run
 * becomes a result card, and the end of a turn becomes the agent's reply. Each
 * belongs to a turn, and a turn's cards sit together through `near`, which the
 * canvas already understands.
 *
 * Two rules this file exists to keep:
 *
 *  - **Not everything is worth a card.** An agent greps and lists constantly.
 *    A card for each would be a log, and a log is what we are getting away
 *    from. Only work a person would look up for.
 *  - **Never on the hook's critical path.** Hooks are subprocesses in front of
 *    the agent with a three second budget; this runs after the ack.
 */

import type { AgentEvent, Hunk, ToolResult } from "@kikoe/core";
import { events as ev, summarizeCommand, summarizeTestOutput } from "@kikoe/core";
import type { Board, Pin } from "./pins.js";

/** Tools whose result is a change to a file. */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "apply_patch",
  "str_replace",
  "str_replace_editor",
]);

/** Tools that run something. */
const SHELL_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "shell",
  "powershell",
  "run",
  "exec",
  "terminal",
]);

/** How much of a command's output a card carries. */
export const MAX_OUTPUT_LINES = 400;
/** A reply longer than this is a document, not a line; the card scrolls. */
export const MAX_REPLY = 20_000;
/** A diff card that keeps growing through a turn stops growing here. */
export const MAX_DIFF = 60_000;

export interface WorkOptions {
  board: Board;
  /** whose board this event's work belongs on */
  projectOf?: (e: AgentEvent) => string;
  /** told when a card is worth pulling the canvas to */
  focus?: (id: string) => void;
  log?: (line: string) => void;
  /** a turn whose reply Kik shows another way (a plan, on its own card) */
  quietReply?: (e: AgentEvent) => boolean;
}

interface TurnState {
  /** counts up per session; the unit the feed is evicted by */
  n: number;
  /** the first card of this turn: everything else sits beside it */
  anchor: string;
  /** file -> the diff card already showing it, so a refactor is one card */
  files: Map<string, { id: string; added: number; removed: number }>;
}

/**
 * One unified-diff body from the hunks Claude Code already computed.
 *
 * The card renders `+` and `-` itself, so this is plain text with the hunk
 * headers kept — without `@@` you cannot tell a change at line 20 from the
 * same change at line 900, and that is usually the whole question.
 */
export function patchToDiff(patch: Hunk[], file: string): string {
  const lines: string[] = [];
  if (file) {
    lines.push(`--- a/${file}`);
    lines.push(`+++ b/${file}`);
  }
  for (const h of patch) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) lines.push(l);
  }
  return lines.join("\n");
}

/** How many lines a patch adds and removes, for the card's title. */
export function patchCounts(patch: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of patch) {
    for (const l of h.lines) {
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

/** The tail of a long output: the end is where the answer usually is. */
export function tail(text: string, lines = MAX_OUTPUT_LINES): string {
  const all = text.split("\n");
  if (all.length <= lines) return text;
  return `… ${all.length - lines} earlier lines\n${all.slice(-lines).join("\n")}`;
}

/** Just the file's name, for a title that fits. */
function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/** The first line of a command, so a heredoc does not become the title. */
function firstLine(cmd: string): string {
  const line = cmd.split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * Is this command worth a card?
 *
 * Yes if it failed — a failure is always worth seeing. Yes if the narrator
 * recognises it as work with a result: tests, a build, an install, a commit,
 * a deploy. No to the rest, which is the greps and the file lists that make a
 * feed into a log.
 */
export function worthShowing(cmd: string, failed: boolean): boolean {
  if (failed) return true;
  const phrase = summarizeCommand(cmd);
  if (!phrase) return false;
  return !phrase.startsWith("running ") || /\btests\b/.test(phrase);
}

export class Work {
  private readonly board: Board;
  private readonly projectOf: (e: AgentEvent) => string;
  private readonly focus: (id: string) => void;
  private readonly log: (line: string) => void;
  /** session -> where we are in it */
  private turns = new Map<string, TurnState>();

  constructor(o: WorkOptions) {
    this.board = o.board;
    this.projectOf = o.projectOf ?? ((e) => e.repo);
    this.focus = o.focus ?? (() => {});
    this.log = o.log ?? (() => {});
    this.quietReply = o.quietReply ?? (() => false);
  }
  private quietReply: (e: AgentEvent) => boolean;

  /** Where a session's cards are grouped; starts a turn if none is open. */
  private turn(session: string): TurnState {
    let t = this.turns.get(session);
    if (!t) {
      t = { n: 1, anchor: "", files: new Map() };
      this.turns.set(session, t);
    }
    return t;
  }

  private card(e: AgentEvent, init: { kind: Pin["kind"]; title: string; body: string }): Pin {
    const t = this.turn(e.session);
    const pin = this.board.add({
      kind: init.kind,
      title: init.title,
      body: init.body,
      project: this.projectOf(e),
      repo: e.repo,
      session: e.session,
      stream: "work",
      turn: t.n,
      by: "agent",
      // The first card of a turn anchors it; the rest sit beside it, which is
      // placement the canvas already does for a sticky beside an artboard.
      near: t.anchor,
      size: init.kind === "diff" ? "wide" : "normal",
    });
    if (!t.anchor) t.anchor = pin.id;
    return pin;
  }

  /**
   * One event in. Called after the hook has been answered, never before.
   * Anything unrecognised is simply not shown; this must never throw into
   * the ingest path.
   */
  ingest(e: AgentEvent): void {
    try {
      this.route(e);
    } catch (err) {
      this.log(`work card failed: ${(err as Error).message}`);
    }
  }

  private route(e: AgentEvent): void {
    if (e.kind === ev.TURN_START) {
      // A new turn: close the old group so the next card starts a fresh one.
      const t = this.turn(e.session);
      t.n += 1;
      t.anchor = "";
      t.files.clear();
      return;
    }
    if (e.kind === ev.TURN_END) {
      this.reply(e);
      return;
    }
    if (e.kind === ev.TOOL_END) this.toolEnd(e);
  }

  /** What the agent said at the end of a turn, whole rather than in a snippet. */
  private reply(e: AgentEvent): void {
    const text = (e.text ?? "").trim();
    if (!text || this.quietReply(e)) return;
    const pin = this.card(e, {
      kind: "markdown",
      title: "Kik's agent replied",
      body: text.slice(0, MAX_REPLY),
    });
    this.focus(pin.id);
  }

  private toolEnd(e: AgentEvent): void {
    const tool = (e.tool ?? "").toLowerCase();
    const r: ToolResult = e.result ?? {};
    if (EDIT_TOOLS.has(tool)) this.edit(e, r);
    else if (SHELL_TOOLS.has(tool)) this.ran(e, r);
  }

  /**
   * A change to a file, as the diff Claude Code already computed.
   *
   * An agent editing one file five times in a turn is one change to a person,
   * so it is one card that grows. Without this a single refactor turn buries
   * the canvas in near-identical cards, which is the junk drawer the board
   * has always been designed against.
   */
  private edit(e: AgentEvent, r: ToolResult): void {
    const patch = r.structuredPatch;
    if (!patch?.length) return;
    const file = r.filePath || String(e.args?.file_path ?? "");
    const { added, removed } = patchCounts(patch);
    const t = this.turn(e.session);
    const seen = t.files.get(file);

    if (seen) {
      const total = { added: seen.added + added, removed: seen.removed + removed };
      const before = this.board.get(seen.id);
      if (before) {
        this.board.update(seen.id, {
          title: this.diffTitle(file, total.added, total.removed),
          body: `${before.body}\n${patchToDiff(patch, "")}`.slice(0, MAX_DIFF),
        });
        t.files.set(file, { id: seen.id, ...total });
        this.log(
          `work diff ${seen.id} ${baseName(file)} grew to +${total.added} -${total.removed}`,
        );
        return;
      }
      // The card was evicted under us; fall through and make a new one.
      t.files.delete(file);
    }

    const pin = this.card(e, {
      kind: "diff",
      title: this.diffTitle(file, added, removed),
      body: patchToDiff(patch, file),
    });
    t.files.set(file, { id: pin.id, added, removed });
    this.log(`work diff ${pin.id} ${baseName(file)} +${added} -${removed}`);
  }

  private diffTitle(file: string, added: number, removed: number): string {
    return `${baseName(file)}  +${added} −${removed}`;
  }

  /** A command that ran: its output, or its verdict if it was a test run. */
  private ran(e: AgentEvent, r: ToolResult): void {
    const cmd = String(e.args?.command ?? "").trim();
    const failed = e.status === "error" || Boolean(r.stderr);
    if (!cmd || !worthShowing(cmd, failed)) return;

    const stdout = r.stdout ?? e.text ?? "";
    const verdict = summarizeTestOutput(stdout) || summarizeTestOutput(r.stderr ?? "");

    // A test run has an answer, so it gets an answer for a title and the tail
    // of the output for the detail. Everything else is just what it printed.
    const body = [
      `$ ${cmd}`,
      "",
      tail(stdout).trimEnd(),
      r.stderr ? `\n--- stderr ---\n${tail(r.stderr).trimEnd()}` : "",
    ]
      .join("\n")
      .trimEnd();

    const pin = this.card(e, {
      kind: verdict ? "result" : "run",
      title: verdict || firstLine(cmd),
      body,
    });
    // A failure is the one thing worth taking the canvas to on its own.
    if (failed) this.focus(pin.id);
    this.log(`work ${pin.kind} ${pin.id} ${firstLine(cmd)}${failed ? " (failed)" : ""}`);
  }

  /** A session ended: forget where its turns were. */
  forget(session: string): void {
    this.turns.delete(session);
  }
}
