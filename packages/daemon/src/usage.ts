/**
 * How much of each coding assistant's limit is gone, and when it comes back.
 *
 * The idea, and the design it is drawn in, are lifted from Codenotch
 * (github.com/vinzdg/codenotch) — a macOS notch that pins the same readings to
 * a screen edge. Two of its rules are worth keeping verbatim, because both are
 * about not lying:
 *
 *   1. Kikoe never signs in anywhere. Every reading is borrowed from a
 *      credential a tool on this machine already holds. Install Claude Code and
 *      log in, and its ring appears; do not, and there is no ring, not a zero.
 *   2. A failure degrades to a *visible status*, never to an invented number.
 *      A stale reading is shown with its age. A missing one is a dash. "0%" is
 *      a claim, and nothing here is entitled to make it.
 *
 * None of these endpoints is a published API — each is whatever the owning app
 * itself reads — so the parsers are pinned by tests and every path out of them
 * lands on a status the island can draw honestly.
 *
 * Nothing here ever logs a token.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, log } from "./config.js";
import { claudeDir } from "./hooks.js";

/** Whose number this is. `official` is the vendor's own; nothing here guesses. */
export type Fidelity = "official" | "derived";

export type UsageStatus =
  | "ok"
  /** a reading, but an old one — the fetch is failing or the token has expired */
  | "stale"
  /** no usable credential: the tool is not installed, or not signed in */
  | "absent"
  /** a credential that the endpoint rejected */
  | "needs_auth"
  /** polled too hard; waiting it out */
  | "rate_limited"
  | "error";

/** One limit and its clock. `used` is a fraction, 0..1, of the limit spent. */
export interface LimitWindow {
  id: string;
  label: string;
  used: number;
  /** epoch ms, or null when the vendor did not say */
  resets_at: number | null;
}

/** One provider's cell: everything the ring and its card need. */
export interface UsageSnapshot {
  id: string;
  name: string;
  /** which mark the ring draws; the island owns the artwork */
  glyph: string;
  fidelity: Fidelity;
  status: UsageStatus;
  windows: LimitWindow[];
  /** the window the ring itself means */
  headline: string;
  /** the plan the credential says it is on, when it says */
  plan?: string;
  /** whose credential this is, in words */
  source: string;
  /** what to do about it, when the status is not `ok` */
  message?: string;
  /** when the numbers were last actually read */
  read_at: number;
}

/** One source of readings. */
export interface UsageProvider {
  readonly id: string;
  readonly name: string;
  readonly glyph: string;
  /** Read the numbers. Throws `UsageError` for every expected failure. */
  read(fetchImpl: typeof fetch): Promise<UsageSnapshot>;
  /** Enough to draw a cell that has never succeeded. */
  blank(): UsageSnapshot;
}

export class UsageError extends Error {
  constructor(
    readonly status: Exclude<UsageStatus, "ok" | "stale">,
    message: string,
    /** seconds to wait, for `rate_limited` */
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}

// --- the colour bands -------------------------------------------------------

/**
 * Codenotch's thresholds, in Kikoe's palette.
 *
 * Its frame is a traffic light — green, yellow, orange. This island's stylesheet
 * says "paper on ink, ember as the one accent. No green.", so the same three
 * steps are drawn as quiet paper, amber, then ember. The *thresholds* are
 * Codenotch's and the colours are Kikoe's, which is the only combination that
 * keeps both promises.
 */
export type UsageBand = "ample" | "watch" | "critical" | "spent";

export function band(used: number): UsageBand {
  if (used >= 1) return "spent";
  if (used >= 0.7) return "critical";
  if (used >= 0.5) return "watch";
  return "ample";
}

// --- copy -------------------------------------------------------------------

/**
 * "resets in 51 min" under the hour, "resets Thu 12:00 am" inside the week,
 * "resets Sep 28" beyond it.
 *
 * A weekday only names a day in the coming week: a window that resets 26 days
 * out written as "resets Mon" reads as *this* Monday, which is the bug
 * Codenotch found and fixed by falling through to a date past seven days.
 */
export function resetCopy(resetsAt: number, now = Date.now()): string {
  const seconds = (resetsAt - now) / 1000;
  if (seconds <= 0) return "resetting…";

  // Rounded, not truncated, so 50m40s reads as 51. A value that rounds to 60
  // falls through, so "resets in 60 min" never appears.
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `resets in ${Math.max(1, minutes)} min`;

  const when = new Date(resetsAt);
  const days = Math.round(
    (new Date(when).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days >= 7) {
    return `resets ${when.toLocaleDateString([], { month: "short", day: "numeric" })}`;
  }
  const day = when.toLocaleDateString([], { weekday: "short" });
  const time = when
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toLowerCase()
    .replace(/\s+/g, " ");
  return `resets ${day} ${time}`;
}

/** "read 4 min ago" — the honest label on a number that is no longer fresh. */
export function ageCopy(readAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - readAt) / 60_000);
  if (!readAt) return "never read";
  if (minutes < 1) return "read just now";
  if (minutes < 60) return `read ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `read ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `read ${days} ${days === 1 ? "day" : "days"} ago`;
}

// --- Claude Code ------------------------------------------------------------

/** The bits of `~/.claude/.credentials.json` this reads. Never logged. */
interface ClaudeCredential {
  token: string;
  expiresAt: number;
  plan: string;
}

/**
 * One Claude Code configuration directory, and so one account.
 *
 * `~/.claude` by default; anyone keeping a work login apart does it with
 * `CLAUDE_CONFIG_DIR=~/.claude-work claude`, and that directory is the only
 * trace it leaves. Each gets its own ring, the default always first and the
 * rest alphabetical, so they never swap places between launches.
 */
export interface ClaudeProfile {
  slug: string | null;
  dir: string;
}

/** Files Claude Code writes on its first run against a directory. */
const PROFILE_MARKERS = [
  "sessions",
  "projects",
  "settings.json",
  "history.jsonl",
  ".credentials.json",
];

export function claudeProfiles(home = os.homedir()): ClaudeProfile[] {
  const out: ClaudeProfile[] = [{ slug: null, dir: claudeDir() }];
  let names: string[] = [];
  try {
    names = readdirSync(home);
  } catch {
    return out;
  }
  const extras: ClaudeProfile[] = [];
  for (const name of names) {
    if (!name.startsWith(".claude-")) continue;
    const slug = name.slice(".claude-".length);
    if (!slug) continue;
    const dir = path.join(home, name);
    // An empty directory, or a stray one made by hand, would otherwise put a
    // permanent "sign in" ring on the island for an account that never existed.
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!PROFILE_MARKERS.some((m) => existsSync(path.join(dir, m)))) continue;
    extras.push({ slug, dir });
  }
  extras.sort((a, b) => (a.slug! < b.slug! ? -1 : 1));
  return [...out, ...extras];
}

/**
 * The shape of `GET /api/oauth/usage` — the same endpoint Claude Code's own
 * `/usage` reads, so the two never disagree.
 *
 * `limits` is the forward-compatible form and grows new kinds as Anthropic adds
 * them, so it leads. The named windows are *merged in* rather than used only as
 * a fallback: a window whose `resets_at` has passed drops out of `limits` while
 * `five_hour` still carries it, and relying on the array alone loses the
 * session exactly at the reset — which is when someone is most likely looking.
 */
export function claudeWindows(payload: Record<string, unknown>): LimitWindow[] {
  const windows: LimitWindow[] = [];
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  for (const raw of limits) {
    const limit = raw as Record<string, unknown>;
    const resets = stamp(limit.resets_at);
    if (resets === null) continue;
    const percent = Number(limit.percent);
    if (!Number.isFinite(percent)) continue;
    const kind = String(limit.kind ?? "");
    if (!kind) continue;
    windows.push({
      id: scopedId(kind, limit.scope),
      label: claudeLabel(kind, limit.scope),
      used: percent / 100,
      resets_at: resets,
    });
  }

  const merge = (key: string, id: string, label: string) => {
    const w = payload[key] as Record<string, unknown> | null | undefined;
    if (!w || typeof w !== "object") return;
    const resets = stamp(w.resets_at);
    const utilization = Number(w.utilization);
    if (resets === null || !Number.isFinite(utilization)) return;
    if (windows.some((x) => x.id === id)) return;
    windows.push({ id, label, used: utilization / 100, resets_at: resets });
  };
  merge("five_hour", "session", "current session");
  merge("seven_day", "weekly_all", "all models");

  const rank = (id: string) => (id === "session" ? 0 : id === "weekly_all" ? 1 : 2);
  return windows.sort((a, b) => rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : 1));
}

/**
 * A scoped weekly limit is per-model, and there can be several at once, so the
 * model name has to be in the id or they collide and only one survives.
 */
function scopedId(kind: string, scope: unknown): string {
  const model = modelOf(scope);
  return model ? `${kind}:${model.toLowerCase().replace(/\s+/g, "-")}` : kind;
}

function modelOf(scope: unknown): string {
  const s = scope as { model?: { display_name?: unknown } } | null | undefined;
  const name = s?.model?.display_name;
  return typeof name === "string" ? name : "";
}

/** The wording Claude Code's own usage panel uses. */
export function claudeLabel(kind: string, scope?: unknown): string {
  const model = modelOf(scope);
  // `weekly_scoped` says nothing on its own; the scope is the whole meaning.
  if (model) return model.toLowerCase();
  switch (kind) {
    case "session":
      return "current session";
    case "weekly_all":
      return "all models";
    case "weekly_opus":
      return "opus";
    case "weekly_sonnet":
      return "sonnet";
    default:
      return kind.replace(/^weekly_/, "").replace(/_/g, " ");
  }
}

function stamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export class ClaudeUsageProvider implements UsageProvider {
  readonly id: string;
  readonly name: string;
  readonly glyph = "claude";
  private held: ClaudeCredential | null = null;
  /** set by a 429; until it passes, a poll does not touch the network */
  retryAfter = 0;
  private strikes = 0;

  constructor(private readonly profile: ClaudeProfile) {
    this.id = profile.slug ? `claude-${profile.slug}` : "claude";
    this.name = profile.slug ? `claude (${profile.slug})` : "claude";
  }

  private get source(): string {
    return this.profile.slug ? `claude code in ~/.claude-${this.profile.slug}` : "claude code";
  }

  blank(): UsageSnapshot {
    return {
      id: this.id,
      name: this.name,
      glyph: this.glyph,
      fidelity: "official",
      status: "absent",
      windows: [],
      headline: "session",
      source: this.source,
      read_at: 0,
    };
  }

  /** The OAuth token Claude Code holds. Re-read whenever the file changes. */
  private credential(): ClaudeCredential {
    const file = path.join(this.profile.dir, ".credentials.json");
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      throw new UsageError(
        "absent",
        this.profile.slug
          ? `sign in once with CLAUDE_CONFIG_DIR=~/.claude-${this.profile.slug} claude`
          : "sign in to claude code once and the ring appears",
      );
    }
    let oauth: Record<string, unknown>;
    try {
      oauth = (JSON.parse(raw).claudeAiOauth ?? {}) as Record<string, unknown>;
    } catch {
      throw new UsageError("error", "claude code's credential file could not be read");
    }
    const token = typeof oauth.accessToken === "string" ? oauth.accessToken : "";
    if (!token) throw new UsageError("absent", "claude code is not signed in");
    return {
      token,
      expiresAt: Number(oauth.expiresAt) || 0,
      plan: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : "",
    };
  }

  async read(fetchImpl: typeof fetch): Promise<UsageSnapshot> {
    if (this.retryAfter > Date.now()) {
      throw new UsageError(
        "rate_limited",
        `waiting out a rate limit, ${Math.round((this.retryAfter - Date.now()) / 1000)}s to go`,
        (this.retryAfter - Date.now()) / 1000,
      );
    }
    // Expired is not signed out. Claude Code rotates this token whenever it
    // runs and Kikoe deliberately does not — minting one would mean writing a
    // credential it does not own, and racing the owner for it. So after a
    // machine restart the token is often stale until Claude Code is next used,
    // and the honest thing is to keep the last reading with its age rather than
    // demand a sign-in nobody needs.
    if (!this.held?.token) this.held = this.credential();
    const credential = this.held;
    if (credential.expiresAt && credential.expiresAt < Date.now()) {
      this.held = null;
      throw new UsageError("needs_auth", "claude code's token has expired; run claude once");
    }

    let res: Response;
    try {
      res = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          authorization: `Bearer ${credential.token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new UsageError("error", (e as Error).message || "the usage endpoint did not answer");
    }

    if (res.status === 401 || res.status === 403) {
      // Rejected but unexpired: the held copy is wrong, which is what signing
      // into a different account looks like from here.
      this.held = null;
      throw new UsageError("needs_auth", "the saved login was refused; run claude once to refresh");
    }
    if (res.status === 429) {
      // The endpoint answers `Retry-After: 0`, which is no guidance at all, so
      // the wait doubles instead — a poll that keeps firing into a rate limit
      // is how you stay rate limited.
      const wait = backoff(this.strikes++, retryAfterSeconds(res.headers.get("retry-after")));
      this.retryAfter = Date.now() + wait * 1000;
      throw new UsageError("rate_limited", "polled too hard; backing off", wait);
    }
    if (!res.ok) throw new UsageError("error", `the usage endpoint answered ${res.status}`);

    let payload: Record<string, unknown>;
    try {
      payload = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new UsageError("error", "the usage endpoint sent something unreadable");
    }
    this.retryAfter = 0;
    this.strikes = 0;

    const windows = claudeWindows(payload);
    if (!windows.length) throw new UsageError("error", "the usage endpoint reported no limits");
    return {
      ...this.blank(),
      status: "ok",
      windows,
      plan: credential.plan,
      read_at: Date.now(),
    };
  }

  /** Drop the held token so the next poll re-reads the file. */
  forget(): void {
    this.held = null;
  }
}

// --- OpenCode ---------------------------------------------------------------

/** The account-wide Go plan windows, in headline order. */
const OPENCODE_WINDOWS: Array<[string, string]> = [
  ["rolling", "5h limit"],
  ["weekly", "weekly limit"],
  ["monthly", "monthly limit"],
];

/**
 * Parses `GET https://opencode.ai/zen/go/v1/usage`.
 *
 * `percent` is *used*, matching the dashboard's "X% used", so the ring needs no
 * inversion.
 */
export function openCodeWindows(payload: Record<string, unknown>): LimitWindow[] {
  const usage = payload.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return [];
  const out: LimitWindow[] = [];
  for (const [id, label] of OPENCODE_WINDOWS) {
    const entry = usage[id] as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== "object") continue;
    const percent = Number(entry.percent);
    if (!Number.isFinite(percent)) continue;
    out.push({ id, label, used: percent / 100, resets_at: stamp(entry.resetsAt) });
  }
  return out;
}

export class OpenCodeUsageProvider implements UsageProvider {
  readonly id = "opencode";
  readonly name = "opencode";
  readonly glyph = "opencode";

  constructor(private readonly authFile = defaultOpenCodeAuth()) {}

  blank(): UsageSnapshot {
    return {
      id: this.id,
      name: this.name,
      glyph: this.glyph,
      fidelity: "official",
      status: "absent",
      windows: [],
      headline: "rolling",
      source: "opencode",
      read_at: 0,
    };
  }

  /** The key OpenCode itself stores when a Go plan signs in. */
  private key(): string {
    let raw: string;
    try {
      raw = readFileSync(this.authFile, "utf8");
    } catch {
      throw new UsageError("absent", "opencode is not installed here");
    }
    try {
      const key = JSON.parse(raw)?.["opencode-go"]?.key;
      if (typeof key === "string" && key) return key;
    } catch {
      throw new UsageError("error", "opencode's credential file could not be read");
    }
    throw new UsageError("absent", "no opencode go plan is signed in");
  }

  async read(fetchImpl: typeof fetch): Promise<UsageSnapshot> {
    const key = this.key();
    let res: Response;
    try {
      res = await fetchImpl("https://opencode.ai/zen/go/v1/usage", {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new UsageError("error", (e as Error).message || "opencode did not answer");
    }
    if (res.status === 401 || res.status === 403)
      throw new UsageError("needs_auth", "opencode refused the saved key; sign in again");
    if (!res.ok) throw new UsageError("error", `opencode answered ${res.status}`);

    let payload: Record<string, unknown>;
    try {
      payload = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new UsageError("error", "opencode sent something unreadable");
    }
    const windows = openCodeWindows(payload);
    if (!windows.length) throw new UsageError("error", "opencode reported no limits");
    return { ...this.blank(), status: "ok", windows, read_at: Date.now() };
  }
}

function defaultOpenCodeAuth(): string {
  if (process.env.KIKOE_OPENCODE_AUTH) return process.env.KIKOE_OPENCODE_AUTH;
  const home = os.homedir();
  // Where OpenCode writes it on each platform. Both are checked because the
  // Windows build has shipped either, depending on how it was installed.
  const candidates = [
    path.join(home, ".local", "share", "opencode", "auth.json"),
    path.join(
      process.env.XDG_DATA_HOME || path.join(home, ".local", "share"),
      "opencode",
      "auth.json",
    ),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

// --- back-off ---------------------------------------------------------------

/**
 * How long to wait after a 429. The server's own hint is honoured only as a
 * floor-raiser: it answers `Retry-After: 0`, and obeying that literally means
 * retrying at once. So the wait starts at a minute and doubles, capped so it
 * always recovers on its own.
 */
export function backoff(strikes: number, retryAfter = 0): number {
  const doubled = 60 * 2 ** Math.min(strikes, 4);
  return Math.min(15 * 60, Math.max(doubled, retryAfter));
}

function retryAfterSeconds(header: string | null): number {
  if (!header) return 0;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : 0;
}

// --- the store --------------------------------------------------------------

/** How long a reading stays "ok" before it is shown as stale. */
const FRESH_MS = 12 * 60_000;

export interface UsageStoreOptions {
  fetchImpl?: typeof fetch;
  providers?: UsageProvider[];
  /** where last-good readings are kept between runs; "" to keep none */
  archive?: string;
  onChange?: (snapshots: UsageSnapshot[]) => void;
}

/**
 * Polls every provider and keeps the last good reading.
 *
 * Cadence follows the work: a minute while an agent is running, five when
 * nothing is, because the numbers only move when something is spending them.
 */
export class UsageStore {
  private providers: UsageProvider[];
  private readonly fetchImpl: typeof fetch;
  private readonly archive: string;
  private readonly onChange: (s: UsageSnapshot[]) => void;
  private snapshots = new Map<string, UsageSnapshot>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  /** whether an agent is working; the caller says so, the cadence follows */
  busy = false;
  private lastPoll = 0;

  constructor(opts: UsageStoreOptions = {}) {
    this.providers = opts.providers ?? defaultProviders();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.archive = opts.archive === undefined ? path.join(HOME, "usage.json") : opts.archive;
    this.onChange = opts.onChange ?? (() => {});
    for (const p of this.providers) this.snapshots.set(p.id, p.blank());
    this.load();
  }

  /** Every cell, in the order the island draws them. */
  list(): UsageSnapshot[] {
    const now = Date.now();
    return this.providers.map((p) => {
      const s = this.snapshots.get(p.id) ?? p.blank();
      // A reading nobody has refreshed in a while is stale whatever the last
      // fetch said. Shown dimmed, with its age, rather than hidden: an old
      // number with a date on it is worth more than no number at all.
      if (s.status === "ok" && now - s.read_at > FRESH_MS)
        return { ...s, status: "stale" as const };
      return s;
    });
  }

  /** One line per provider for the model. Empty when there is nothing to say. */
  brief(): string {
    const lines: string[] = [];
    for (const s of this.list()) {
      if (!s.windows.length) continue;
      const parts = s.windows.map(
        (w) =>
          `${w.label} ${Math.round(w.used * 100)}%${w.resets_at ? ` (${resetCopy(w.resets_at)})` : ""}`,
      );
      const age = s.status === "stale" ? `, ${ageCopy(s.read_at)}` : "";
      lines.push(`${s.name}: ${parts.join(", ")}${age}`);
    }
    return lines.join("\n");
  }

  /**
   * Change which providers are read, without losing the readings of the ones
   * that stay.
   *
   * Switching a provider off has to stop it being *read*, not merely hidden:
   * the point of the switch is that its credential is left alone. Its archived
   * reading goes with it, for the same reason.
   */
  setProviders(providers: UsageProvider[]): void {
    this.providers = providers;
    const keep = new Set(providers.map((p) => p.id));
    for (const id of [...this.snapshots.keys()]) if (!keep.has(id)) this.snapshots.delete(id);
    for (const p of providers) if (!this.snapshots.has(p.id)) this.snapshots.set(p.id, p.blank());
    this.save();
    this.onChange(this.list());
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    // Ticks often; each tick decides whether it is time yet, so a change of
    // cadence takes effect at once instead of after the old interval.
    this.timer = setInterval(() => {
      const due = this.busy ? 60_000 : 5 * 60_000;
      if (Date.now() - this.lastPoll >= due) void this.poll();
    }, 20_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Read everything now. Safe to call at any time; overlapping calls collapse. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.lastPoll = Date.now();
    try {
      await Promise.all(this.providers.map((p) => this.pollOne(p)));
    } finally {
      this.polling = false;
    }
    this.save();
    this.onChange(this.list());
  }

  private async pollOne(provider: UsageProvider): Promise<void> {
    const previous = this.snapshots.get(provider.id) ?? provider.blank();
    try {
      this.snapshots.set(provider.id, await provider.read(this.fetchImpl));
    } catch (e) {
      const failure = e instanceof UsageError ? e : new UsageError("error", (e as Error).message);
      // The last good reading survives the failure. What changes is the status
      // and the message, so the card can say what went wrong beside a number
      // it still honestly holds.
      this.snapshots.set(provider.id, {
        ...previous,
        status: previous.windows.length ? "stale" : failure.status,
        message: failure.message,
      });
      // `absent` is the ordinary state of a tool that is not installed. Logging
      // it every five minutes would bury the failures that matter.
      if (failure.status !== "absent") log(`usage: ${provider.id}: ${failure.message}`);
    }
  }

  // -- the archive ----------------------------------------------------------
  //
  // Last-good readings outlive the process, so a fresh start draws the numbers
  // it had rather than three empty rings while the first poll is in flight.

  private load(): void {
    if (!this.archive) return;
    try {
      const saved = JSON.parse(readFileSync(this.archive, "utf8")) as Record<string, UsageSnapshot>;
      for (const provider of this.providers) {
        const s = saved[provider.id];
        if (!s || !Array.isArray(s.windows) || !s.windows.length) continue;
        this.snapshots.set(provider.id, { ...provider.blank(), ...s, status: "stale" });
      }
    } catch {
      /* no archive yet, or an unreadable one: start from blank */
    }
  }

  private save(): void {
    if (!this.archive) return;
    try {
      mkdirSync(path.dirname(this.archive), { recursive: true });
      const out: Record<string, UsageSnapshot> = {};
      for (const [id, s] of this.snapshots) if (s.windows.length) out[id] = s;
      writeFileSync(this.archive, JSON.stringify(out, null, 2));
    } catch {
      /* an archive that cannot be written is not worth failing a poll over */
    }
  }
}

/**
 * Every provider whose credential this machine holds a place for.
 *
 * `KIKOE_USAGE=off` yields none, which is how the test suite guarantees it
 * never reads a real credential or calls a vendor — the same reason
 * `KIKOE_CLAUDE_DIR` exists. Set it in `vitest.config.ts`, not per file, so a
 * test written later cannot forget it.
 */
export function defaultProviders(): UsageProvider[] {
  if (process.env.KIKOE_USAGE === "off") return [];
  return [...claudeProfiles().map((p) => new ClaudeUsageProvider(p)), new OpenCodeUsageProvider()];
}
