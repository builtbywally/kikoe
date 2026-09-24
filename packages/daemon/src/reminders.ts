/**
 * Reminders and timers: what makes Kik an assistant and not only a
 * switchboard (docs/REQUESTS.md, slice 5).
 *
 * A reminder is a sentence and a moment. They are kept in a file in
 * ~/.kikoe, so a restart loses none, and checked on a short tick; one that
 * came due while Kikoe was closed is said when it opens, marked late. What
 * happens when one is due (said, pinned, sent to the phone) is the daemon's.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Reminder {
  id: string;
  /** what to say: "call the printer", "the tea" */
  text: string;
  /** when, in ms since epoch */
  at: number;
  created: number;
  /** a timer ("in 5 minutes") rather than a reminder for a time of day */
  timer: boolean;
}

let n = 0;

export class Reminders {
  private items: Reminder[] = [];
  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Reminder[];
        if (Array.isArray(raw)) this.items = raw.filter((r) => r?.text && r.at);
      } catch {
        /* a broken file is an empty list, not a crash */
      }
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.items, null, 2));
    } catch {
      /* the list still works in memory */
    }
  }

  add(text: string, at: number, timer = false): Reminder {
    n = (n + 1) % 0xffff;
    const r: Reminder = {
      id: `rem-${this.now().toString(36)}${n.toString(36)}`,
      text: text.trim().slice(0, 300) || (timer ? "time's up" : "a reminder"),
      at,
      created: this.now(),
      timer,
    };
    this.items.push(r);
    this.items.sort((a, b) => a.at - b.at);
    this.save();
    return r;
  }

  list(): Reminder[] {
    return [...this.items];
  }

  /** Take one off; "" or an unknown id cancels nothing. A word matches its text. */
  cancel(idOrText: string): Reminder | undefined {
    const key = idOrText.trim().toLowerCase();
    if (!key) return undefined;
    const i = this.items.findIndex((r) => r.id === idOrText || r.text.toLowerCase().includes(key));
    if (i < 0) return undefined;
    const [r] = this.items.splice(i, 1);
    this.save();
    return r;
  }

  /** The ones due now, taken off the list. */
  due(): Reminder[] {
    const now = this.now();
    const out = this.items.filter((r) => r.at <= now);
    if (!out.length) return [];
    this.items = this.items.filter((r) => r.at > now);
    this.save();
    return out;
  }
}

const UNIT: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
};
const WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  "forty-five": 45,
  fifty: 50,
  sixty: 60,
  ninety: 90,
  half: 0.5,
};

/** "5 minutes", "an hour", "half an hour", "90 seconds": a length in ms, or 0. */
export function duration(text: string): number {
  const t = text.toLowerCase();
  if (/\bhalf an? hour\b/.test(t)) return 1_800_000;
  if (/\ban? hour and a half\b/.test(t)) return 5_400_000;
  const m =
    /\b(\d+(?:\.\d+)?|[a-z]+(?:-[a-z]+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|h|m|s)\b/.exec(
      t,
    );
  if (!m) return 0;
  const count = Number.isFinite(Number(m[1])) ? Number(m[1]) : (WORDS[m[1] ?? ""] ?? 0);
  return Math.round(count * (UNIT[m[2] ?? ""] ?? 0));
}

/**
 * "at 5", "at 5:30 pm", "at 17:00": the next such moment from now, in ms, or
 * 0. A bare hour under 8 without am/pm is taken as the afternoon: nobody
 * sets a reminder for 3 in the morning by saying "at 3".
 */
export function clockTime(text: string, now: number = Date.now()): number {
  const m = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i.exec(text);
  if (!m) return 0;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = (m[3] ?? "").toLowerCase().replace(/\./g, "");
  if (h > 23 || min > 59) return 0;
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (!ap && h < 8) h += 12;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** How a moment reads aloud, relative to now: "in 5 minutes", "at 17:30". */
export function whenSaid(at: number, now: number = Date.now()): string {
  const ms = at - now;
  if (ms < 90_000) return `in ${Math.max(1, Math.round(ms / 1000))} seconds`;
  if (ms < 90 * 60_000) return `in ${Math.round(ms / 60_000)} minutes`;
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return new Date(now).toDateString() === d.toDateString() ? `at ${hm}` : `tomorrow at ${hm}`;
}
