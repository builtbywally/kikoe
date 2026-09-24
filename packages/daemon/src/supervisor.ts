/**
 * Keeps a child process up: the ear first, and later the hands.
 *
 * Until 2026-09-24 the ear's exit was recorded as "dead" and nothing else
 * happened — no restart, nothing said — so a crash ended voice input until
 * the user noticed, which on 2026-09-06 took hours. `docs/OS.md` made this
 * gate 1: before Kik may act on the machine, the thing it hears through must
 * never stay dead, and when it is gone, Kik must say so.
 *
 *  - An exit the supervisor did not ask for is a crash, whatever its code:
 *    the process is started again after 1 s, then 2, 4, 8, 16, and every
 *    30 s after that, for as long as it is wanted.
 *  - A run that lasts a minute counts as recovered: the backoff starts over.
 *  - Kik speaks twice at most per outage: once at the first loss ("I lost
 *    the mic, back in a second"), once when it keeps failing ("I can't hear
 *    you"), and once more when it is back, if it had said anything.
 */

export interface SupervisorOptions {
  /** what is being kept up, for the log and the lines Kik says */
  name: string;
  /** start the process; the caller reports its exit with `exited()` */
  start: () => void | Promise<void>;
  /** say a line aloud */
  say?: (line: string) => void;
  log?: (line: string) => void;
  /** the lines, so each thing kept up can speak in its own words */
  lines?: { lost: string; failing: string; back: string };
  /** backoff in ms, one per consecutive failure; the last repeats */
  delays?: number[];
  /** a run this long counts as recovered */
  stableMs?: number;
  /** this many failures in a row and Kik says it is failing */
  failingAfter?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => number;
}

export class Supervisor {
  private wanted = false;
  private failures = 0;
  private startedAt = 0;
  private timer: unknown = null;
  /** what Kik has said about this outage: nothing, the loss, or that it keeps failing */
  private spoken: "none" | "lost" | "failing" = "none";
  private readonly o: Required<Omit<SupervisorOptions, "say" | "log">> &
    Pick<SupervisorOptions, "say" | "log">;

  constructor(opts: SupervisorOptions) {
    this.o = {
      lines: {
        lost: `I lost the ${opts.name}. Back in a second.`,
        failing: `I can't get the ${opts.name} back. Settings, Doctor has what went wrong.`,
        back: `The ${opts.name} is back.`,
      },
      delays: [1000, 2000, 4000, 8000, 16000, 30000],
      stableMs: 60_000,
      failingAfter: 3,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
      now: () => Date.now(),
      ...opts,
    };
  }

  /** How many failures in a row, for the doctor. */
  get failing(): number {
    return this.failures;
  }

  /** Keep it up from now on, starting it now. */
  async want(): Promise<void> {
    this.wanted = true;
    this.cancel();
    await this.launch();
  }

  /** Let it go: an exit after this is not a crash, and nothing restarts it. */
  release(): void {
    this.wanted = false;
    this.cancel();
    this.failures = 0;
    this.spoken = "none";
  }

  /** The process is up and working (the ear said "ready"). */
  ready(): void {
    if (this.spoken !== "none") {
      this.o.say?.(this.o.lines.back);
      this.o.log?.(`${this.o.name}: back after ${this.failures} failure(s)`);
    }
    this.spoken = "none";
  }

  /** The process ended. If it was still wanted, that was a crash. */
  exited(code: number | null): void {
    if (!this.wanted) return;
    const ran = this.o.now() - this.startedAt;
    if (ran >= this.o.stableMs) this.failures = 0;
    this.failures++;
    const delays = this.o.delays;
    const wait = delays[Math.min(this.failures - 1, delays.length - 1)] ?? 30_000;
    this.o.log?.(
      `${this.o.name}: exited (${code}) after ${Math.round(ran / 1000)} s; failure ${this.failures}, again in ${Math.round(wait / 1000)} s`,
    );
    if (this.spoken === "none") {
      this.spoken = "lost";
      this.o.say?.(this.o.lines.lost);
    } else if (this.spoken === "lost" && this.failures >= this.o.failingAfter) {
      this.spoken = "failing";
      this.o.say?.(this.o.lines.failing);
    }
    this.cancel();
    this.timer = this.o.setTimer(() => {
      this.timer = null;
      if (this.wanted) void this.launch();
    }, wait);
  }

  private async launch(): Promise<void> {
    this.startedAt = this.o.now();
    try {
      await this.o.start();
    } catch (e) {
      this.o.log?.(`${this.o.name}: could not start: ${(e as Error).message}`);
      this.exited(null);
    }
  }

  private cancel(): void {
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
  }
}
