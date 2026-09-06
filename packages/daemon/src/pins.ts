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
] as const;
export type PinKind = (typeof KINDS)[number];

export const MAX_PINS = 24;
export const DEFAULT_TTL_S = 900;
export const MAX_BODY = 200_000;

export interface Pin {
  id: string;
  kind: PinKind;
  title: string;
  body: string;
  repo: string;
  session: string;
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
  repo?: string | undefined;
  session?: string | undefined;
  by?: Pin["by"] | undefined;
  ttl_s?: number | undefined;
  sticky?: boolean | undefined;
  near?: string | undefined;
  size?: "normal" | "wide" | undefined;
  w?: number | undefined;
  h?: number | undefined;
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
}

let counter = 0;
function newId(): string {
  counter = (counter + 1) % 0xffff;
  return `p${Date.now().toString(36)}${counter.toString(36)}`;
}

function kindOf(kind: string | undefined): PinKind {
  return (KINDS as readonly string[]).includes(kind ?? "") ? (kind as PinKind) : "text";
}

export class Board {
  private pins: Pin[] = [];
  private waiters = new Map<string, (answer: string) => void>();
  constructor(
    private emit: (e: PinEvent) => void,
    private now: () => number = () => Date.now() / 1000,
  ) {}

  list(): Pin[] {
    this.sweep();
    return [...this.pins];
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
      repo: init.repo ?? "",
      session: init.session ?? "",
      by: init.by ?? "agent",
      created: this.now(),
      updated: this.now(),
      ttl_s: Math.max(10, Math.min(24 * 3600, init.ttl_s ?? DEFAULT_TTL_S)),
      sticky: Boolean(init.sticky),
      near: init.near ?? "",
      size: init.size === "wide" ? "wide" : "normal",
      w: Math.max(0, Math.min(4000, Number(init.w ?? 0))),
      h: Math.max(0, Math.min(4000, Number(init.h ?? 0))),
      ask: (init.ask ?? [])
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 4),
      answer: null,
      wait_s: init.wait_s ?? 0,
    };
    this.pins.push(pin);
    this.evict();
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

  /** Drop expired pins. Called on every read and on a timer. */
  sweep(): void {
    const now = this.now();
    for (const p of [...this.pins]) {
      if (!p.sticky && now - p.created > p.ttl_s) this.remove(p.id);
    }
  }

  /** For the file on disk: what survives a restart. */
  toJSON(): Pin[] {
    return this.pins.filter((p) => p.sticky || this.now() - p.created < p.ttl_s);
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
        repo: String(p.repo ?? ""),
        session: String(p.session ?? ""),
        by: p.by === "kik" || p.by === "you" ? p.by : "agent",
        created,
        updated: Number(p.updated ?? created),
        ttl_s: ttl,
        sticky: Boolean(p.sticky),
        near: typeof p.near === "string" ? p.near : "",
        size: p.size === "wide" ? "wide" : "normal",
        w: Number(p.w ?? 0) || 0,
        h: Number(p.h ?? 0) || 0,
        ask: Array.isArray(p.ask) ? p.ask.map(String) : [],
        answer: typeof p.answer === "string" ? p.answer : null,
        wait_s: Number(p.wait_s ?? 0),
      });
      n++;
    }
    return n;
  }

  private evict(): void {
    while (this.pins.length > MAX_PINS) {
      // The oldest pin of whichever repo has the most, then the oldest overall.
      const loose = this.pins.filter((p) => !p.sticky);
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
