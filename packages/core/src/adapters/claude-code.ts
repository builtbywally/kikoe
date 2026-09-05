/**
 * Claude Code adapter.
 *
 * Claude Code owns its own session, so we attach rather than drive: hooks
 * fire short-lived processes that POST the hook payload to the daemon, and
 * this adapter translates those payloads into AgentEvents.
 *
 * Hook payload shapes vary between Claude Code versions, so every field
 * lookup here is defensive. A schema change should degrade narration, never
 * crash the agent. `hook_event_name` is the only field we truly rely on.
 */

import * as ev from "../events.js";

type Payload = Record<string, any>;

/**
 * hook_event_name -> our kind.
 *
 * Claude Code emits far more events than are worth a sound. The ones absent
 * here are absent deliberately: MessageDisplay fires per rendered message,
 * PostToolBatch duplicates PostToolUse, and the config/cwd/file-watch events
 * describe the harness rather than the work.
 */
export const HOOK_KINDS: Readonly<Record<string, ev.Kind>> = {
  SessionStart: ev.SESSION_START,
  SessionEnd: ev.SESSION_END,
  UserPromptSubmit: ev.TURN_START,
  PreToolUse: ev.TOOL_START,
  PostToolUse: ev.TOOL_END,
  // A tool that raised. The narrator lifts an errored tool_end to milestone,
  // so this needs no severity of its own.
  PostToolUseFailure: ev.TOOL_END,
  Notification: ev.NOTIFICATION,
  // The explicit permission events, far better than sniffing prose.
  PermissionRequest: ev.PERMISSION,
  PermissionDenied: ev.TOOL_END,
  Elicitation: ev.PERMISSION,
  Stop: ev.TURN_END,
  // The turn died rather than finished.
  StopFailure: ev.ERROR,
  SubagentStart: ev.TOOL_START,
  SubagentStop: ev.TOOL_END,
  // Background tasks: the "long wait ended after you stopped watching" case.
  TaskCreated: ev.TOOL_START,
  TaskCompleted: ev.TOOL_END,
  PreCompact: ev.IDLE,
  PostCompact: ev.IDLE,
};

/** Hooks whose work is a delegated task rather than a named tool. */
const TASK_HOOKS: ReadonlySet<string> = new Set([
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
]);

/** Notification bodies that really mean "a human must decide something". */
const PERMISSION_HINTS = [
  "permission",
  "approve",
  "approval",
  "allow",
  "confirm",
  "wants to",
  "needs your",
  "waiting for your",
];
const IDLE_HINTS = ["waiting for your input", "is idle", "idle for"];

export const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT = 4000;

/** tool_response / content can be a string, an object, or a list of blocks. */
export function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((v) => asText(v))
      .filter((t) => t)
      .join(" ");
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    for (const k of ["text", "content", "output", "stdout", "result", "message"]) {
      if (o[k]) return asText(o[k]);
    }
    return "";
  }
  return String(value);
}

/**
 * Walk a Claude Code JSONL transcript backwards for the last reply.
 * Tolerant by design: unknown record shapes are skipped, not fatal.
 */
export function lastAssistantText(contents: string): string {
  const lines = contents.split(/\r?\n/);
  const tail = lines.slice(-400);
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = (tail[i] ?? "").trim();
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    if (rec.type !== undefined && rec.type !== null && !["assistant", "message"].includes(rec.type))
      continue;
    const msg = rec.message ?? rec;
    if (msg.role !== undefined && msg.role !== null && msg.role !== "assistant") continue;
    const content = msg.content;
    let text = "";
    if (Array.isArray(content)) {
      text = content
        .filter((b) => b && typeof b === "object" && b.type === "text")
        .map((b) => String(b.text ?? ""))
        .filter((t) => t)
        .join(" ")
        .trim();
    } else if (typeof content === "string") {
      text = content.trim();
    }
    if (text) return text.slice(0, MAX_TEXT);
  }
  return "";
}

export interface ClaudeCodeAdapterOptions {
  /** default cwd when the payload has none */
  cwd?: string;
  /**
   * Core has no filesystem. The daemon supplies a reader so Stop payloads
   * without `last_assistant_message` can fall back to the transcript.
   * Return undefined for missing, unreadable, or oversized files.
   */
  readTranscript?: (path: string) => string | undefined;
  now?: ev.Clock;
}

export class ClaudeCodeAdapter {
  static readonly name = "claude_code";
  readonly name = ClaudeCodeAdapter.name;
  /** PUSH: the agent runs the show and notifies us. */
  readonly shape = "push" as const;
  private readonly cwd: string;
  private readonly readTranscript: (path: string) => string | undefined;
  private readonly now: ev.Clock;

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.cwd = opts.cwd ?? "";
    this.readTranscript = opts.readTranscript ?? (() => undefined);
    this.now = opts.now ?? ev.wallClock;
  }

  private transcriptText(path: string): string {
    if (!path) return "";
    const contents = this.readTranscript(path);
    return contents ? lastAssistantText(contents) : "";
  }

  /** Raw Claude Code hook JSON -> AgentEvent, or null if not worth it. */
  ingestHook(payloadIn: Payload | null | undefined): ev.AgentEvent | null {
    const payload: Payload = payloadIn ?? {};
    const hook: string = payload.hook_event_name ?? payload.hook ?? "";
    let kind = HOOK_KINDS[hook];
    if (kind === undefined) return null;

    const cwd: string = payload.cwd || this.cwd || "";
    const session = String(payload.session_id ?? payload.sessionId ?? "");
    const transcript: string = payload.transcript_path ?? payload.transcriptPath ?? "";

    let text = "";
    let tool = "";
    let args: Record<string, unknown> = {};
    let status = "";
    let severity = -1;

    if (kind === ev.TOOL_START || kind === ev.TOOL_END) {
      tool = payload.tool_name ?? payload.toolName ?? "";
      const rawArgs = payload.tool_input ?? payload.toolInput ?? {};
      args =
        rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? rawArgs
          : { input: asText(rawArgs) };
      if (kind === ev.TOOL_END) {
        const resp = payload.tool_response ?? payload.toolResponse;
        text = asText(resp).slice(0, MAX_TEXT);
        if (resp && typeof resp === "object" && !Array.isArray(resp)) {
          status = resp.is_error || resp.error ? "error" : "ok";
        } else if (text) {
          status = "ok";
        }
      }
      if (hook === "PostToolUseFailure") {
        // Fires only on failure, so trust it over the response's shape.
        status = "error";
        text = asText(payload.error) || text;
      } else if (hook === "PermissionDenied") {
        // They just said no. Telling them so is narrating what they know.
        status = "denied";
        severity = ev.SEV_DEBUG;
      }
      if (TASK_HOOKS.has(hook)) {
        // Always "Task", never the agent type: the tool name is the
        // narrator's contract for recognising delegated work.
        const agentType = String(payload.agent_type ?? "").trim();
        if (agentType) args = { ...args, subagent_type: agentType };
        tool = tool || "Task";
        if (kind === ev.TOOL_END) {
          status = status || "ok";
          if (hook === "TaskCompleted" && severity < 0) severity = ev.SEV_MILESTONE;
          text = text || asText(payload.last_assistant_message);
        }
      }
    } else if (kind === ev.PERMISSION) {
      tool = payload.tool_name ?? payload.toolName ?? "";
      const rawArgs = payload.tool_input ?? payload.toolInput ?? {};
      args =
        rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? rawArgs
          : { input: asText(rawArgs) };
      text = asText(payload.message ?? payload.reason).slice(0, MAX_TEXT);
      status = "pending";
    } else if (kind === ev.ERROR) {
      text = (
        asText(payload.error) ||
        asText(payload.message) ||
        asText(payload.last_assistant_message) ||
        this.transcriptText(transcript)
      ).slice(0, MAX_TEXT);
    } else if (kind === ev.NOTIFICATION) {
      text = asText(payload.message ?? payload.body);
      const low = text.toLowerCase();
      // Idle is checked first: "waiting for your input" also matches the
      // broader permission hints, but it means nothing is blocked.
      if (IDLE_HINTS.some((h) => low.includes(h))) {
        kind = ev.IDLE;
      } else if (PERMISSION_HINTS.some((h) => low.includes(h))) {
        kind = ev.PERMISSION;
        tool = payload.tool_name ?? "";
      }
    } else if (kind === ev.TURN_START) {
      text = asText(payload.prompt).slice(0, MAX_TEXT);
    } else if (kind === ev.TURN_END) {
      // Stop carries the reply itself. Prefer it; keep the transcript walk
      // for older versions and payloads that omit the field.
      text = (asText(payload.last_assistant_message) || this.transcriptText(transcript)).slice(
        0,
        MAX_TEXT,
      );
      if (payload.stop_hook_active) severity = ev.SEV_DEBUG; // re-entrant Stop
    } else if (kind === ev.IDLE) {
      severity = ev.SEV_DEBUG; // compaction is housekeeping
    }

    return ev.make(
      {
        kind,
        source: this.name,
        session: session || "claude_code:" + ev.basename(cwd),
        cwd,
        text,
        tool,
        args,
        status,
        severity,
        meta: { hook, transcript },
      },
      this.now,
    );
  }
}
