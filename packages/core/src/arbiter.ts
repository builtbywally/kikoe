/**
 * Arbiter: one mouth, many agents.
 *
 * Five sessions in five repos all want to talk. The arbiter decides who gets
 * the speaker, in what order, and who gets cut off.
 *
 *   - Higher severity wins. Attention-grade lines preempt whatever is speaking.
 *   - Stale progress is dropped, never spoken late.
 *   - Repeated identical lines collapse.
 *   - When the talking session changes, the listener is told which repo.
 *   - Chatter earns a per-session budget; a permission question or a crash
 *     never spends one.
 */

import * as ev from "./events.js";
import { type Utterance, isStale } from "./narrator.js";

/** Don't let a chatty agent monopolise the speaker with progress noise. */
export const PROGRESS_MIN_GAP_S = 4.0;
/** Above this many queued items, drop the low-priority tail. */
export const MAX_QUEUE = 64;
/** Per-session token bucket: burst, and seconds to earn one line back. */
export const SESSION_BURST = 4;
export const SESSION_REFILL_S = 10.0;

const PERM_KEY = "perm:";

/** The prompt id a permission utterance carries, or "". */
export function permissionId(u: Utterance): string {
  if (!u.dedupe.startsWith(PERM_KEY)) return "";
  return u.eventId || u.dedupe.slice(PERM_KEY.length);
}

/**
 * What the arbiter talks into. `speak` resolves when the line has finished
 * playing, or rejects if it was cancelled. `cancel` stops the current line.
 */
export interface SpeechSink {
  /** the utterance rides along so a sink can pick a voice or a cue for it */
  speak(text: string, signal: AbortSignal, u?: Utterance): Promise<void>;
}

export type SpeechPhase = "speaking" | "quiet" | "interrupted";
export interface SpeechInfo {
  text?: string;
  priority?: number;
  session?: string;
}

/**
 * Something that can hold a permission question back until the previous one
 * is answered, and is told which prompt is being read out.
 */
export interface PermissionBinding {
  blocks(promptId: string): boolean;
  bind(promptId: string): void;
}

export interface ArbiterOptions {
  labelSessions?: boolean;
  onSpeech?: (phase: SpeechPhase, info: SpeechInfo) => void;
  permissions?: PermissionBinding;
  now?: ev.Clock;
}

interface Row {
  priority: number;
  order: number;
  u: Utterance;
}

export class Arbiter {
  private readonly sink: SpeechSink;
  private readonly labelSessions: boolean;
  private readonly onSpeech: ArbiterOptions["onSpeech"];
  private readonly permissions: PermissionBinding | undefined;
  private readonly now: ev.Clock;
  private heap: Row[] = [];
  private counter = 0;
  private current: { u: Utterance; abort: AbortController } | null = null;
  private lastSession: string | null = null;
  private lastProgressAt = 0;
  private buckets = new Map<string, { tokens: number; last: number }>();
  private seenSessions = new Map<string, number>();
  private running = false;
  private draining: Promise<void> | null = null;
  dropped = 0;
  spokenCount = 0;

  constructor(sink: SpeechSink, opts: ArbiterOptions = {}) {
    this.sink = sink;
    this.labelSessions = opts.labelSessions ?? true;
    this.onSpeech = opts.onSpeech;
    this.permissions = opts.permissions;
    this.now = opts.now ?? ev.wallClock;
  }

  private notify(phase: SpeechPhase, info: SpeechInfo = {}): void {
    try {
      this.onSpeech?.(phase, info);
    } catch {
      /* a broken watcher must never silence the mouth */
    }
  }

  // -- input ---------------------------------------------------------------

  submit(u: Utterance | null | undefined): boolean {
    if (!u || !u.text) return false;
    this.seenSessions.set(u.session, this.now());
    if (u.preempt && u.priority >= ev.SEV_ATTENTION) {
      const cur = this.current;
      if (cur && cur.u.priority < u.priority) {
        cur.abort.abort();
        this.current = null;
      }
      this.dropBelow(ev.SEV_ATTENTION);
    }
    this.heap.push({ priority: u.priority, order: this.counter++, u });
    this.trim();
    this.kick();
    return true;
  }

  submitAll(us: Iterable<Utterance>): number {
    let n = 0;
    for (const u of us) if (this.submit(u)) n++;
    return n;
  }

  /** Speech queued here, or being spoken right now? */
  pending(): boolean {
    return this.heap.length > 0 || this.current !== null;
  }

  /** Human cut in: abandon everything queued and stop talking. */
  interrupt(): void {
    this.heap = [];
    const cur = this.current;
    this.current = null;
    cur?.abort.abort();
    this.notify("interrupted");
  }

  /** Resolves once everything currently queued has been spoken. */
  drain(): Promise<void> {
    return this.draining ?? Promise.resolve();
  }

  // -- queue maintenance ---------------------------------------------------

  private sorted(): Row[] {
    return [...this.heap].sort((a, b) => b.priority - a.priority || a.order - b.order);
  }

  private dropBelow(priority: number): void {
    const kept = this.heap.filter((r) => r.priority >= priority);
    this.dropped += this.heap.length - kept.length;
    this.heap = kept;
  }

  private trim(): void {
    if (this.heap.length <= MAX_QUEUE) return;
    const ordered = this.sorted();
    this.dropped += ordered.length - MAX_QUEUE;
    this.heap = ordered.slice(0, MAX_QUEUE);
  }

  /** One spend from the session's bucket; false means the line drops. */
  private takeToken(session: string, now: number): boolean {
    if (!session) return true;
    const b = this.buckets.get(session) ?? { tokens: SESSION_BURST, last: now };
    const tokens = Math.min(SESSION_BURST, b.tokens + (now - b.last) / SESSION_REFILL_S);
    const spend = tokens >= 1;
    this.buckets.set(session, { tokens: spend ? tokens - 1 : tokens, last: now });
    if (this.buckets.size > 256) {
      const cutoff = now - SESSION_BURST * SESSION_REFILL_S;
      for (const [s, v] of this.buckets) if (v.last <= cutoff) this.buckets.delete(s);
    }
    return spend;
  }

  /** Pop the best speakable item, discarding stale ones. */
  private next(): Utterance | null {
    const now = this.now();
    const held: Row[] = [];
    let picked: Utterance | null = null;
    const ordered = this.sorted();
    this.heap = [];
    let i = 0;
    for (; i < ordered.length; i++) {
      const row = ordered[i]!;
      const u = row.u;
      if (isStale(u, this.now)) {
        this.dropped++;
        continue;
      }
      const pid = permissionId(u);
      if (pid) {
        // One permission question at a time. The second waits, held not
        // dropped, so first-raised still speaks first.
        if (this.permissions?.blocks(pid)) {
          held.push(row);
          continue;
        }
      } else {
        if (u.priority <= ev.SEV_PROGRESS && now - this.lastProgressAt < PROGRESS_MIN_GAP_S) {
          this.dropped++;
          continue;
        }
        // Per-session fairness, but never for a crash: chatter earns a
        // budget, failure does not spend one.
        if (u.priority < ev.SEV_CRITICAL && !this.takeToken(u.session, now)) {
          this.dropped++;
          continue;
        }
      }
      picked = u;
      i++;
      break;
    }
    this.heap = [...held, ...ordered.slice(i)];
    return picked;
  }

  // -- speaking ------------------------------------------------------------

  /** Tell the listener which agent is talking when it isn't obvious. */
  private decorate(u: Utterance): string {
    if (!u.label) return u.text;
    const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
    // A permission prompt always says whose it is: a yes to an unnamed
    // question is how the wrong repo gets an approval.
    if (permissionId(u)) return `In ${u.label}, ${lowerFirst(u.text)}`;
    if (!this.labelSessions) return u.text;
    const now = this.now();
    const recent = [...this.seenSessions].filter(([, t]) => now - t < 300).length;
    if (recent > 1 && u.session !== this.lastSession) return `In ${u.label}, ${lowerFirst(u.text)}`;
    return u.text;
  }

  /**
   * Look at the queue again. A held permission question only moves when the
   * one ahead of it is answered, and that happens outside the arbiter.
   */
  wake(): void {
    this.kick();
  }

  private kick(): void {
    if (this.running) return;
    this.running = true;
    this.draining = this.loop().finally(() => {
      this.running = false;
      this.draining = null;
    });
  }

  private async loop(): Promise<void> {
    for (;;) {
      const u = this.next();
      if (!u) return;
      const abort = new AbortController();
      this.current = { u, abort };
      const text = this.decorate(u);
      const pid = permissionId(u);
      // Bind before the first word: people answer mid-sentence.
      if (pid) this.permissions?.bind(pid);
      this.notify("speaking", { text, priority: u.priority, session: u.session });
      try {
        await this.sink.speak(text, abort.signal, u);
        this.spokenCount++;
        if (u.priority <= ev.SEV_PROGRESS) this.lastProgressAt = this.now();
        this.lastSession = u.session;
      } catch {
        /* cancelled or failed; the next line still gets its turn */
      }
      if (this.current?.u === u) this.current = null;
      this.notify("quiet");
    }
  }

  // -- introspection -------------------------------------------------------

  state() {
    return {
      queued: this.heap.length,
      speaking: this.current !== null,
      current: this.current?.u.text ?? "",
      dropped: this.dropped,
      spoken: this.spokenCount,
      sessions: [...this.seenSessions.keys()].sort(),
    };
  }
}

/** Convenience for manual speak calls. */
export function utterance(
  text: string,
  extra: Partial<Utterance> = {},
  now: ev.Clock = ev.wallClock,
): Utterance {
  return {
    text,
    session: "",
    label: "",
    priority: ev.SEV_MILESTONE,
    ttl: 0,
    dedupe: "",
    preempt: false,
    created: now(),
    eventId: "",
    ...extra,
  };
}
