/**
 * Tracker: per-session live state derived from the event stream.
 *
 * A status board, not a second copy of the agent's context: status, current
 * tool, files touched, test results, errors, what it is blocked on, how long
 * it has been going. Bounded, no transcripts, no file contents. Stale
 * sessions evict after fifteen minutes.
 */

import * as ev from "./events.js";
import { summarizeTestOutput } from "./narrator.js";

export const IDLE = "idle";
export const WORKING = "working";
/** blocked on a human */
export const WAITING = "waiting";
export const FAILED = "failed";
export type Status = typeof IDLE | typeof WORKING | typeof WAITING | typeof FAILED;

export const EVICT_AFTER_S = 15 * 60;
export const WORKING_STALE_S = 120;
const MAX_FILES = 12;
const MAX_ERRORS = 5;

export interface Session {
  id: string;
  source: string;
  repo: string;
  cwd: string;
  status: Status;
  currentTool: string;
  toolStartedAt: number;
  turnStartedAt: number;
  lastEventAt: number;
  filesTouched: string[];
  lastTestResult: string;
  pendingPermission: string;
  pendingPermissionId: string;
  lastError: string;
  errors: string[];
  turns: number;
  lastReply: string;
}

export interface SessionSnapshot {
  id: string;
  source: string;
  repo: string;
  label: string;
  status: Status;
  current_tool: string;
  running_for_s: number;
  quiet_for_s: number;
  files_touched: string[];
  last_test_result: string;
  pending_permission: string;
  pending_permission_id: string;
  last_error: string;
  turns: number;
  last_reply: string;
}

function pathArg(e: ev.AgentEvent): string {
  const a = e.args ?? {};
  for (const k of ["file_path", "filePath", "path", "filename", "file"]) {
    if (a[k]) return String(a[k]);
  }
  return "";
}

function cmdArg(e: ev.AgentEvent): string {
  const a = e.args ?? {};
  for (const k of ["command", "cmd", "script"]) {
    if (a[k]) return String(a[k]);
  }
  return "";
}

export class Tracker {
  readonly sessions = new Map<string, Session>();
  private readonly now: ev.Clock;

  constructor(now: ev.Clock = ev.wallClock) {
    this.now = now;
  }

  private get(e: ev.AgentEvent): Session {
    let s = this.sessions.get(e.session);
    if (!s) {
      s = {
        id: e.session,
        source: e.source,
        repo: e.repo,
        cwd: e.cwd,
        status: IDLE,
        currentTool: "",
        toolStartedAt: 0,
        turnStartedAt: 0,
        lastEventAt: this.now(),
        filesTouched: [],
        lastTestResult: "",
        pendingPermission: "",
        pendingPermissionId: "",
        lastError: "",
        errors: [],
        turns: 0,
        lastReply: "",
      };
      this.sessions.set(e.session, s);
    }
    if (e.repo && !s.repo) s.repo = e.repo;
    if (e.cwd && !s.cwd) s.cwd = e.cwd;
    return s;
  }

  apply(e: ev.AgentEvent): Session {
    const s = this.get(e);
    const now = this.now();
    s.lastEventAt = now;
    switch (e.kind) {
      case ev.SESSION_START:
        s.status = IDLE;
        break;
      case ev.SESSION_END:
        s.status = IDLE;
        s.currentTool = "";
        s.turnStartedAt = 0;
        break;
      case ev.TURN_START:
        s.status = WORKING;
        s.turnStartedAt = now;
        s.pendingPermission = "";
        s.pendingPermissionId = "";
        break;
      case ev.TURN_END:
        s.status = IDLE;
        s.currentTool = "";
        s.turnStartedAt = 0;
        s.pendingPermission = "";
        s.pendingPermissionId = "";
        s.turns += 1;
        if (e.text) s.lastReply = e.text.slice(0, 400);
        break;
      case ev.TEXT:
        if (e.text) s.lastReply = e.text.slice(0, 400);
        break;
      case ev.TOOL_START: {
        s.status = WORKING;
        s.currentTool = e.tool ?? "";
        s.toolStartedAt = now;
        if (!s.turnStartedAt) s.turnStartedAt = now;
        s.pendingPermission = "";
        s.pendingPermissionId = "";
        const p = pathArg(e);
        if (p && !s.filesTouched.includes(p)) {
          s.filesTouched.push(p);
          if (s.filesTouched.length > MAX_FILES) s.filesTouched.shift();
        }
        break;
      }
      case ev.TOOL_END: {
        s.currentTool = "";
        if (s.status === WAITING) s.status = WORKING;
        if (e.status === "error") {
          s.lastError = (e.text ?? "").trim().slice(0, 300);
          s.errors.push(s.lastError);
          if (s.errors.length > MAX_ERRORS) s.errors.shift();
        }
        const verdict = summarizeTestOutput(e.text ?? "");
        if (verdict && (cmdArg(e) || /test/i.test(e.text ?? ""))) s.lastTestResult = verdict;
        break;
      }
      case ev.PERMISSION:
        s.status = WAITING;
        s.pendingPermission = (e.text || describe(e) || "a tool call").slice(0, 300);
        s.pendingPermissionId = e.id;
        break;
      case ev.NOTIFICATION:
      case ev.IDLE:
        if (e.severity >= ev.SEV_ATTENTION) s.status = WAITING;
        break;
      case ev.ERROR:
        s.status = FAILED;
        s.currentTool = "";
        s.lastError = (e.text ?? "").trim().slice(0, 300);
        s.errors.push(s.lastError);
        if (s.errors.length > MAX_ERRORS) s.errors.shift();
        break;
    }
    this.evict(now);
    return s;
  }

  /** Forget sessions nobody has heard from in a while. */
  evict(now: number = this.now()): void {
    for (const [id, s] of this.sessions) {
      if (now - s.lastEventAt > EVICT_AFTER_S) this.sessions.delete(id);
    }
  }

  snapshotOf(s: Session, now: number = this.now()): SessionSnapshot {
    const quiet = Math.max(0, now - s.lastEventAt);
    // A "working" session that has gone quiet for minutes is not working.
    const status: Status = s.status === WORKING && quiet > WORKING_STALE_S ? IDLE : s.status;
    return {
      id: s.id,
      source: s.source,
      repo: s.repo,
      label: s.repo || s.source,
      status,
      current_tool: s.currentTool,
      running_for_s: s.turnStartedAt ? Math.round(now - s.turnStartedAt) : 0,
      quiet_for_s: Math.round(quiet),
      files_touched: [...s.filesTouched],
      last_test_result: s.lastTestResult,
      pending_permission: s.pendingPermission,
      pending_permission_id: s.pendingPermissionId,
      last_error: s.lastError,
      turns: s.turns,
      last_reply: s.lastReply,
    };
  }

  snapshot(): Record<string, SessionSnapshot> {
    const now = this.now();
    const out: Record<string, SessionSnapshot> = {};
    for (const [id, s] of this.sessions) out[id] = this.snapshotOf(s, now);
    return out;
  }

  /** Sessions blocked on a human, most recent first. */
  waiting(): Session[] {
    return [...this.sessions.values()]
      .filter((s) => s.status === WAITING)
      .sort((a, b) => b.lastEventAt - a.lastEventAt);
  }

  /** One line per session, for a head that answers "what's it doing?" */
  brief(): string {
    const lines: string[] = [];
    for (const s of Object.values(this.snapshot())) {
      const bits = [`${s.label}: ${s.status}`];
      if (s.status === WORKING && s.current_tool) bits.push(`doing ${s.current_tool}`);
      if (s.running_for_s) bits.push(`for ${s.running_for_s}s`);
      if (s.status === WAITING && s.pending_permission)
        bits.push(`waiting for approval: ${s.pending_permission}`);
      if (s.last_test_result) bits.push(`last tests ${s.last_test_result}`);
      if (s.last_error) bits.push(`last error: ${s.last_error.slice(0, 120)}`);
      lines.push(bits.join(", "));
    }
    return lines.join("\n");
  }
}

function describe(e: ev.AgentEvent): string {
  const c = cmdArg(e);
  if (c) return c;
  const p = pathArg(e);
  if (p) return `${e.tool} ${p}`;
  return e.tool ?? "";
}
