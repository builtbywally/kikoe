/**
 * Narrator: turns raw agent events into something worth hearing.
 *
 * This is the product. Reading an agent's output aloud verbatim is a demo;
 * markdown, diffs, file paths and tool spam are unbearable in audio. The
 * narrator's job is to be quiet, and to be right about the rare moments that
 * deserve a human's attention.
 *
 *   - Default to silence. Most events produce nothing.
 *   - Never speak code, diffs, paths or tables.
 *   - Progress narration is droppable: stale by the time the mouth is free
 *     means it is no longer news.
 *   - Attention events (permission, error) always speak and preempt.
 */

import * as ev from "./events.js";
import { firstSentences, scrub, spokenFilename } from "./scrub.js";
import type { SpeakOptions } from "./speak.js";

export const SILENT = "silent"; // attention only: permissions, errors
export const ATTENTION = "attention"; // + turn completions
export const NORMAL = "normal"; // + meaningful milestones (tests, commits, builds)
export const VERBOSE = "verbose"; // + running commentary on edits

export type Mode = typeof SILENT | typeof ATTENTION | typeof NORMAL | typeof VERBOSE;
export const MODES: readonly Mode[] = [SILENT, ATTENTION, NORMAL, VERBOSE];

export const MIN_SEVERITY: Readonly<Record<Mode, number>> = {
  [SILENT]: ev.SEV_ATTENTION,
  [ATTENTION]: ev.SEV_MILESTONE,
  [NORMAL]: ev.SEV_MILESTONE,
  [VERBOSE]: ev.SEV_PROGRESS,
};

/**
 * Sessions spawned without a terminal have no watcher, so progress chatter
 * from one is noise by definition. Only the moments that need a human get
 * through: a permission question, a failure, and done. A kind allow-list,
 * not a severity threshold, on purpose: a failing test run inside a spawned
 * session is attention-grade, but the session is still working on it.
 */
export const BACKGROUND_SOURCES: ReadonlySet<string> = new Set(["claude-headless"]);
export const BACKGROUND_KINDS: ReadonlySet<string> = new Set([
  ev.PERMISSION,
  ev.ERROR,
  ev.TURN_END,
]);

// --- tool vocabulary --------------------------------------------------------

/** Reading the codebase is not news. */
export const SILENT_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "glob",
  "list",
  "ls",
  "webfetch",
  "websearch",
  "todowrite",
  "todoread",
  "notebookread",
  "task_status",
  "bashoutput",
  "search",
  "exitplanmode",
]);
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "apply_patch",
  "str_replace",
]);
export const SHELL_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "shell",
  "powershell",
  "run",
  "exec",
  "terminal",
]);
export const DELEGATE_TOOLS: ReadonlySet<string> = new Set([
  "task",
  "agent",
  "subagent",
  "dispatch",
]);

// (pattern, gerund, infinitive). Gerund narrates what's happening; infinitive
// goes after "It wants to ..." in a permission prompt.
const CMD_PHRASES: Array<[RegExp, string, string]> = [
  [
    /\b(pytest|jest|vitest|go test|cargo test|npm (run )?test|yarn test|pnpm test|mvn test)\b/i,
    "running the tests",
    "run the tests",
  ],
  [
    /\b(npm|yarn|pnpm|bun) (run )?(build|compile)\b|\b(tsc|cargo build|go build|make)\b/i,
    "building",
    "build the project",
  ],
  [
    /\b(npm|yarn|pnpm|bun|pip|pip3|poetry|uv|cargo|go) (install|add|get|sync)\b/i,
    "installing packages",
    "install packages",
  ],
  [/\bgit commit\b/i, "committing", "commit"],
  [/\bgit push\b/i, "pushing", "push"],
  [/\bgit (pull|fetch|rebase|merge)\b/i, "syncing with git", "sync with git"],
  [/\bgit (status|diff|log|show)\b/i, "", "check git"], // silent to narrate
  [/\b(eslint|ruff|flake8|black|prettier|mypy|pyright|clippy)\b/i, "linting", "lint"],
  [
    /\b(docker|docker-compose|kubectl|helm)\b/i,
    "working with containers",
    "run a container command",
  ],
  [/\b(vercel|netlify|fly|heroku|terraform|aws|gcloud)\b/i, "deploying", "deploy"],
  [/\b(rm|del|rmdir)\b/i, "deleting files", "delete files"],
  [/\b(mkdir|touch|cp|mv|copy|move)\b/i, "", "move files around"],
];

export const GERUND = 0;
export const INFINITIVE = 1;
export type Form = typeof GERUND | typeof INFINITIVE;

const QUIET_HEADS: ReadonlySet<string> = new Set([
  "echo",
  "cat",
  "head",
  "tail",
  "which",
  "type",
  "pwd",
  "wc",
  "find",
  "sed",
  "awk",
]);

// "Claude needs your permission to run rm -rf build" -> "run rm -rf build"
const PERMISSION_ASK =
  /(?:needs?(?:\s+\w+)?\s+permission\s+to|wants?\s+to|is\s+requesting\s+(?:permission\s+)?to|asking\s+to|would\s+like\s+to)\s+(.+)/i;

// Counts are matched independently: runners emit them in either order, and
// reading a failing run as green is the worst bug this layer can have.
const TEST_PASSED = /(\d+)\s+(?:passed|passing|ok\b)/i;
const TEST_FAILED = /(\d+)\s+(?:failed|failing|failures?|errors?)\b/i;

const WORD_SPLIT = /[\s|&;]+/;

function headOf(cmd: string): string {
  const trimmed = (cmd ?? "").trim();
  if (!trimmed) return "";
  const head = trimmed.split(WORD_SPLIT)[0] ?? "";
  const parts = head.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/**
 * A shell command -> what a colleague would say they're doing.
 * Returns "" when the command isn't worth saying out loud. The infinitive
 * form is never silent: if we're asking permission, the human needs to hear
 * what for, even when it's boring.
 */
export function summarizeCommand(cmd: string, form: Form = GERUND): string {
  const c = (cmd ?? "").trim();
  if (!c) return "";
  for (const [re, gerund, infinitive] of CMD_PHRASES) {
    if (re.test(c)) return form === INFINITIVE ? infinitive : gerund;
  }
  const head = headOf(c);
  if (!head) return "";
  if (form === INFINITIVE) return "run " + head;
  if (QUIET_HEADS.has(head)) return "";
  return "running " + head;
}

/**
 * Pull a spoken verdict out of test runner noise. Never claims a pass it
 * didn't see: any non-zero failure count wins over a passed count no matter
 * which order they appear in.
 */
export function summarizeTestOutput(text: string): string {
  if (!text) return "";
  const pm = TEST_PASSED.exec(text);
  const fm = TEST_FAILED.exec(text);
  const passed = pm ? Number.parseInt(pm[1]!, 10) : null;
  const failed = fm ? Number.parseInt(fm[1]!, 10) : null;
  if (failed) {
    if (passed) return `${passed} passed, ${failed} failed`;
    return `${failed} failed`;
  }
  if (passed !== null) return `all ${passed} passed`;
  return "";
}

// --- output -----------------------------------------------------------------

export interface Utterance {
  text: string;
  session: string;
  label: string;
  priority: number;
  /** seconds; 0 = never goes stale */
  ttl: number;
  /** collapse repeats sharing this key */
  dedupe: string;
  /** cut off whatever is currently speaking */
  preempt: boolean;
  created: number;
  eventId: string;
}

export function isStale(u: Utterance, now: ev.Clock = ev.wallClock): boolean {
  return u.ttl > 0 && now() - u.created > u.ttl;
}

/** Progress commentary is worthless once it's old news. */
export const PROGRESS_TTL = 12.0;
export const MILESTONE_TTL = 45.0;
/** seconds of tool churn folded into one sentence */
export const COALESCE_WINDOW = 2.5;

export interface NarratorOptions {
  mode?: string;
  /** seconds; injectable so tests move time instead of sleeping */
  now?: ev.Clock;
  speak?: SpeakOptions;
}

interface UtterOpts {
  priority?: number;
  ttl?: number;
  dedupe?: string;
  preempt?: boolean;
}

export class Narrator {
  mode: Mode;
  private readonly now: ev.Clock;
  private readonly speak: SpeakOptions;
  private pendingEdits = new Map<string, string[]>();
  private pendingSince = new Map<string, number>();
  private lastTool = new Map<string, string>();
  private recent = new Map<string, number>();

  constructor(opts: NarratorOptions = {}) {
    this.mode = (MODES as readonly string[]).includes(opts.mode ?? "")
      ? (opts.mode as Mode)
      : NORMAL;
    this.now = opts.now ?? ev.wallClock;
    this.speak = opts.speak ?? {};
  }

  setMode(mode: string): void {
    if ((MODES as readonly string[]).includes(mode)) this.mode = mode as Mode;
  }

  // -- helpers -------------------------------------------------------------

  private allowed(severity: number): boolean {
    return severity >= MIN_SEVERITY[this.mode];
  }

  private dedupeOk(key: string, window = 8.0): boolean {
    if (!key) return true;
    const now = this.now();
    const last = this.recent.get(key) ?? 0;
    if (now - last < window) return false;
    this.recent.set(key, now);
    if (this.recent.size > 512) {
      const cutoff = now - 120;
      for (const [k, v] of this.recent) if (v <= cutoff) this.recent.delete(k);
    }
    return true;
  }

  private utter(e: ev.AgentEvent, text: string, o: UtterOpts = {}): Utterance[] {
    const t = (text ?? "").trim();
    if (!t) return [];
    const priority = o.priority ?? e.severity;
    if (!this.allowed(priority)) return [];
    if (!this.dedupeOk(o.dedupe ?? "")) return [];
    const ttl = o.ttl ?? (priority <= ev.SEV_PROGRESS ? PROGRESS_TTL : MILESTONE_TTL);
    const preempt = o.preempt ?? priority >= ev.SEV_ATTENTION;
    return [
      {
        text: t,
        session: e.session,
        label: ev.label(e),
        priority,
        ttl: priority >= ev.SEV_ATTENTION ? 0 : ttl,
        dedupe: o.dedupe ?? "",
        preempt,
        created: this.now(),
        eventId: e.id,
      },
    ];
  }

  private sc(text: string | null | undefined): string {
    return scrub(text, this.speak);
  }

  // -- main entry ----------------------------------------------------------

  /** AgentEvent -> Utterance[]. Usually empty. That's the point. */
  narrate(e: ev.AgentEvent): Utterance[] {
    // The background floor is checked before mode: verbose narrates the
    // terminal the user is watching, not sessions they never opened.
    if (BACKGROUND_SOURCES.has(e.source) && !BACKGROUND_KINDS.has(e.kind)) return [];
    const out = this.flushEdits(e.session, false);
    switch (e.kind) {
      case ev.PERMISSION:
        out.push(...this.onPermission(e));
        break;
      case ev.NOTIFICATION:
        out.push(...this.onNotification(e));
        break;
      case ev.ERROR:
        out.push(...this.onError(e));
        break;
      case ev.TEXT:
        out.push(...this.onText(e));
        break;
      case ev.TURN_END:
        out.push(...this.onTurnEnd(e));
        break;
      case ev.IDLE:
        out.push(...this.onIdle(e));
        break;
      case ev.TOOL_START:
        out.push(...this.onToolStart(e));
        break;
      case ev.TOOL_END:
        out.push(...this.onToolEnd(e));
        break;
      default:
        break;
    }
    return out;
  }

  /** Called on a timer so coalesced tool bursts eventually get spoken. */
  tick(): Utterance[] {
    const out: Utterance[] = [];
    for (const [session, since] of [...this.pendingSince]) {
      if (this.now() - since >= COALESCE_WINDOW) out.push(...this.flushEdits(session, true));
    }
    return out;
  }

  // -- per-kind handlers ---------------------------------------------------

  private onPermission(e: ev.AgentEvent): Utterance[] {
    return this.utter(e, this.permissionPhrase(e), {
      priority: ev.SEV_ATTENTION,
      dedupe: "perm:" + e.id,
    });
  }

  /**
   * Agents phrase permission prompts inconsistently: some hand us a bare
   * command, some a whole sentence. Don't wrap a sentence in "It wants to"
   * and produce word salad.
   */
  private permissionPhrase(e: ev.AgentEvent): string {
    const body = firstSentences(this.sc(e.text), 1, 160);
    if (body) {
      const m = PERMISSION_ASK.exec(body);
      if (m) return "It wants to " + m[1]!.trim().replace(/\.+$/, "") + ". Shall I?";
      if (body.split(/\s+/).length > 4) return body.replace(/\.+$/, "") + ". Shall I?";
    }
    const described = this.describeToolArgs(e);
    if (described) return "It wants to " + described + ". Shall I?";
    if (body) return body.replace(/\.+$/, "") + ". Shall I?";
    return "It needs permission to continue. Shall I?";
  }

  private onNotification(e: ev.AgentEvent): Utterance[] {
    const body = firstSentences(this.sc(e.text), 1, 160);
    return this.utter(e, body, {
      priority: ev.SEV_ATTENTION,
      dedupe: "notif:" + body.slice(0, 40),
    });
  }

  private onError(e: ev.AgentEvent): Utterance[] {
    const body = firstSentences(this.sc(e.text), 1, 160) || "something went wrong";
    return this.utter(e, "It hit an error. " + body, {
      priority: ev.SEV_CRITICAL,
      dedupe: "err:" + body.slice(0, 40),
    });
  }

  private onText(e: ev.AgentEvent): Utterance[] {
    const body = this.sc(e.text);
    if (body.length < 3) return [];
    return this.utter(e, firstSentences(body, 3, 320), { dedupe: "text:" + body.slice(0, 48) });
  }

  private onTurnEnd(e: ev.AgentEvent): Utterance[] {
    // The summary supersedes any queued progress chatter.
    this.pendingEdits.delete(e.session);
    this.pendingSince.delete(e.session);
    const body = this.sc(e.text);
    if (!body) return this.utter(e, "Done.", { dedupe: "done:" + e.session });
    return this.utter(e, firstSentences(body, 2, 280), { dedupe: "end:" + body.slice(0, 48) });
  }

  private onIdle(e: ev.AgentEvent): Utterance[] {
    return this.utter(e, "Waiting on you.", {
      priority: ev.SEV_ATTENTION,
      dedupe: "idle:" + e.session,
    });
  }

  private onToolStart(e: ev.AgentEvent): Utterance[] {
    const tool = (e.tool ?? "").toLowerCase();
    this.lastTool.set(e.session, e.tool);
    if (SILENT_TOOLS.has(tool)) return [];
    if (EDIT_TOOLS.has(tool)) {
      const name = spokenFilename(this.pathArg(e));
      const names = this.pendingEdits.get(e.session) ?? [];
      if (!names.includes(name)) names.push(name);
      this.pendingEdits.set(e.session, names);
      if (!this.pendingSince.has(e.session)) this.pendingSince.set(e.session, this.now());
      return [];
    }
    if (SHELL_TOOLS.has(tool)) {
      const phrase = summarizeCommand(this.cmdArg(e));
      return this.utter(e, phrase, { dedupe: "cmd:" + e.session + ":" + phrase });
    }
    if (DELEGATE_TOOLS.has(tool)) {
      const desc = this.sc(String(e.args.description ?? e.args.prompt ?? "")).slice(0, 90);
      const phrase = desc ? "Handing off: " + desc : "Spinning up a subagent.";
      return this.utter(e, phrase, { dedupe: "task:" + desc.slice(0, 30) });
    }
    return this.utter(e, "Using " + spokenFilename(e.tool) + ".", {
      dedupe: "tool:" + e.session + ":" + tool,
    });
  }

  private onToolEnd(e: ev.AgentEvent): Utterance[] {
    const tool = (e.tool || this.lastTool.get(e.session) || "").toLowerCase();
    if (e.status === "error") {
      const body = firstSentences(this.sc(e.text), 1, 120);
      return this.utter(e, body ? "That failed. " + body : "That failed.", {
        priority: ev.SEV_MILESTONE,
        dedupe: "toolerr:" + e.session + ":" + tool,
      });
    }
    if (SHELL_TOOLS.has(tool)) {
      const verdict = summarizeTestOutput(e.text);
      if (verdict) {
        const failed = verdict.includes("fail");
        return this.utter(e, "Tests: " + verdict + ".", {
          priority: failed ? ev.SEV_ATTENTION : ev.SEV_MILESTONE,
          dedupe: "tests:" + e.session + ":" + verdict,
        });
      }
    }
    if (DELEGATE_TOOLS.has(tool)) {
      // A background task finishing is one of the four moments that always
      // earns speech: the long wait ended after they stopped watching.
      const body = firstSentences(this.sc(e.text), 1, 120);
      return this.utter(e, body ? "That's done. " + body : "That's done.", {
        priority: ev.SEV_MILESTONE,
        dedupe: "taskdone:" + e.session + ":" + body.slice(0, 30),
      });
    }
    return [];
  }

  // -- coalescing ----------------------------------------------------------

  private flushEdits(session: string, force: boolean): Utterance[] {
    const names = this.pendingEdits.get(session);
    if (!names || !names.length) return [];
    const started = this.pendingSince.get(session) ?? 0;
    if (!force && this.now() - started < COALESCE_WINDOW) return [];
    this.pendingEdits.delete(session);
    this.pendingSince.delete(session);
    let phrase: string;
    if (names.length === 1) phrase = "Editing " + names[0] + ".";
    else if (names.length === 2) phrase = "Editing " + names[0] + " and " + names[1] + ".";
    else phrase = "Editing " + names.length + " files, starting with " + names[0] + ".";
    const stub = ev.make({ kind: ev.TOOL_START, session, severity: ev.SEV_PROGRESS }, this.now);
    return this.utter(stub, phrase, { dedupe: "edits:" + session + ":" + phrase });
  }

  // -- arg digging ---------------------------------------------------------

  private pathArg(e: ev.AgentEvent): string {
    const a = e.args ?? {};
    for (const k of ["file_path", "filePath", "path", "filename", "file", "target"]) {
      if (a[k]) return String(a[k]);
    }
    return "";
  }

  private cmdArg(e: ev.AgentEvent): string {
    const a = e.args ?? {};
    for (const k of ["command", "cmd", "script", "input"]) {
      if (a[k]) return String(a[k]);
    }
    return e.text || "";
  }

  private describeToolArgs(e: ev.AgentEvent): string {
    const tool = (e.tool ?? "").toLowerCase();
    if (SHELL_TOOLS.has(tool)) return summarizeCommand(this.cmdArg(e), INFINITIVE);
    if (EDIT_TOOLS.has(tool)) return "edit " + spokenFilename(this.pathArg(e));
    return e.tool ? "use " + spokenFilename(e.tool) : "";
  }
}
