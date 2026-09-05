/**
 * The board: what the agent has pushed to be seen. Pins carry a kind, a
 * title, a body, a repo (their region), and a shelf life. At most a few
 * dozen live at once, the oldest of a repo goes first, and nothing
 * outlives its TTL. A pin can be a question: the `/show` request that
 * made it stays open until an answer arrives or the timeout denies it.
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
  /** seconds since epoch */
  created: number;
  ttl_s: number;
  /** the answers offered, when this pin is a question */
  ask: string[];
  answer: string | null;
  /** seconds the asker waits before a silence denies, when asking */
  wait_s: number;
}

export interface PinEvent {
  op: "add" | "answer" | "remove" | "clear";
  pin?: Pin | undefined;
  id?: string | undefined;
  answer?: string | undefined;
}

let counter = 0;
function newId(): string {
  counter = (counter + 1) % 0xffff;
  return `p${Date.now().toString(36)}${counter.toString(36)}`;
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

  add(init: {
    kind?: string | undefined;
    title?: string | undefined;
    body: string;
    repo?: string | undefined;
    session?: string | undefined;
    ttl_s?: number | undefined;
    ask?: string[] | undefined;
    wait_s?: number | undefined;
  }): Pin {
    const kind = (KINDS as readonly string[]).includes(init.kind ?? "")
      ? (init.kind as PinKind)
      : "text";
    const pin: Pin = {
      id: newId(),
      kind,
      title: (init.title ?? "").slice(0, 120),
      body: init.body.slice(0, MAX_BODY),
      repo: init.repo ?? "",
      session: init.session ?? "",
      created: this.now(),
      ttl_s: Math.max(10, Math.min(24 * 3600, init.ttl_s ?? DEFAULT_TTL_S)),
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

  clear(): number {
    const n = this.pins.length;
    for (const p of this.pins) {
      this.waiters.get(p.id)?.("");
      this.waiters.delete(p.id);
    }
    this.pins = [];
    this.emit({ op: "clear" });
    return n;
  }

  /** Drop expired pins. Called on every read and on a timer. */
  sweep(): void {
    const now = this.now();
    for (const p of [...this.pins]) {
      if (now - p.created > p.ttl_s) this.remove(p.id);
    }
  }

  private evict(): void {
    while (this.pins.length > MAX_PINS) {
      // The oldest pin of whichever repo has the most, then the oldest overall.
      const counts = new Map<string, number>();
      for (const p of this.pins) counts.set(p.repo, (counts.get(p.repo) ?? 0) + 1);
      const crowded = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      const victim =
        this.pins.find((p) => p.repo === crowded && p.answer !== null) ??
        this.pins.find((p) => p.repo === crowded) ??
        this.pins[0]!;
      this.remove(victim.id);
    }
  }
}
