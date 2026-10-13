/**
 * The life behind Kik (KARA-PLAN phase 4): her own to-do list, the pull
 * requests and CI that wait on the user, one inbox across the places
 * messages arrive, and the ring's night. Each part reads real data or says
 * it is not connected; nothing here invents a number.
 *
 * Tokens live beside the other keys in ~/.kikoe, one file each, never
 * printed: slack_token.txt (a user token with search:read), telegram_token.txt
 * (a bot from @BotFather), discord_token.txt (a bot with the message content
 * intent), ultrahuman_token.txt with the settings' ultrahuman_email, or
 * oura_token.txt. WhatsApp arrives through its bridge (whatsapp.ts).
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Fetch = (
  url: string,
  init?: { headers?: Record<string, string>; method?: string; body?: string },
) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

function readJson<T>(file: string | null, fallback: T): T {
  if (!file || !existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(file: string | null, value: unknown): void {
  if (!file) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  } catch {
    /* the next change writes it again */
  }
}
/** A key file's contents, trimmed, or "" when there is none. Never logged. */
export function keyFile(home: string, name: string): string {
  try {
    const f = path.join(home, name);
    return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
  } catch {
    return "";
  }
}

// --- to-dos -------------------------------------------------------------------

export interface Todo {
  id: string;
  text: string;
  created: number;
  done: number | null;
}

let todoN = 0;

/** Kik's own list: added to and ticked off by voice, shown on the desk. */
export class Todos {
  private items: Todo[];
  constructor(private readonly file: string | null) {
    this.items = readJson<Todo[]>(file, []);
  }
  list(all = false): Todo[] {
    const day = 24 * 3600_000;
    // a done item stays a day, so "what did I get done" has an answer
    return this.items.filter((t) => all || !t.done || Date.now() - t.done < day);
  }
  open(): Todo[] {
    return this.items.filter((t) => !t.done);
  }
  add(text: string): Todo {
    const t = {
      id: `t${Date.now().toString(36)}${(todoN++).toString(36)}`,
      text: text.trim().replace(/[.?!]+$/, ""),
      created: Date.now(),
      done: null,
    };
    this.items.push(t);
    writeJson(this.file, this.items);
    return t;
  }
  /** Tick off the open item that best matches what was said; null if none does. */
  done(said: string): Todo | null {
    const words = said
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);
    let best: Todo | null = null;
    let score = 0;
    for (const t of this.open()) {
      const text = t.text.toLowerCase();
      const s = words.filter((w) => text.includes(w)).length / Math.max(1, words.length);
      if (s > score) {
        score = s;
        best = t;
      }
    }
    if (!best || score < 0.5) return null;
    best.done = Date.now();
    writeJson(this.file, this.items);
    return best;
  }
  /** A sentence for the brain or the brief. */
  line(): string {
    const open = this.open();
    if (!open.length) return "The to-do list is empty.";
    return `To-do (${open.length}): ${open
      .slice(0, 8)
      .map((t) => t.text)
      .join("; ")}.`;
  }
}

/** "add buy milk to my list", "what's on my list", "cross off milk": or null. */
export function todoAsk(text: string): { op: "add" | "list" | "done"; text: string } | null {
  const t = text.trim();
  const add =
    /^(?:kik[,\s]+|kikoe[,\s]+)?(?:please\s+)?(?:add|put)\s+(.+?)\s+(?:to|on)\s+(?:my|the)\s+(?:to-?do\s+)?list\b/i.exec(
      t,
    ) ?? /^(?:kik[,\s]+)?(?:new\s+)?to-?do[:,]?\s+(.+)$/i.exec(t);
  if (add?.[1]) return { op: "add", text: add[1] };
  if (
    /\bwhat(?:'s| is)\s+on\s+my\s+(?:to-?do\s+)?list\b|\b(?:read|show)\s+(?:me\s+)?my\s+to-?dos?\b/i.test(
      t,
    )
  )
    return { op: "list", text: "" };
  const done =
    /\b(?:cross|tick|check)\s+off\s+(.+)$/i.exec(t) ??
    /\b(?:i(?:'m| am| have|'ve)?\s+)?(?:done|finished)\s+with\s+(.+)$/i.exec(t) ??
    /\bmark\s+(.+?)\s+(?:as\s+)?done\b/i.exec(t);
  if (done?.[1]) return { op: "done", text: done[1].replace(/[.?!]+$/, "") };
  return null;
}

// --- GitHub -------------------------------------------------------------------

export type Checks = "pass" | "fail" | "pending" | "none";
export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  checks?: Checks;
}
export interface GitHubState {
  at: number;
  reviews: PullRequest[];
  mine: PullRequest[];
}
export type Run = (args: string[]) => Promise<string>;

/** The `gh` CLI, already signed in on the user's machine. */
export const ghRun: Run = (args) =>
  new Promise((resolve, reject) => {
    execFile("gh", args, { windowsHide: true, timeout: 30_000 }, (err, out) =>
      err ? reject(err) : resolve(String(out)),
    );
  });

/** Pull requests that wait on the user, and the user's own with their CI. */
export class GitHubWatch {
  state: GitHubState | null = null;
  constructor(private readonly run: Run = ghRun) {}

  async refresh(): Promise<{ state: GitHubState; changes: string[] } | null> {
    try {
      const fields = "repository,title,number,url";
      const reviews = JSON.parse(
        await this.run([
          "search",
          "prs",
          "--review-requested=@me",
          "--state=open",
          "--json",
          fields,
          "--limit",
          "10",
        ]),
      ) as { repository: { nameWithOwner: string }; title: string; number: number; url: string }[];
      const mineRaw = JSON.parse(
        await this.run([
          "search",
          "prs",
          "--author=@me",
          "--state=open",
          "--json",
          fields,
          "--limit",
          "8",
        ]),
      ) as typeof reviews;
      const mine: PullRequest[] = [];
      for (const p of mineRaw.slice(0, 6)) {
        let checks: Checks = "none";
        try {
          const v = JSON.parse(
            await this.run([
              "pr",
              "view",
              String(p.number),
              "-R",
              p.repository.nameWithOwner,
              "--json",
              "statusCheckRollup",
            ]),
          ) as { statusCheckRollup?: { conclusion?: string; status?: string; state?: string }[] };
          checks = checkState(v.statusCheckRollup ?? []);
        } catch {
          /* checks unknown */
        }
        mine.push({
          repo: p.repository.nameWithOwner,
          number: p.number,
          title: p.title,
          url: p.url,
          checks,
        });
      }
      const state: GitHubState = {
        at: Date.now(),
        reviews: reviews.map((p) => ({
          repo: p.repository.nameWithOwner,
          number: p.number,
          title: p.title,
          url: p.url,
        })),
        mine,
      };
      const changes = this.state ? githubChanges(this.state, state) : [];
      this.state = state;
      return { state, changes };
    } catch {
      return null;
    }
  }

  line(): string {
    const s = this.state;
    if (!s) return "";
    const parts: string[] = [];
    if (s.reviews.length)
      parts.push(
        `${s.reviews.length} pull request${s.reviews.length === 1 ? "" : "s"} waiting on your review`,
      );
    const red = s.mine.filter((p) => p.checks === "fail");
    if (red.length)
      parts.push(`CI is red on ${red.map((p) => `${p.repo}#${p.number}`).join(", ")}`);
    return parts.length ? `GitHub: ${parts.join("; ")}.` : "GitHub: nothing waiting on you.";
  }
}

export function checkState(
  rollup: { conclusion?: string; status?: string; state?: string }[],
): Checks {
  if (!rollup.length) return "none";
  const vals = rollup.map((c) => String(c.conclusion || c.state || c.status || "").toUpperCase());
  if (vals.some((v) => /FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED/.test(v))) return "fail";
  if (vals.some((v) => /PENDING|QUEUED|IN_PROGRESS|EXPECTED|^$/.test(v))) return "pending";
  return "pass";
}

/** What changed worth saying: a new review request, CI turning red or green. */
export function githubChanges(a: GitHubState, b: GitHubState): string[] {
  const out: string[] = [];
  const had = new Set(a.reviews.map((p) => p.url));
  for (const p of b.reviews)
    if (!had.has(p.url)) out.push(`New review request: ${p.title}, in ${p.repo}.`);
  const before = new Map(a.mine.map((p) => [p.url, p.checks]));
  for (const p of b.mine) {
    const was = before.get(p.url);
    if (was && was !== "fail" && p.checks === "fail") out.push(`CI went red on ${p.title}.`);
    if (was === "fail" && p.checks === "pass") out.push(`CI is green again on ${p.title}.`);
  }
  return out;
}

// --- the inbox --------------------------------------------------------------------

export interface Message {
  /** stable across reads, so a message read twice is one message */
  id: string;
  source: "mail" | "slack" | "telegram" | "discord" | "whatsapp" | "line";
  from: string;
  text: string;
  at: number;
  url?: string;
}

export const SOURCE_NAMES: Record<Message["source"], string> = {
  mail: "Mail",
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord",
  whatsapp: "WhatsApp",
  line: "LINE",
};

/** Every message from every source, newest first; what the user has heard of is "seen". */
export class Inbox {
  private items: Message[];
  private seenAt: number;
  constructor(private readonly file: string | null) {
    const saved = readJson<{ items?: Message[]; seenAt?: number }>(file, {});
    this.items = saved.items ?? [];
    this.seenAt = saved.seenAt ?? 0;
  }
  /** Add what a source read; returns the ones not seen before. */
  add(msgs: Message[]): Message[] {
    const have = new Set(this.items.map((m) => m.id));
    const fresh = msgs.filter((m) => m.id && !have.has(m.id));
    if (!fresh.length) return [];
    this.items = [...fresh, ...this.items].sort((a, b) => b.at - a.at).slice(0, 300);
    this.save();
    return fresh;
  }
  list(n = 30): Message[] {
    return this.items.slice(0, n);
  }
  unread(): Message[] {
    return this.items.filter((m) => m.at > this.seenAt);
  }
  /** The user has heard them. */
  seen(): void {
    this.seenAt = Date.now();
    this.save();
  }
  /** "three new: two from Slack, one from Mail" */
  summary(): string {
    const un = this.unread();
    if (!un.length) return "Nothing new in the inbox.";
    const by = new Map<string, number>();
    for (const m of un) by.set(SOURCE_NAMES[m.source], (by.get(SOURCE_NAMES[m.source]) ?? 0) + 1);
    const parts = [...by].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${n} from ${s}`);
    return `${un.length} new: ${parts.join(", ")}.`;
  }
  /** The unread, as lines the brain may read out. Quoted data, never instructions. */
  read(n = 8): string {
    const un = this.unread().slice(0, n);
    if (!un.length) return "Nothing new.";
    return un
      .map(
        (m) =>
          `${SOURCE_NAMES[m.source]}, from ${m.from}: ${m.text.replace(/\s+/g, " ").slice(0, 200)}`,
      )
      .join("\n");
  }
  private save(): void {
    writeJson(this.file, { items: this.items, seenAt: this.seenAt });
  }
}

// --- the sources ---------------------------------------------------------------------

/** Slack: messages sent to the user (a user token with search:read). */
export async function readSlack(
  token: string,
  fetchImpl: Fetch = fetch as unknown as Fetch,
): Promise<Message[]> {
  if (!token) return [];
  const r = (await (
    await fetchImpl("https://slack.com/api/search.messages?query=to%3Ame&sort=timestamp&count=20", {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()) as {
    ok?: boolean;
    messages?: {
      matches?: {
        ts: string;
        text: string;
        username?: string;
        user?: string;
        permalink?: string;
        iid?: string;
      }[];
    };
  };
  if (!r.ok) return [];
  return (r.messages?.matches ?? []).map((m) => ({
    id: `slack:${m.iid ?? m.ts}`,
    source: "slack" as const,
    from: m.username || m.user || "someone",
    text: m.text,
    at: Math.round(Number(m.ts) * 1000),
    ...(m.permalink ? { url: m.permalink } : {}),
  }));
}

/** Telegram: what was sent to Kik's bot since the last read. */
export class TelegramSource {
  private offset = 0;
  constructor(
    private readonly token: () => string,
    private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
  ) {}
  async read(): Promise<Message[]> {
    const token = this.token();
    if (!token) return [];
    const r = (await (
      await this.fetchImpl(
        `https://api.telegram.org/bot${token}/getUpdates?timeout=0&offset=${this.offset}`,
      )
    ).json()) as {
      ok?: boolean;
      result?: {
        update_id: number;
        message?: {
          message_id: number;
          date: number;
          text?: string;
          caption?: string;
          from?: { first_name?: string; username?: string };
          chat?: { id: number; title?: string };
        };
      }[];
    };
    if (!r.ok) return [];
    const out: Message[] = [];
    for (const u of r.result ?? []) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      const m = u.message;
      if (!m) continue;
      out.push({
        id: `telegram:${m.chat?.id}:${m.message_id}`,
        source: "telegram",
        from: m.from?.first_name || m.from?.username || m.chat?.title || "someone",
        text: m.text || m.caption || "(a message without text)",
        at: m.date * 1000,
      });
    }
    return out;
  }
}

/**
 * Discord: direct messages to Kik's bot and mentions of it, live over the
 * gateway (node's own WebSocket). Reconnects with backoff.
 */
export class DiscordSource {
  private ws: WebSocket | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private seq: number | null = null;
  private me = "";
  private backoff = 5_000;
  private stopped = false;
  constructor(
    private readonly token: () => string,
    private readonly onMessage: (m: Message) => void,
    private readonly log: (s: string) => void = () => {},
  ) {}
  start(): void {
    const token = this.token();
    if (!token || this.ws || this.stopped || typeof WebSocket === "undefined") return;
    const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
    this.ws = ws;
    ws.onmessage = (ev) => {
      let p: { op: number; d: any; s: number | null; t: string | null };
      try {
        p = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (p.s != null) this.seq = p.s;
      if (p.op === 10) {
        this.beat = setInterval(
          () => ws.send(JSON.stringify({ op: 1, d: this.seq })),
          p.d.heartbeat_interval,
        );
        // guild messages, direct messages, message content
        ws.send(
          JSON.stringify({
            op: 2,
            d: {
              token,
              intents: (1 << 9) | (1 << 12) | (1 << 15),
              properties: { os: "windows", browser: "kikoe", device: "kikoe" },
            },
          }),
        );
      } else if (p.op === 0 && p.t === "READY") {
        this.me = p.d.user?.id ?? "";
        this.backoff = 5_000;
        this.log("discord: connected");
      } else if (p.op === 0 && p.t === "MESSAGE_CREATE") {
        const d = p.d;
        if (d.author?.id === this.me || d.author?.bot) return;
        const direct = !d.guild_id;
        const mentioned = (d.mentions ?? []).some((u: { id: string }) => u.id === this.me);
        if (!direct && !mentioned) return;
        this.onMessage({
          id: `discord:${d.id}`,
          source: "discord",
          from: d.author?.global_name || d.author?.username || "someone",
          text: d.content || "(an attachment)",
          at: Date.parse(d.timestamp) || Date.now(),
        });
      }
    };
    ws.onclose = () => {
      if (this.beat) clearInterval(this.beat);
      this.beat = null;
      this.ws = null;
      if (this.stopped) return;
      setTimeout(() => this.start(), this.backoff).unref?.();
      this.backoff = Math.min(this.backoff * 2, 10 * 60_000);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }
  stop(): void {
    this.stopped = true;
    if (this.beat) clearInterval(this.beat);
    this.ws?.close();
  }
}

/**
 * Mail, as the desk session reads it from the user's Gmail (one JSON object
 * a line). Malformed lines are dropped rather than guessed at.
 */
export function parseMailLines(text: string): Message[] {
  const out: Message[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    try {
      const m = JSON.parse(l) as {
        id?: string;
        from?: string;
        subject?: string;
        snippet?: string;
        at?: string;
      };
      if (!m.from || !m.subject) continue;
      const at = Date.parse(m.at ?? "") || Date.now();
      out.push({
        id: `mail:${m.id || `${m.from}|${m.subject}|${m.at}`}`,
        source: "mail",
        from: m.from.replace(/\s*<[^>]+>/, ""),
        text: m.snippet ? `${m.subject}: ${m.snippet}` : m.subject,
        at,
      });
    } catch {
      /* not a message */
    }
  }
  return out;
}

export const MAIL_PROMPT =
  'Read my Gmail inbox: unread messages from the last 24 hours, at most 15, newest first. Answer with one JSON object per line and nothing else: {"id": "<message id>", "from": "<sender name>", "subject": "<subject>", "snippet": "<first 100 characters>", "at": "<ISO time>"}. Read only; mark nothing read, change nothing. If Gmail cannot be reached, answer exactly: unavailable';

// --- health ------------------------------------------------------------------------------

export interface Night {
  source: "ultrahuman" | "oura";
  date: string;
  sleepScore: number | null;
  sleepMinutes: number | null;
  hrv: number | null;
  restingHr: number | null;
  steps: number | null;
  recovery: number | null;
}

/** The ring's last night and today so far: Ultrahuman's partner API, or Oura's v2. */
export async function readHealth(
  opts: { ultrahumanToken: string; ultrahumanEmail: string; ouraToken: string },
  fetchImpl: Fetch = fetch as unknown as Fetch,
  today = new Date(),
): Promise<Night | null> {
  const date = today.toISOString().slice(0, 10);
  if (opts.ultrahumanToken && opts.ultrahumanEmail) {
    const r = (await (
      await fetchImpl(
        `https://partner.ultrahuman.com/api/v1/metrics?email=${encodeURIComponent(opts.ultrahumanEmail)}&date=${date}`,
        { headers: { authorization: opts.ultrahumanToken } },
      )
    ).json()) as { data?: { metric_data?: { type: string; object?: Record<string, any> }[] } };
    const m = new Map((r.data?.metric_data ?? []).map((x) => [x.type, x.object ?? {}]));
    const sleep = m.get("Sleep") ?? m.get("sleep") ?? {};
    const num = (v: unknown) =>
      typeof v === "number" ? v : typeof v === "string" && v ? Number(v) : null;
    return {
      source: "ultrahuman",
      date,
      sleepScore: num(sleep.sleep_score?.value ?? sleep.score),
      sleepMinutes: num(sleep.total_sleep?.value ?? sleep.total_sleep_minutes),
      hrv: num(m.get("hrv")?.avg ?? m.get("avg_sleep_hrv")?.value),
      restingHr: num(m.get("night_rhr")?.avg ?? m.get("night_rhr")?.value),
      steps: num(m.get("steps")?.total ?? m.get("steps")?.value),
      recovery: num(m.get("recovery_index")?.value),
    };
  }
  if (opts.ouraToken) {
    const auth = { authorization: `Bearer ${opts.ouraToken}` };
    const get = async (what: string) =>
      (
        (await (
          await fetchImpl(
            `https://api.ouraring.com/v2/usercollection/${what}?start_date=${date}&end_date=${date}`,
            { headers: auth },
          )
        ).json()) as { data?: Record<string, any>[] }
      ).data?.[0] ?? {};
    const [sleep, readiness, activity] = await Promise.all([
      get("daily_sleep"),
      get("daily_readiness"),
      get("daily_activity"),
    ]);
    return {
      source: "oura",
      date,
      sleepScore: sleep.score ?? null,
      sleepMinutes: null,
      hrv: readiness.contributors?.hrv_balance ?? null,
      restingHr: readiness.contributors?.resting_heart_rate ?? null,
      steps: activity.steps ?? null,
      recovery: readiness.score ?? null,
    };
  }
  return null;
}

export function healthLine(n: Night | null): string {
  if (!n) return "";
  const parts: string[] = [];
  if (n.sleepScore != null) parts.push(`sleep score ${Math.round(n.sleepScore)}`);
  if (n.sleepMinutes != null)
    parts.push(`${Math.floor(n.sleepMinutes / 60)}h ${Math.round(n.sleepMinutes % 60)}m asleep`);
  if (n.hrv != null) parts.push(`HRV ${Math.round(n.hrv)}`);
  if (n.recovery != null) parts.push(`recovery ${Math.round(n.recovery)}`);
  if (n.steps != null) parts.push(`${n.steps} steps so far`);
  return parts.length ? `The ring: ${parts.join(", ")}.` : "";
}
