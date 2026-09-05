/**
 * Normalized agent events: the contract between adapters and everything else.
 *
 * Every coding agent speaks its own dialect. Adapters translate that dialect
 * into an AgentEvent. Downstream (narrator, arbiter, speech) only ever sees
 * this shape, so adding an agent means writing one adapter and touching
 * nothing else.
 *
 * Severity is the axis the whole product lives on. Most events are never
 * spoken.
 */

export const SCHEMA_VERSION = 1;

export const SESSION_START = "session_start";
export const SESSION_END = "session_end";
export const TURN_START = "turn_start";
export const TURN_END = "turn_end";
export const TEXT = "text";
export const TOOL_START = "tool_start";
export const TOOL_END = "tool_end";
export const PERMISSION = "permission";
export const NOTIFICATION = "notification";
export const ERROR = "error";
export const IDLE = "idle";

export type Kind =
  | typeof SESSION_START
  | typeof SESSION_END
  | typeof TURN_START
  | typeof TURN_END
  | typeof TEXT
  | typeof TOOL_START
  | typeof TOOL_END
  | typeof PERMISSION
  | typeof NOTIFICATION
  | typeof ERROR
  | typeof IDLE;

export const KINDS: ReadonlySet<string> = new Set<Kind>([
  SESSION_START,
  SESSION_END,
  TURN_START,
  TURN_END,
  TEXT,
  TOOL_START,
  TOOL_END,
  PERMISSION,
  NOTIFICATION,
  ERROR,
  IDLE,
]);

/** never spoken; telemetry only */
export const SEV_DEBUG = 0;
/** spoken only in verbose mode, always droppable when stale */
export const SEV_PROGRESS = 1;
/** spoken in normal mode: a turn finished, tests ran */
export const SEV_MILESTONE = 2;
/** a human is blocking the agent: always spoken, preempts */
export const SEV_ATTENTION = 3;
/** errors that killed the run: always spoken, preempts */
export const SEV_CRITICAL = 4;

export const DEFAULT_SEVERITY: Readonly<Record<Kind, number>> = {
  [SESSION_START]: SEV_DEBUG,
  [SESSION_END]: SEV_DEBUG,
  [TURN_START]: SEV_DEBUG,
  [TURN_END]: SEV_MILESTONE,
  [TEXT]: SEV_MILESTONE,
  [TOOL_START]: SEV_PROGRESS,
  [TOOL_END]: SEV_PROGRESS,
  [PERMISSION]: SEV_ATTENTION,
  [NOTIFICATION]: SEV_ATTENTION,
  [ERROR]: SEV_CRITICAL,
  [IDLE]: SEV_PROGRESS,
};

export type Status = "" | "ok" | "error" | "denied" | "pending";

export interface AgentEvent {
  kind: Kind;
  /** claude_code | codex | headless | manual ... */
  source: string;
  /** agent-side session id, or a derived `${source}:${repo}` */
  session: string;
  cwd: string;
  repo: string;
  /** assistant prose, notification body, error message */
  text: string;
  /** tool name for tool_start / tool_end */
  tool: string;
  args: Record<string, unknown>;
  status: Status | string;
  severity: number;
  id: string;
  /** seconds since the epoch, fractional */
  ts: number;
  schema: number;
  meta: Record<string, unknown>;
}

export type EventInit = Partial<Omit<AgentEvent, "kind">> & { kind: Kind };

/** Injectable clock, in seconds. Tests replace it instead of patching a global. */
export type Clock = () => number;
export const wallClock: Clock = () => Date.now() / 1000;

/**
 * The repo a cwd belongs to. Core has no filesystem, so this is the basename;
 * the daemon installs a resolver that walks up to the nearest `.git`.
 */
export type RepoResolver = (cwd: string) => string;
let repoResolver: RepoResolver = basename;

export function setRepoResolver(fn: RepoResolver | null): void {
  repoResolver = fn ?? basename;
}

export function basename(p: string): string {
  const parts = String(p ?? "")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

let counter = 0;
function newId(): string {
  counter = (counter + 1) % 0xffff;
  const t = Date.now().toString(16).slice(-8);
  const r = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return (t + r + counter.toString(16).padStart(4, "0")).slice(0, 12);
}

export function make(init: EventInit, now: Clock = wallClock): AgentEvent {
  if (!KINDS.has(init.kind)) {
    throw new Error(`unknown event kind: ${JSON.stringify(init.kind)}`);
  }
  const cwd = init.cwd ?? "";
  const repo = init.repo || (cwd ? repoResolver(cwd) : "");
  const source = init.source ?? "unknown";
  const severity =
    init.severity !== undefined && init.severity >= 0
      ? init.severity
      : (DEFAULT_SEVERITY[init.kind] ?? SEV_PROGRESS);
  return {
    kind: init.kind,
    source,
    session: init.session || `${source}:${repo || "default"}`,
    cwd,
    repo,
    text: init.text ?? "",
    tool: init.tool ?? "",
    args: init.args ?? {},
    status: init.status ?? "",
    severity,
    id: init.id || newId(),
    ts: init.ts || now(),
    schema: SCHEMA_VERSION,
    meta: init.meta ?? {},
  };
}

export function fromDict(d: Record<string, unknown> | null | undefined): AgentEvent {
  const { schema: _schema, ...src } = d ?? {};
  return make(src as unknown as EventInit);
}

export function fromJSON(raw: string): AgentEvent {
  return fromDict(JSON.parse(raw));
}

export function toJSON(e: AgentEvent): string {
  return JSON.stringify(e);
}

export function needsHuman(e: AgentEvent): boolean {
  return e.severity >= SEV_ATTENTION;
}

/** Short spoken label for which agent this is. */
export function label(e: AgentEvent): string {
  return e.repo || e.source;
}

export function age(e: AgentEvent, now: Clock = wallClock): number {
  return now() - e.ts;
}
