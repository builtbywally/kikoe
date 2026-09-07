/**
 * The board: what the agent, Kik, or the user has put up to be seen. Pins
 * carry a kind, a title, a body, a repo (their region), who made them, and
 * a shelf life. A sticky pin has no shelf life and survives a restart. At
 * most a few dozen live at once, the oldest of a repo goes first, and
 * nothing that is not sticky outlives its TTL. A pin can be a question:
 * the `/show` request that made it stays open until an answer arrives or
 * the timeout denies it. A pin can be edited: a checklist ticks, a note is
 * rewritten, and either side may update a body.
 */

export const KINDS = [
  "markdown",
  "diff",
  "text",
  "table",
  "image",
  "html",
  "svg",
  "diagram",
  "checklist",
  "note",
  "web",
  "react",
  // what an agent did, rather than what Kik made
  "run",
  "result",
] as const;
export type PinKind = (typeof KINDS)[number];

/**
 * Two budgets on one canvas.
 *
 * `board` is the whiteboard it always was: a few things, they fade, the
 * oldest of the crowded repo goes first. `work` is a feed of what the agent
 * did, which arrives far faster and must never evict an artifact Kik made to
 * explain something. Same model, same renderer, same surface — separate caps.
 */
export const STREAMS = ["board", "work"] as const;
export type PinStream = (typeof STREAMS)[number];

export const MAX_PINS = 24;
/** the work feed is per session, and generous: it is a feed, not a whiteboard */
export const MAX_WORK = 40;
export const DEFAULT_TTL_S = 900;
export const MAX_BODY = 200_000;

export interface Pin {
  id: string;
  kind: PinKind;
  title: string;
  body: string;
  /** whose board it belongs to; the Room shows one project at a time */
  project: string;
  /** the frame it sits in, within that project */
  repo: string;
  session: string;
  /** which budget it lives in: Kik's whiteboard, or the agent's work feed */
  stream: PinStream;
  /** the agent turn this belongs to, for work pins; groups and evicts them */
  turn: number;
  /** who put it up: the agent, Kik itself, or the user */
  by: "agent" | "kik" | "you";
  /** seconds since epoch */
  created: number;
  /** seconds since epoch of the last edit */
  updated: number;
  ttl_s: number;
  /** no shelf life; survives a restart */
  sticky: boolean;
  /** placed beside this pin, the way a sticky note sits by an artboard */
  near: string;
  /** wide: an artboard for a page, a drawing, an image */
  size: "normal" | "wide";
  /** a size the user dragged it to, in canvas pixels; 0 is automatic */
  w: number;
  h: number;
  /**
   * Where the user put it, in canvas pixels. 0,0 means "you decide" and the
   * board lays it out; anything else is an arrangement it must not undo.
   * This is what makes a board come back the way it was left.
   */
  x: number;
  y: number;
  /** the answers offered, when this pin is a question */
  ask: string[];
  answer: string | null;
  /** seconds the asker waits before a silence denies, when asking */
  wait_s: number;
}

export interface PinEvent {
  op: "add" | "answer" | "remove" | "clear" | "update";
  pin?: Pin | undefined;
  id?: string | undefined;
  answer?: string | undefined;
}

export interface PinInit {
  kind?: string | undefined;
  title?: string | undefined;
  body: string;
  project?: string | undefined;
  repo?: string | undefined;
  session?: string | undefined;
  stream?: PinStream | undefined;
  turn?: number | undefined;
  by?: Pin["by"] | undefined;
  ttl_s?: number | undefined;
  sticky?: boolean | undefined;
  near?: string | undefined;
  size?: "normal" | "wide" | undefined;
  w?: number | undefined;
  h?: number | undefined;
  x?: number | undefined;
  y?: number | undefined;
  ask?: string[] | undefined;
  wait_s?: number | undefined;
}

export interface PinPatch {
  title?: string | undefined;
  body?: string | undefined;
  kind?: string | undefined;
  sticky?: boolean | undefined;
  near?: string | undefined;
  size?: "normal" | "wide" | undefined;
  w?: number | undefined;
  h?: number | undefined;
  x?: number | undefined;
  y?: number | undefined;
}

let counter = 0;
function newId(): string {
  counter = (counter + 1) % 0xffff;
  return `p${Date.now().toString(36)}${counter.toString(36)}`;
}

function kindOf(kind: string | undefined): PinKind {
  return (KINDS as readonly string[]).includes(kind ?? "") ? (kind as PinKind) : "text";
}

/** The canvas runs in every direction, so a position may be negative. */
const MAX_POS = 200_000;
function clampPos(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.max(-MAX_POS, Math.min(MAX_POS, n)));
}

export class Board {
  private pins: Pin[] = [];
  private waiters = new Map<string, (answer: string) => void>();
  constructor(
    private emit: (e: PinEvent) => void,
    private now: () => number = () => Date.now() / 1000,
    /**
     * Whose board a pin belongs to when the caller does not say.
     *
     * Without this a pin added with no project sits on a board nobody is
     * looking at and is simply invisible, which is a horrible way to find
     * out you forgot a field. Silence means "the board in front of me".
     */
    private defaultProject: () => string = () => "",
  ) {}

  /** Everything, or one project's board. */
  list(project?: string): Pin[] {
    this.sweep();
    const all = [...this.pins];
    return project === undefined ? all : all.filter((p) => p.project === project);
  }

  /** Which projects have anything on them right now. */
  projects(): string[] {
    return [...new Set(this.pins.map((p) => p.project))];
  }

  get(id: string): Pin | undefined {
    return this.pins.find((p) => p.id === id);
  }

  add(init: PinInit): Pin {
    const pin: Pin = {
      id: newId(),
      kind: kindOf(init.kind),
      title: (init.title ?? "").slice(0, 120),
      body: init.body.slice(0, MAX_BODY),
      project: init.project || this.defaultProject(),
      repo: init.repo ?? "",
      session: init.session ?? "",
      stream: init.stream === "work" ? "work" : "board",
      turn: Math.max(0, Number(init.turn ?? 0)),
      by: init.by ?? "agent",
      created: this.now(),
      updated: this.now(),
      ttl_s: Math.max(10, Math.min(24 * 3600, init.ttl_s ?? DEFAULT_TTL_S)),
      sticky: Boolean(init.sticky),
      near: init.near ?? "",
      size: init.size === "wide" ? "wide" : "normal",
      w: Math.max(0, Math.min(4000, Number(init.w ?? 0))),
      h: Math.max(0, Math.min(4000, Number(init.h ?? 0))),
      x: Number(init.x ?? 0) || 0,
      y: Number(init.y ?? 0) || 0,
      ask: (init.ask ?? [])
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 4),
      answer: null,
      wait_s: init.wait_s ?? 0,
    };
    this.pins.push(pin);
    if (pin.stream === "work") this.evictWork(pin.session);
    else this.evict(pin.project);
    this.emit({ op: "add", pin });
    return pin;
  }

  /** Edit a pin in place: a tick on a checklist, a rewritten note, a new title. */
  update(id: string, patch: PinPatch): Pin | undefined {
    const pin = this.get(id);
    if (!pin) return undefined;
    if (patch.title !== undefined) pin.title = patch.title.slice(0, 120);
    if (patch.body !== undefined) pin.body = patch.body.slice(0, MAX_BODY);
    if (patch.kind !== undefined) pin.kind = kindOf(patch.kind);
    if (patch.sticky !== undefined) pin.sticky = Boolean(patch.sticky);
    if (patch.near !== undefined) pin.near = patch.near;
    if (patch.size !== undefined) pin.size = patch.size === "wide" ? "wide" : "normal";
    if (patch.w !== undefined) pin.w = Math.max(0, Math.min(4000, Number(patch.w) || 0));
    if (patch.h !== undefined) pin.h = Math.max(0, Math.min(4000, Number(patch.h) || 0));
    // A position can be negative: the canvas runs in every direction.
    if (patch.x !== undefined) pin.x = clampPos(patch.x);
    if (patch.y !== undefined) pin.y = clampPos(patch.y);
    pin.updated = this.now();
    this.emit({ op: "update", pin, id });
    return pin;
  }

  /** Hold until the pin is answered; an empty string means timeout or removal. */
  wait(id: string, timeoutS: number): Promise<string> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve("");
      }, timeoutS * 1000);
      this.waiters.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
    });
  }

  /** Is a question waiting on the user? */
  asking(): Pin | undefined {
    return this.pins.find((p) => p.ask.length && p.answer === null && this.waiters.has(p.id));
  }

  answer(id: string, answer: string): boolean {
    const pin = this.get(id);
    if (!pin) return false;
    const a = answer.trim().toLowerCase();
    if (pin.ask.length && !pin.ask.includes(a) && a !== "") return false;
    pin.answer = a;
    this.waiters.get(id)?.(a);
    this.waiters.delete(id);
    this.emit({ op: "answer", id, answer: a, pin });
    return true;
  }

  /** A bare "yes" or "no" answers the question being asked, if there is one. */
  answerCurrent(word: string): boolean {
    const pin = this.asking();
    if (!pin) return false;
    const w = word.trim().toLowerCase();
    const yes = pin.ask.find((a) => a !== "no" && a !== "deny" && a !== "cancel");
    if (["yes", "yeah", "yep", "ok", "okay", "do it", "go ahead"].includes(w) && yes)
      return this.answer(pin.id, yes);
    if (["no", "nope", "don't", "stop", "cancel"].includes(w)) return this.answer(pin.id, "no");
    return this.answer(pin.id, w);
  }

  remove(id: string): boolean {
    const i = this.pins.findIndex((p) => p.id === id);
    if (i < 0) return false;
    const [pin] = this.pins.splice(i, 1);
    this.waiters.get(id)?.("");
    this.waiters.delete(id);
    this.emit({ op: "remove", id, pin });
    return true;
  }

  /** Everything that is not sticky goes. */
  clear(): number {
    const gone = this.pins.filter((p) => !p.sticky);
    for (const p of gone) {
      this.waiters.get(p.id)?.("");
      this.waiters.delete(p.id);
    }
    this.pins = this.pins.filter((p) => p.sticky);
    this.emit({ op: "clear" });
    return gone.length;
  }

  /**
   * Drop expired pins. Called on every read and on a timer.
   *
   * Work pins keep no clock: a diff from an hour ago is still the diff you
   * are reading. They leave when their turn is evicted, not when time passes.
   */
  sweep(): void {
    const now = this.now();
    for (const p of [...this.pins]) {
      if (p.stream === "work" || p.sticky) continue;
      if (now - p.created > p.ttl_s) this.remove(p.id);
    }
  }

  /**
   * For the file on disk: what survives a restart. The work feed does not
   * yet — it belongs to a session that is over by the time we come back.
   */
  toJSON(project?: string): Pin[] {
    return this.pins.filter(
      (p) =>
        p.stream !== "work" &&
        (project === undefined || p.project === project) &&
        (p.sticky || this.now() - p.created < p.ttl_s),
    );
  }

  /** From the file on disk. Questions do not survive: their askers are gone. */
  load(pins: unknown): number {
    if (!Array.isArray(pins)) return 0;
    let n = 0;
    for (const raw of pins) {
      if (!raw || typeof raw !== "object") continue;
      const p = raw as Partial<Pin>;
      if (typeof p.id !== "string" || typeof p.body !== "string") continue;
      if (p.ask?.length && p.answer === null) continue;
      if (this.pins.some((x) => x.id === p.id)) continue;
      const created = Number(p.created ?? this.now());
      const ttl = Number(p.ttl_s ?? DEFAULT_TTL_S);
      if (!p.sticky && this.now() - created > ttl) continue;
      this.pins.push({
        id: p.id,
        kind: kindOf(p.kind),
        title: String(p.title ?? "").slice(0, 120),
        body: p.body.slice(0, MAX_BODY),
        project: String(p.project ?? ""),
        repo: String(p.repo ?? ""),
        session: String(p.session ?? ""),
        stream: p.stream === "work" ? "work" : "board",
        turn: Number(p.turn ?? 0) || 0,
        by: p.by === "kik" || p.by === "you" ? p.by : "agent",
        created,
        updated: Number(p.updated ?? created),
        ttl_s: ttl,
        sticky: Boolean(p.sticky),
        near: typeof p.near === "string" ? p.near : "",
        size: p.size === "wide" ? "wide" : "normal",
        w: Number(p.w ?? 0) || 0,
        h: Number(p.h ?? 0) || 0,
        x: clampPos(p.x),
        y: clampPos(p.y),
        ask: Array.isArray(p.ask) ? p.ask.map(String) : [],
        answer: typeof p.answer === "string" ? p.answer : null,
        wait_s: Number(p.wait_s ?? 0),
      });
      n++;
    }
    return n;
  }

  /**
   * The work feed, trimmed per session and by whole turns.
   *
   * A turn is the unit a person thinks in — "what did that last change do" —
   * so half a turn is worse than none. Oldest turns go first, entire.
   */
  private evictWork(session: string): void {
    const mine = this.pins.filter((p) => p.stream === "work" && p.session === session);
    if (mine.length <= MAX_WORK) return;
    const turns = [...new Set(mine.map((p) => p.turn))].sort((a, b) => a - b);
    let count = mine.length;
    for (const turn of turns) {
      if (count <= MAX_WORK) break;
      const doomed = mine.filter((p) => p.turn === turn && !p.sticky);
      if (!doomed.length) continue;
      for (const p of doomed) this.remove(p.id);
      count -= doomed.length;
    }
  }

  /**
   * The whiteboard, trimmed. Per project: twenty-four is a board a person can
   * hold in their head, and with thirteen projects a single limit across all
   * of them would mean opening one board emptied another.
   */
  private evict(project: string): void {
    const mine = () => this.pins.filter((p) => p.stream === "board" && p.project === project);
    while (mine().length > MAX_PINS) {
      // The oldest pin of whichever repo has the most, then the oldest overall.
      // Work pins are a separate budget and are never taken to make room here.
      const loose = mine().filter((p) => !p.sticky);
      if (!loose.length) return;
      const counts = new Map<string, number>();
      for (const p of loose) counts.set(p.repo, (counts.get(p.repo) ?? 0) + 1);
      const crowded = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      const victim =
        loose.find((p) => p.repo === crowded && p.answer !== null) ??
        loose.find((p) => p.repo === crowded) ??
        loose[0]!;
      this.remove(victim.id);
    }
  }
}
