/**
 * The daemon: one long-lived process per machine.
 *
 *   hook payload  ─▶ adapter ─▶ tracker ─▶ narrator ─▶ arbiter ─▶ ladder ─▶ speaker
 *                                   └──────────── hub ────────────▶ island, app
 *
 * Loopback-bound with a bearer token. It can speak and it can approve tool
 * calls, so it is never exposed on a network interface.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  Arbiter,
  ClaudeCodeAdapter,
  DEFAULT_ALIASES,
  Narrator,
  type SpeechInfo,
  type SpeechPhase,
  type SpeechSink,
  Tracker,
  type Utterance,
  diagramToSvg,
  events as ev,
  gate,
  headAnswer,
  headSocial,
  route,
  utterance,
} from "@kikoe/core";
import { Brain, type BrainTool, PERSONA } from "./brain.js";
import {
  HOME,
  LOGS,
  type Settings,
  daemonToken,
  ensureHome,
  loadSettings,
  log,
  viewerToken,
} from "./config.js";
import { Hub } from "./hub.js";
import { KIT_GUIDE, withKit } from "./kit.js";
import { Board } from "./pins.js";
import { ARTIFACT_CSP, DESIGN_BRIEF, renderArtifact, stripFences } from "./runtime.js";
import { type Earcon, NullSpeaker, RtAudioSpeaker, type Speaker, earcon } from "./speaker.js";
import { Ladder, type VoiceHint, loadedEngines, unloadIdleEngines } from "./tts.js";

const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const HISTORY = 50;
const LATENCY_WINDOW = 100;
/** A self-spoken line silences the Stop hook's summary for this long. */
export const SELF_SPOKEN_WINDOW_S = 30;

function readTranscript(p: string): string | undefined {
  try {
    if (!existsSync(p) || statSync(p).size > MAX_TRANSCRIPT_BYTES) return undefined;
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/** Walk up from cwd to the nearest .git for a repo name. */
function repoOf(cwd: string): string {
  let dir = cwd;
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, ".git"))) return path.basename(dir);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.basename(cwd);
}

/**
 * A pending permission: the hook is blocked in `curl`, waiting on this
 * response. A spoken yes releases it; no, silence and timeout all deny.
 * Denial means an empty body, so Claude Code falls back to its own prompt.
 */
interface PendingPermission {
  id: string;
  session: string;
  repo: string;
  text: string;
  res: http.ServerResponse;
  timer: NodeJS.Timeout;
}

export interface SpokenRecord {
  ts: number;
  text: string;
  backend: string;
  ttfa_ms: number;
  audio_s: number;
  session: string;
  label: string;
  priority: number;
  /** event receipt to first sound, when the line came from an event */
  latency_ms: number | null;
}

/** after an exchange, how long the next thing said is for us without the name */
const ATTENTION_MS = 20_000;
/** away this long, and the next thing the user says is a return */
const AWAY_MS = 3600_000;
/** the user putting Kik right; the reply takes it and the note records it */
const CORRECTION =
  /^(no|nope|wrong|thats wrong|that is wrong|not that|not what i|i said|i didnt say|i did not say|i meant|you misheard|you got that wrong|thats not)\b/;
/** what Kik says while the model is still thinking */
const FILLERS = ["Hm.", "One sec.", "Let me look.", "Mm."];

/** The local calendar day of a timestamp, as YYYY-MM-DD. */
export function dayOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "forty minutes", "three hours", "a night", "two days" */
export function describeGap(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 90) return `${min} minutes`;
  const h = Math.round(ms / 3600_000);
  if (h < 20) return `${h} hours`;
  const d = Math.round(ms / 86_400_000);
  return d <= 1 ? "a night" : `${d} days`;
}

export interface DaemonOptions {
  settings?: Settings;
  /** the Room renderer directory, served at /room for a browser on a tunnel */
  roomDir?: string;
  audio?: boolean;
  elevenKey?: string;
  anthropicKey?: string;
  /** for tests: the fetch the brain uses */
  fetchImpl?: typeof fetch;
  /** keep sticky pins in ~/.kikoe/board.json (off for smoke and screenshot runs) */
  persistBoard?: boolean;
  onSpeech?: (phase: SpeechPhase, info: SpeechInfo) => void;
  /** how long after an exchange the inner note is rewritten (tests shorten it) */
  reflectMs?: number;
  /** how long the model may take before Kik says "hm" (tests shorten it) */
  fillerMs?: number;
}

/**
 * The mouth: picks a voice for the line, plays a cue if the settings ask for
 * one, streams the line through the ladder, and waits for the speaker to go
 * quiet so the arbiter's ordering stays honest.
 */
class LadderSink implements SpeechSink {
  constructor(private d: Daemon) {}

  private cueFor(u: Utterance | undefined): Earcon | null {
    const mode = this.d.settings.earcons;
    if (!u || mode === "off") return null;
    if (u.dedupe.startsWith("perm:")) return "question";
    if (u.dedupe.startsWith("err:") || u.priority >= ev.SEV_CRITICAL) return "error";
    if (u.dedupe.startsWith("done:") || u.dedupe.startsWith("end:")) return "done";
    return null;
  }

  async speak(text: string, signal: AbortSignal, u?: Utterance): Promise<void> {
    const speaker = this.d.speaker;
    const mode = this.d.settings.earcons;
    // "replace": progress chatter becomes a tick instead of words.
    if (u && mode === "replace" && u.priority <= ev.SEV_PROGRESS) {
      speaker.push(earcon("tick", speaker.rate), speaker.rate);
      speaker.flush();
      await speaker.quiet();
      return;
    }
    const cue = this.cueFor(u);
    if (cue) {
      speaker.push(earcon(cue, speaker.rate), speaker.rate);
      speaker.flush();
    }
    const hint: VoiceHint = u ? this.d.voiceFor(u.label) : {};
    const start = Date.now();
    this.d.markSpeaking(text);
    const res = await this.d.ladder.speak(text, speaker, signal, hint);
    this.d.recordSpoken(text, res, u, start);
    await speaker.quiet();
  }
}

export class Daemon {
  settings: Settings;
  readonly token: string;
  readonly viewer: string;
  readonly hub = new Hub();
  readonly tracker = new Tracker();
  readonly narrator: Narrator;
  readonly arbiter: Arbiter;
  ladder: Ladder;
  readonly speaker: Speaker;
  readonly adapter: ClaudeCodeAdapter;
  readonly history: SpokenRecord[] = [];
  readonly board: Board;
  private lastSpokeRepo = "";
  private lastSpoken: { text: string; at: number } | null = null;
  private lastRepeatable = "";
  micPhase = "off";
  /** until when an utterance without the name still counts as for us */
  private attentionUntil = 0;
  private anthropicKey = "";
  private readonly fetchImpl: typeof fetch;
  private brainCache: Brain | null = null;
  private checkinTimer: NodeJS.Timeout | null = null;
  /** what the user said for an agent, by voice, waiting for its turn to end */
  readonly instructions: Array<{ repo: string; text: string; at: number }> = [];
  micDevice = "";
  readonly heardLog: Array<{
    ts: number;
    text: string;
    kind: string;
    intent: string;
    said: string;
    stt_ms: number | null;
    /** word count; the only thing kept of an utterance that was not for us */
    words: number;
  }> = [];
  private readonly roomDir: string;
  private latencies: number[] = [];
  private server: http.Server | null = null;
  private pending: PendingPermission | null = null;
  private lastPermissionId = "";
  private startedAt = Date.now();
  private timers: NodeJS.Timeout[] = [];
  private agentSpokeAt = 0;
  eventsSeen = 0;
  /** when the user was last here and last greeted; on disk so a restart keeps it */
  presence = { seen: 0, greeted: 0 };
  private presenceTimer: NodeJS.Timeout | null = null;
  /** the user just came back and this is the first thing they said; the reply says hello */
  private returned: { after: number; at: number } | null = null;
  /** Kik's private inner note: what it thinks is going on. Never spoken. */
  private innerNote = "";
  private reflectTimer: NodeJS.Timeout | null = null;
  private reflectedAt = 0;
  private reflecting = false;
  private readonly reflectMs: number;
  private readonly fillerMs: number;
  private lastFiller = "";
  /** the user is correcting Kik; the next reply takes it, the inner note records it */
  private corrected = 0;
  private consolidatedAt = 0;
  private consolidating = false;
  /** the watchers' bookkeeping: since when a session has been waiting or red, what was already said */
  private waitingSince = new Map<string, number>();
  private redSince = new Map<string, number>();
  private concernsSaid: string[] = [];
  /** timestamps of failures in the last hour; the register reads them */
  private recentFailures: number[] = [];
  private greenAt = 0;

  constructor(opts: DaemonOptions = {}) {
    this.anthropicKey = opts.anthropicKey ?? "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.checkinTimer = setInterval(() => {
      this.watch();
      void this.checkIn();
      void this.consolidateMaybe();
    }, 60_000);
    this.checkinTimer.unref();
    ensureHome();
    this.settings = opts.settings ?? loadSettings();
    this.roomDir = opts.roomDir ?? "";
    this.token = daemonToken();
    this.viewer = viewerToken();
    ev.setRepoResolver(repoOf);
    this.narrator = new Narrator({ mode: this.settings.narrate });
    this.adapter = new ClaudeCodeAdapter({ readTranscript });
    this.speaker = opts.audio === false ? new NullSpeaker() : safeSpeaker();
    this.ladder = new Ladder({
      settings: this.settings,
      ...(opts.elevenKey ? { elevenKey: opts.elevenKey } : {}),
    });
    this.persistBoard = opts.persistBoard !== false;
    this.reflectMs = opts.reflectMs ?? 5000;
    this.fillerMs = opts.fillerMs ?? 1500;
    if (this.persistBoard) {
      this.presence = this.presenceFromDisk();
      this.innerNote = this.innerFromDisk();
    }
    this.board = new Board((e) => {
      this.hub.publish("pin", { ...e });
      if (this.persistBoard) this.saveBoardSoon();
    });
    if (this.persistBoard) this.loadBoard();
    this.arbiter = new Arbiter(new LadderSink(this), {
      onSpeech: (phase, info) => {
        this.hub.publish("speech", { phase, ...info });
        opts.onSpeech?.(phase, info);
      },
      permissions: {
        blocks: (id) => this.pending !== null && this.pending.id !== id,
        bind: (id) => {
          this.lastPermissionId = id;
        },
      },
    });
  }

  /** The line about to play. The ear uses it to ignore its own echo. */
  markSpeaking(text: string): void {
    this.lastSpoken = { text, at: Date.now() };
  }

  // -- voices ----------------------------------------------------------------

  /** The voice a repo speaks in, if the settings assign one. */
  voiceFor(label: string): VoiceHint {
    const v = this.settings.voices?.[label];
    if (!v) return {};
    const hint: VoiceHint = {};
    if (v.backend) hint.backend = v.backend;
    if (v.voice) hint.voice = v.voice;
    return hint;
  }

  // -- events ----------------------------------------------------------------

  /** One agent event through the whole pipe. Returns how many lines were queued. */
  ingest(e: ev.AgentEvent): number {
    this.eventsSeen++;
    this.tracker.apply(e);
    // Hooks mean the user is at the desk driving agents, even if silent.
    this.presence.seen = Date.now();
    this.savePresenceSoon();
    if (e.kind === ev.TURN_END || e.kind === ev.ERROR) this.reflectSoon();
    if (e.kind === ev.ERROR || (e.kind === ev.TOOL_END && e.status === "error")) {
      const now = Date.now();
      this.recentFailures = [...this.recentFailures.filter((t) => now - t < 3600_000), now];
    }
    if (e.kind === ev.TOOL_END && this.redSince.has(e.session)) {
      const verdict = this.tracker.sessions.get(e.session)?.lastTestResult ?? "";
      if (verdict && !/[1-9]\d* failed/.test(verdict)) this.greenAt = Date.now();
    }
    let lines = this.narrator.narrate(e);
    // Claude spoke for itself this turn; the hook's summary would say it twice.
    if (e.kind === ev.TURN_END && Date.now() / 1000 - this.agentSpokeAt < SELF_SPOKEN_WINDOW_S) {
      lines = lines.filter((u) => !(u.dedupe.startsWith("done:") || u.dedupe.startsWith("end:")));
    }
    // A model in the head phrases what is worth saying, in its own words.
    // Permissions stay stock: they must be instant.
    if (lines.length && this.settings.brain_narrates && this.brain() && this.brainSpeaksFor(e)) {
      void this.brainNarrate(e, lines);
      lines = [];
    }
    const queued = this.arbiter.submitAll(lines);
    this.hub.publish("event", {
      kind: e.kind,
      source: e.source,
      tool: e.tool,
      severity: e.severity,
      status: e.status,
      repo: e.repo,
      session: e.session,
      text: (e.text ?? "").slice(0, 400),
      ts: e.ts,
      args: displayArgs(e),
    });
    this.hub.publish("sessions", {
      sessions: this.tracker.snapshot(),
      brief: this.tracker.brief(),
    });
    return queued;
  }

  hook(payload: Record<string, unknown>): ev.AgentEvent | null {
    const e = this.adapter.ingestHook(payload);
    if (e) this.ingest(e);
    return e;
  }

  say(text: string, priority = ev.SEV_MILESTONE, source = "manual"): void {
    if (source === "agent") this.agentSpokeAt = Date.now() / 1000;
    this.arbiter.submit(
      utterance(text, {
        priority,
        preempt: priority >= ev.SEV_ATTENTION,
        label: source === "agent" ? "" : "",
        dedupe: source === "agent" ? "agent:" : "",
      }),
    );
  }

  interrupt(): void {
    this.arbiter.interrupt();
    this.speaker.drop();
  }

  setMode(mode: string): void {
    this.narrator.setMode(mode);
    this.hub.publish("mode", { mode: this.narrator.mode });
  }

  /**
   * A voice change swaps the ladder and nothing else: the server stays up,
   * the tracker keeps its sessions, the arbiter keeps its counts.
   */
  reconfigure(settings: Settings, elevenKey?: string, anthropicKey?: string): void {
    if (anthropicKey !== undefined) this.anthropicKey = anthropicKey;
    this.brainCache = null;
    this.interrupt();
    const old = this.ladder;
    this.settings = settings;
    this.ladder = new Ladder({ settings, ...(elevenKey ? { elevenKey } : {}) });
    old.close();
    this.narrator.setMode(settings.narrate);
    this.hub.publish("tts", { ladder: this.ladder.names, strict: this.ladder.strict });
    this.hub.publish("look", this.look());
  }

  /** The canvas backdrop, as the Room needs it. */
  look(): { backdrop: string; dim: number; blur: boolean; image: string } {
    const s = this.settings;
    return {
      backdrop: s.backdrop || "grid",
      dim: Math.max(0, Math.min(0.9, Number(s.backdrop_dim ?? 0.35))),
      blur: s.backdrop_blur !== false,
      image:
        s.backdrop === "custom" && s.backdrop_image && existsSync(s.backdrop_image)
          ? s.backdrop_image
          : "",
    };
  }

  /**
   * Answer the permission question that was last read out. Only that one:
   * two agents asking seconds apart and one "yes" is the disaster class.
   */
  answerPermission(allow: boolean, id?: string): boolean {
    const p = this.pending;
    if (!p) return false;
    if (id && id !== p.id) return false;
    if (!id && this.lastPermissionId && this.lastPermissionId !== p.id) return false;
    clearTimeout(p.timer);
    this.pending = null;
    const body = allow
      ? JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: "allow",
            decisionReason: "approved by voice",
          },
        })
      : "";
    p.res.writeHead(200, { "content-type": "application/json" });
    p.res.end(body);
    this.hub.publish("permission", { id: p.id, session: p.session, allow });
    log(`permission ${p.id} ${allow ? "allowed" : "denied"} (${p.repo})`);
    return true;
  }

  /**
   * A bare yes or no from the user goes to whatever is being asked: a
   * permission first, since a real agent's prompt always outranks a pin.
   */
  answerWord(word: string): "permission" | "pin" | null {
    const w = word.trim().toLowerCase();
    if (this.pending) {
      const yes = ["yes", "yeah", "yep", "ok", "okay", "do it", "go ahead", "allow"].includes(w);
      const no = ["no", "nope", "deny", "don't", "cancel"].includes(w);
      if (yes || no) {
        this.answerPermission(yes);
        return "permission";
      }
    }
    if (this.board.asking() && this.board.answerCurrent(w)) return "pin";
    return null;
  }

  // -- the ear -------------------------------------------------------------------

  /**
   * Something the user said, transcribed. Routed the three ways: control
   * never reaches an agent, a question is answered from the board, an
   * answer releases what is waiting. Everything not addressed is overheard
   * and dropped, and the island is told so, because that judgement is what
   * makes an open mic trustworthy.
   */
  hear(
    text: string,
    meta: { dur_s?: number; stt_ms?: number } = {},
    opts: { force?: boolean; decided?: boolean } = {},
  ): { kind: string; intent: string; said?: string } {
    const clean = text.trim();
    // Half duplex: while the speaker plays, and for a moment after, the mic
    // hears the speaker. A transcript that echoes our own line is dropped.
    const recently =
      this.lastSpoken !== null &&
      (this.arbiter.pending() || Date.now() - this.lastSpoken.at < 4000);
    const words = clean.split(/\s+/).filter(Boolean).length;
    if (recently && this.lastSpoken && similar(clean, this.lastSpoken.text)) {
      this.hub.publish("mic", { phase: "overheard", why: "self" });
      return { kind: "self", intent: "" };
    }
    const awaiting = this.pending !== null || this.board.asking() !== undefined;
    const offered = this.board.asking()?.ask ?? [];
    const aliases = [...new Set([this.settings.wake_name, ...DEFAULT_ALIASES])];
    const attending = Date.now() < this.attentionUntil || opts.force === true;
    const d = route(clean, {
      aliases,
      awaitingAnswer: awaiting,
      offered,
      attending,
      youQuestions: this.settings.hear_you !== false,
    });
    if (d.addressed) this.attentionUntil = 0;
    // The name on its own opens the window: "kikoe" ... "what's it doing".
    if (d.kind === "social" && d.intent === "hello" && !d.text) this.openWindow(clean, "");
    // What was not addressed to us is dropped here, whole. Not the log file,
    // not the heard list, not the stream: a word count is all that survives,
    // because an open mic in a room is only acceptable on those terms.
    const addressed = d.kind !== "overheard" && d.kind !== "empty";
    // hear_debug is the one exception, and it says so in every line it keeps.
    const keep = addressed || this.settings.hear_debug;
    const timing = `${meta.dur_s ?? "?"}s, stt ${meta.stt_ms ?? "?"} ms`;
    if (addressed)
      log(
        `heard "${clean}" -> ${d.kind}${d.intent ? ":" + d.intent : ""}${d.arg ? " " + d.arg : ""} (${timing})`,
      );
    else if (keep) log(`heard (debug) "${clean}" -> not for me (${timing})`);
    else log(`heard: not for me, ${words} words, dropped (${timing})`);

    const record = (kind: string, intent: string, said = "") => {
      const text = keep ? clean : "";
      this.heardLog.push({
        ts: Date.now() / 1000,
        text,
        kind,
        intent,
        said,
        stt_ms: meta.stt_ms ?? null,
        words,
      });
      if (this.heardLog.length > 30) this.heardLog.shift();
      this.hub.publish("heard", { text, kind, intent, said, words });
    };
    if (d.kind === "empty") return { kind: d.kind, intent: "" };
    if (d.kind === "overheard" && !opts.decided && this.grayZone()) {
      void this.decideDirected(clean, meta);
      return { kind: "deciding", intent: "" };
    }
    this.arrived(addressed);
    // Barge-in by words: talking to Kik while it talks stops it. This works
    // through speakers too, because its own echo was dropped above.
    if (addressed && d.kind !== "control" && this.arbiter.pending()) {
      log("barge-in: you spoke to Kik over it, Kik stopped");
      this.interrupt();
    }
    if (d.kind === "overheard") {
      record("overheard", "");
      this.hub.publish("mic", { phase: "overheard", words });
      this.hub.publish("mic", { phase: "idle" });
      return { kind: d.kind, intent: "" };
    }
    this.hub.publish("mic", { phase: "addressed", text: clean });

    if (
      (d.kind === "question" || d.kind === "social" || d.kind === "work") &&
      this.brain() !== null
    ) {
      this.hub.publish("mic", { phase: "thinking", text: clean });
      void this.converse(clean, d.kind, d.intent, record);
      return { kind: "chat", intent: d.kind };
    }

    let said: string | undefined;
    switch (d.kind) {
      case "control":
        said = this.control(d.intent, d.arg);
        break;
      case "answer": {
        const to = this.answerWord(d.intent);
        said = to ? undefined : "Nothing's waiting on an answer.";
        break;
      }
      case "question":
        said = headAnswer(d.text, Object.values(this.tracker.snapshot()));
        break;
      case "social":
        said = headSocial(d.intent);
        break;
      case "work":
        said = "I can't take instructions yet. Say it to the terminal.";
        break;
    }
    record(d.kind, d.intent, said ?? "");
    // After an exchange, the next thing said is for us without the name.
    if (d.kind !== "control") this.openWindow(clean, said ?? "");
    if (said) {
      this.hub.publish("mic", { phase: "thinking", text: clean });
      this.say(said, ev.SEV_ATTENTION, "head");
    }
    this.hub.publish("mic", { phase: "idle" });
    return { kind: d.kind, intent: d.intent, ...(said ? { said } : {}) };
  }

  private brainSpeaksFor(e: ev.AgentEvent): boolean {
    if (e.severity < ev.SEV_MILESTONE) return false;
    return (
      e.kind === ev.TURN_END ||
      e.kind === ev.ERROR ||
      e.kind === ev.TOOL_END ||
      e.kind === ev.NOTIFICATION
    );
  }

  /** The event, said the model's way; the stock line if the model is away. */
  private async brainNarrate(
    e: ev.AgentEvent,
    lines: ReturnType<typeof utterance>[],
  ): Promise<void> {
    const brain = this.brain();
    const first = lines[0];
    if (!brain || !first) return;
    const template = lines.map((u) => u.text).join(" ");
    try {
      const prompt = [
        `Something just happened in ${e.repo || "the agent's repo"}: ${e.kind}${e.tool ? ` (${e.tool})` : ""}${e.status ? `, ${e.status}` : ""}.`,
        e.text ? `Detail: ${String(e.text).slice(0, 500)}` : "",
        `The stock line would be: "${template}".`,
        "Say it your way, aloud, in one or two sentences and at most twenty-five words. Keep every fact in the stock line. No greeting.",
        e.kind === ev.TURN_END || e.kind === ev.ERROR
          ? "This one is always said."
          : "If it is not worth interrupting the user for, reply with a single hyphen.",
      ]
        .filter(Boolean)
        .join("\n");
      const said = await brain.compose(prompt, this.brainSystem());
      if (!said) {
        log(`brain kept quiet on ${e.kind}`);
        return;
      }
      this.arbiter.submitAll([{ ...first, text: said }]);
    } catch (err) {
      log(`brain narration failed: ${(err as Error).message}; stock line`);
      this.arbiter.submitAll(lines);
    }
  }

  private eventsAtCheckin = 0;
  /**
   * Once a minute, if things have happened and nothing has been said for a
   * couple of minutes, the model may say one thing unprompted, or nothing.
   */
  async checkIn(): Promise<void> {
    const brain = this.brain();
    if (!brain || !this.settings.brain_checkin) return;
    if (this.eventsSeen === this.eventsAtCheckin) return;
    if (!Object.keys(this.tracker.snapshot()).length) return;
    const lastSaid = this.history[this.history.length - 1]?.ts ?? 0;
    if (Date.now() / 1000 - lastSaid < 120) return;
    this.eventsAtCheckin = this.eventsSeen;
    try {
      const said = await brain.compose(
        this.innerNote
          ? "Nothing has been said for a while. Compare your inner note, what you expected, with the picture now. If something has changed that the user would want to hear, or something you meant to tell them is still untold and worth it now, say it in one sentence. Otherwise reply with a single hyphen."
          : "Nothing has been said for a while. Looking at the picture, is there one thing worth telling the user unprompted: an agent that has been waiting on them, one stuck on the same thing for a long time, a pattern of failures? If so, say it in one sentence. If not, reply with a single hyphen.",
        this.brainSystem(),
      );
      if (said) {
        this.say(said, ev.SEV_MILESTONE, "head");
        this.reflectSoon();
      }
    } catch (err) {
      log(`brain check-in failed: ${(err as Error).message}`);
    }
  }

  private lastExchange = { you: "", kik: "", at: 0 };

  /** After an exchange, the next thing said is for us; the Room shows it. */
  private openWindow(you: string, kik: string): void {
    this.attentionUntil = Date.now() + ATTENTION_MS;
    this.lastExchange = { you, kik, at: Date.now() };
    this.hub.publish("mic", { phase: "attending", until: this.attentionUntil });
  }

  /**
   * The gray zone: the window has closed but an exchange was recent, so a
   * sentence without the name may still be a follow-up. Only with a model
   * to ask, and only with hear_you on.
   */
  private grayZone(): boolean {
    // Every nameless sentence, while there is a model to ask: with a headset
    // in an empty room a wrong yes costs one answer, a wrong no costs trust.
    return this.settings.hear_you && this.brain() !== null;
  }

  private async decideDirected(
    text: string,
    meta: { dur_s?: number; stt_ms?: number },
  ): Promise<void> {
    const brain = this.brain();
    let yes = false;
    try {
      const ago = this.lastExchange.at
        ? Math.round((Date.now() - this.lastExchange.at) / 1000)
        : -1;
      const last = this.lastExchange.at
        ? `${ago} seconds ago. User: ${this.lastExchange.you}\nKik: ${this.lastExchange.kik}`
        : "(no exchange yet)";
      yes = brain ? await brain.directed(text, last) : false;
    } catch (e) {
      log(`directed check failed: ${(e as Error).message}`);
    }
    log(`follow-up? ${yes ? "yes" : "no"} (${text.split(/\s+/).length} words)`);
    this.hear(text, meta, yes ? { force: true, decided: true } : { decided: true });
  }

  /**
   * Endpointing: Whisper punctuates, so a transcript without a final mark
   * is probably half a sentence. It waits a moment for the rest.
   */
  private held: {
    text: string;
    meta: { dur_s?: number; stt_ms?: number };
    timer: NodeJS.Timeout;
  } | null = null;
  hearSegment(text: string, meta: { dur_s?: number; stt_ms?: number }): { kind: string } {
    const clean = text.trim();
    if (this.held) {
      clearTimeout(this.held.timer);
      const joined = `${this.held.text} ${clean}`.trim();
      const m = {
        dur_s: (this.held.meta.dur_s ?? 0) + (meta.dur_s ?? 0),
        stt_ms: (this.held.meta.stt_ms ?? 0) + (meta.stt_ms ?? 0),
      };
      this.held = null;
      return this.hearSegment(joined, m);
    }
    if (clean && !/[.?!]["')\]]?$/.test(clean) && clean.split(/\s+/).length < 40) {
      this.held = {
        text: clean,
        meta,
        timer: setTimeout(() => {
          const h = this.held;
          this.held = null;
          if (h) this.hear(h.text, h.meta);
        }, 1200),
      };
      return { kind: "held" };
    }
    return this.hear(clean, meta);
  }

  // --- presence: noticing the user ------------------------------------------------
  private presenceFile(): string {
    return path.join(HOME, "presence.json");
  }
  private presenceFromDisk(): { seen: number; greeted: number } {
    try {
      if (!existsSync(this.presenceFile())) return { seen: 0, greeted: 0 };
      const p = JSON.parse(readFileSync(this.presenceFile(), "utf8")) as Record<string, unknown>;
      return { seen: Number(p.seen) || 0, greeted: Number(p.greeted) || 0 };
    } catch {
      return { seen: 0, greeted: 0 };
    }
  }
  private savePresenceSoon(): void {
    if (!this.persistBoard || this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      try {
        mkdirSync(HOME, { recursive: true });
        writeFileSync(this.presenceFile(), JSON.stringify(this.presence));
      } catch (e) {
        log(`presence: could not write: ${(e as Error).message}`);
      }
    }, 5000);
    this.presenceTimer.unref();
  }

  /**
   * The user said something. If they have been away for a while, this is
   * where Kik notices: an addressed sentence gets its hello inside the
   * reply; an overheard one gets a hello of its own. Only the gap is used,
   * never the words.
   */
  private arrived(addressed: boolean): void {
    const now = Date.now();
    const gap = this.presence.seen ? now - this.presence.seen : 0;
    this.presence.seen = now;
    this.savePresenceSoon();
    if (gap < AWAY_MS || now - this.presence.greeted < AWAY_MS) return;
    if (!this.settings.brain_greets || !this.brain()) return;
    this.presence.greeted = now;
    if (addressed) {
      this.returned = { after: gap, at: now };
      return;
    }
    void this.greet(gap);
  }

  private async greet(gap: number): Promise<void> {
    const brain = this.brain();
    if (!brain) return;
    try {
      const said = await brain.compose(
        `The user has just come back after ${describeGap(gap)}. You heard them, but they were not talking to you. Say hello the way a colleague at the next desk would: one sentence, at most fifteen words, in context. Mention the one thing worth knowing, if there is one: what changed while they were away, what is still on the canvas, what you were in the middle of. A plain hello is fine. If it would be an intrusion right now, reply with a single hyphen.`,
        this.brainSystem(),
      );
      if (!said) return;
      log(`hello after ${describeGap(gap)}`);
      this.say(said, ev.SEV_MILESTONE, "head");
      this.openWindow("", said);
      this.reflectSoon();
    } catch (err) {
      log(`hello failed: ${(err as Error).message}`);
    }
  }

  // --- the inner thread: what Kik thinks between utterances -------------------------
  private innerFile(): string {
    return path.join(HOME, "inner.md");
  }
  private innerFromDisk(): string {
    try {
      return existsSync(this.innerFile()) ? readFileSync(this.innerFile(), "utf8").trim() : "";
    } catch {
      return "";
    }
  }
  /** Kik's private note, for the Control Room. */
  inner(): string {
    return this.innerNote;
  }
  /**
   * Something happened worth a thought: an exchange, an ending, an error.
   * A little later, once at a time and not too often, the inner note is
   * rewritten against the picture. Off the reply path.
   */
  reflectSoon(): void {
    if (this.reflectTimer || !this.brain()) return;
    const wait = Math.max(this.reflectMs, this.reflectedAt + this.reflectMs * 6 - Date.now());
    this.reflectTimer = setTimeout(() => {
      this.reflectTimer = null;
      void this.reflectNow();
    }, wait);
    this.reflectTimer.unref();
  }
  async reflectNow(): Promise<string> {
    const brain = this.brain();
    if (!brain || this.reflecting) return this.innerNote;
    this.reflecting = true;
    this.reflectedAt = Date.now();
    try {
      const recent = brain.recent(4);
      const note = await brain.compose(
        [
          "Rewrite your private inner note. It is for you alone and never spoken: what is going on with the agents right now, what you are waiting for and what you expect to happen next, what you meant to tell the user and have not yet, and what the user seems to be doing. Keep what still holds, drop what is stale, and note anything you got wrong. First person, plain and factual, the way an engineer keeps a log, no drama and no reading of motives. At most eighty words. Reply with the note only.",
          recent ? `The last exchanges:\n${recent}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        this.brainSystem(),
      );
      if (note) {
        this.innerNote = note.slice(0, 1500);
        log(`inner note rewritten, ${this.innerNote.split(/\s+/).length} words`);
        if (this.persistBoard) {
          try {
            mkdirSync(HOME, { recursive: true });
            writeFileSync(this.innerFile(), `${this.innerNote}\n`);
          } catch (e) {
            log(`inner: could not write: ${(e as Error).message}`);
          }
        }
        this.hub.publish("inner", { text: this.innerNote });
      }
    } catch (err) {
      log(`reflection failed: ${(err as Error).message}`);
    } finally {
      this.reflecting = false;
    }
    return this.innerNote;
  }

  // --- watchers: reasons to speak, as rules; the model only phrases them ------------
  /**
   * Once a minute. Cheap rules over the live picture for the cases a
   * colleague would mention unprompted: an agent kept waiting, tests red
   * for a long time, the same error again and again. Each is said once.
   * Works without a key; with one, the model says it its way.
   */
  watch(now = Date.now()): string[] {
    const said: string[] = [];
    const snap = this.tracker.snapshot();
    const live = new Set(Object.keys(snap));
    for (const id of this.waitingSince.keys()) if (!live.has(id)) this.waitingSince.delete(id);
    for (const id of this.redSince.keys()) if (!live.has(id)) this.redSince.delete(id);
    const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
    for (const [id, s] of Object.entries(snap)) {
      if (s.status === "waiting") {
        const since = this.waitingSince.get(id) ?? now;
        this.waitingSince.set(id, since);
        if (now - since >= 3 * 60_000) {
          const key = `wait:${id}:${s.pending_permission_id || since}`;
          const what = s.pending_permission ? `: ${s.pending_permission.slice(0, 120)}` : "";
          if (
            this.concern(
              key,
              `${s.label} has been waiting on you for ${minutes(now - since)} minutes${what}.`,
            )
          )
            said.push(key);
        }
      } else this.waitingSince.delete(id);
      if (/[1-9]\d* failed/.test(s.last_test_result)) {
        const since = this.redSince.get(id) ?? now;
        this.redSince.set(id, since);
        if (now - since >= 30 * 60_000) {
          const key = `red:${id}:${Math.floor((now - since) / 3600_000)}`;
          if (
            this.concern(
              key,
              `${s.label}'s tests have been red for ${minutes(now - since)} minutes: ${s.last_test_result}.`,
            )
          )
            said.push(key);
        }
      } else this.redSince.delete(id);
      const errors = (this.tracker.sessions.get(id)?.errors ?? []).map((e) =>
        e.replace(/\s+/g, " ").trim().slice(0, 80),
      );
      if (errors.length >= 3) {
        const last = errors.slice(-3);
        if (last[0] && last.every((e) => e === last[0])) {
          const key = `err:${id}:${last[0]}`;
          if (this.concern(key, `${s.label} has hit the same error three times: ${last[0]}.`))
            said.push(key);
        }
      }
    }
    return said;
  }

  /** Say a concern once. Returns whether it was new. */
  private concern(key: string, text: string): boolean {
    if (this.concernsSaid.includes(key)) return false;
    this.concernsSaid.push(key);
    if (this.concernsSaid.length > 200) this.concernsSaid.shift();
    log(`watch: ${text}`);
    this.hub.publish("concern", { key, text });
    if (this.narrator.mode === "silent") return true;
    const brain = this.brain();
    if (brain && this.settings.brain_checkin) {
      void brain
        .compose(
          `Something you have been watching is now worth saying, unprompted: "${text}". Say it your way, aloud, in one sentence, keeping every fact. No greeting.`,
          this.brainSystem(),
        )
        .then((line) => this.say(line || text, ev.SEV_ATTENTION, "head"))
        .catch(() => this.say(text, ev.SEV_ATTENTION, "head"))
        .finally(() => this.reflectSoon());
    } else this.say(text, ev.SEV_ATTENTION, "head");
    return true;
  }

  /** One line of register for the system prompt: never spoken, shows in the words. */
  private register(now = Date.now()): string {
    const moods: string[] = [];
    const hour = new Date(now).getHours();
    if (hour >= 23 || hour < 5) moods.push("it is late at night: shorter and quieter than usual");
    const failures = this.recentFailures.filter((t) => now - t < 3600_000).length;
    if (failures >= 4)
      moods.push(`the last hour had ${failures} failures: drier and terser, no cheer`);
    if (this.greenAt && now - this.greenAt < 600_000)
      moods.push("the tests just went green after being red: quietly pleased, said once at most");
    if ([...this.waitingSince.values()].some((t) => now - t >= 3 * 60_000))
      moods.push("an agent has been waiting on the user for a while: a touch more direct");
    return moods.length
      ? `Register right now (never mention it; let it show in the words): ${moods.join("; ")}.`
      : "";
  }

  // --- the journal: yesterday, and the days before, in Kik's own notes ---------------
  private journalFile(): string {
    return path.join(HOME, "journal.md");
  }
  private journalMarkFile(): string {
    return path.join(HOME, "journal.json");
  }
  /** What happened on earlier days: dated lines, oldest first. */
  journal(): string {
    try {
      return existsSync(this.journalFile()) ? readFileSync(this.journalFile(), "utf8") : "";
    } catch {
      return "";
    }
  }
  private journalUpTo(): number {
    try {
      if (!existsSync(this.journalMarkFile())) return 0;
      return (
        Number(
          (JSON.parse(readFileSync(this.journalMarkFile(), "utf8")) as { upTo?: number }).upTo,
        ) || 0
      );
    } catch {
      return 0;
    }
  }
  /** Once an hour at most, and only with a model: the days before today into the journal. */
  private async consolidateMaybe(): Promise<void> {
    if (Date.now() - this.consolidatedAt < 3600_000) return;
    await this.consolidate();
  }
  /**
   * Every day of conversation before today that is not yet in the journal
   * becomes one to three dated lines in it: decisions, requests, what was
   * made, what went wrong. Days older than thirty are dropped. Returns how
   * many days were written.
   */
  async consolidate(): Promise<number> {
    const brain = this.brain();
    if (!brain || !this.persistBoard || this.consolidating) return 0;
    this.consolidating = true;
    this.consolidatedAt = Date.now();
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const upTo = this.journalUpTo();
      let rows: Array<{ at: number; you: string; kik: string }> = [];
      try {
        if (existsSync(this.conversationFile()))
          rows = readFileSync(this.conversationFile(), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { at: number; you: string; kik: string })
            .filter((r) => r.at > upTo && r.at < today.getTime());
      } catch (e) {
        log(`journal: could not read the conversation: ${(e as Error).message}`);
        return 0;
      }
      if (!rows.length) return 0;
      const days = new Map<string, typeof rows>();
      for (const r of rows) {
        const key = dayOf(r.at);
        days.set(key, [...(days.get(key) ?? []), r]);
      }
      let written = 0;
      let last = upTo;
      // at most a week per pass; an old backlog catches up over a few hours
      for (const [day, list] of [...days.entries()].slice(0, 7)) {
        const transcript = list
          .map((r) => `User: ${r.you.slice(0, 400)}\nKik: ${r.kik.slice(0, 400)}`)
          .join("\n");
        const lines = await brain.compose(
          `Below is one day of conversation between the user and you, ${day}. Write one to three lines for your journal, each starting with "- ${day}:". Keep what you would want a week from now: what the user decided, asked for, told you about themselves or their work, what you made, what went wrong. Facts only, no greetings, no chatter, no praise. If nothing is worth keeping, reply with a single hyphen.\n\n${transcript.slice(0, 12_000)}`,
          `${PERSONA}\n\nYou are writing your journal, not speaking.`,
        );
        const keep = lines
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("- "))
          .slice(0, 3);
        if (keep.length) {
          this.writeJournal(`${this.journal().trimEnd()}\n${keep.join("\n")}\n`.trimStart());
          written++;
        }
        last = Math.max(last, ...list.map((r) => r.at));
        try {
          writeFileSync(this.journalMarkFile(), JSON.stringify({ upTo: last }));
        } catch (e) {
          log(`journal: could not write the mark: ${(e as Error).message}`);
        }
      }
      if (written) log(`journal: ${written} day${written === 1 ? "" : "s"} written`);
      return written;
    } catch (err) {
      log(`journal failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.consolidating = false;
    }
  }
  private writeJournal(text: string): void {
    // thirty days of life; older lines go, by the date they start with
    const cutoff = dayOf(Date.now() - 30 * 86_400_000);
    const kept = text
      .split("\n")
      .filter((l) => {
        const m = /^- (\d{4}-\d{2}-\d{2}):/.exec(l);
        return !m || (m[1] ?? "") >= cutoff;
      })
      .join("\n");
    try {
      mkdirSync(HOME, { recursive: true });
      writeFileSync(this.journalFile(), kept.slice(-12_000));
    } catch (e) {
      log(`journal: could not write: ${(e as Error).message}`);
    }
  }

  // --- the board on disk: sticky pins survive a restart ---------------------------
  private boardTimer: NodeJS.Timeout | null = null;
  private readonly persistBoard: boolean;
  private boardFile(): string {
    return path.join(HOME, "board.json");
  }
  private loadBoard(): void {
    try {
      if (!existsSync(this.boardFile())) return;
      const n = this.board.load(JSON.parse(readFileSync(this.boardFile(), "utf8")));
      if (n) log(`board: ${n} pins back from disk`);
    } catch (e) {
      log(`board: could not read ${this.boardFile()}: ${(e as Error).message}`);
    }
  }
  private saveBoardSoon(): void {
    if (this.boardTimer) return;
    this.boardTimer = setTimeout(() => {
      this.boardTimer = null;
      try {
        mkdirSync(HOME, { recursive: true });
        writeFileSync(this.boardFile(), JSON.stringify(this.board.toJSON()));
      } catch (e) {
        log(`board: could not write: ${(e as Error).message}`);
      }
    }, 300);
    this.boardTimer.unref();
  }

  /** The user typed to Kik on the canvas: addressed, no name needed. */
  typed(text: string): { kind: string; intent: string; said?: string } {
    return this.hear(text, {}, { force: true, decided: true });
  }

  /** The model head, when there is a key and the setting is on. */
  brain(): Brain | null {
    if (!this.settings.brain || !this.anthropicKey) return null;
    if (!this.brainCache || this.brainCache.model !== this.settings.brain_model) {
      this.brainCache = new Brain({
        key: this.anthropicKey,
        model: this.settings.brain_model,
        fetchImpl: this.fetchImpl,
        log,
      });
      if (this.persistBoard) this.brainCache.seed(this.conversationFromDisk());
    }
    return this.brainCache;
  }

  // --- memory: the conversation on disk, and the notes Kik keeps -------------------------
  private conversationFile(): string {
    return path.join(HOME, "conversation.jsonl");
  }
  private memoryFile(): string {
    return path.join(HOME, "memory.md");
  }
  /** The last day of exchanges, oldest first. */
  private conversationFromDisk(): Array<{ at: number; you: string; kik: string }> {
    try {
      if (!existsSync(this.conversationFile())) return [];
      const since = Date.now() - 24 * 3600_000;
      return readFileSync(this.conversationFile(), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { at: number; you: string; kik: string })
        .filter((e) => e.at > since)
        .slice(-40);
    } catch (e) {
      log(`memory: could not read the conversation: ${(e as Error).message}`);
      return [];
    }
  }
  private rememberExchange(you: string, kik: string): void {
    if (!this.persistBoard || !kik) return;
    try {
      mkdirSync(HOME, { recursive: true });
      appendFileSync(this.conversationFile(), `${JSON.stringify({ at: Date.now(), you, kik })}\n`);
    } catch (e) {
      log(`memory: could not write the conversation: ${(e as Error).message}`);
    }
  }
  /** What Kik has chosen to remember: a short markdown list, edited by tools. */
  memory(): string {
    try {
      return existsSync(this.memoryFile()) ? readFileSync(this.memoryFile(), "utf8") : "";
    } catch {
      return "";
    }
  }
  private writeMemory(text: string): void {
    mkdirSync(HOME, { recursive: true });
    writeFileSync(this.memoryFile(), text.slice(0, 20_000));
  }

  private async converse(
    text: string,
    kind: string,
    intent: string,
    record: (kind: string, intent: string, said?: string) => void,
  ): Promise<void> {
    const brain = this.brain();
    if (!brain) return;
    let said = "";
    if (CORRECTION.test(gate(text)[1])) {
      this.corrected = Date.now();
      log("correction: the user is putting Kik right");
    }
    // While the model thinks, a person would say "hm". One short sound if
    // the first clause is slow; a hello needs none.
    let filler: NodeJS.Timeout | null =
      kind === "social"
        ? null
        : setTimeout(() => {
            filler = null;
            const pick = FILLERS.filter((f) => f !== this.lastFiller);
            const f = pick[Math.floor(Math.random() * pick.length)] ?? "Hm.";
            this.lastFiller = f;
            this.say(f, ev.SEV_MILESTONE, "head");
          }, this.fillerMs);
    const stopFiller = () => {
      if (filler) clearTimeout(filler);
      filler = null;
    };
    try {
      said = await brain.reply(text, {
        system: this.brainSystem(),
        tools: this.brainTools(),
        onClause: (clause) => {
          stopFiller();
          const next = /^next:\s*(.+)$/i.exec(clause.trim());
          if (next) {
            const options = (next[1] ?? "")
              .split("|")
              .map((s) => s.trim().replace(/[.]$/, ""))
              .filter(Boolean)
              .slice(0, 3);
            if (options.length) this.hub.publish("suggest", { options });
            return;
          }
          this.say(clause, ev.SEV_ATTENTION, "head");
        },
      });
      said = said.replace(/\s*next:\s*[^\n]*$/i, "").trim();
      record("chat", kind, said);
      this.rememberExchange(text, said);
    } catch (e) {
      log(`brain failed: ${(e as Error).message}; rules answered`);
      said =
        kind === "question"
          ? headAnswer(text, Object.values(this.tracker.snapshot()))
          : kind === "social"
            ? headSocial(intent)
            : "I can't reach the model right now. Say that to the terminal.";
      record(kind, intent, said);
      this.say(said, ev.SEV_ATTENTION, "head");
    } finally {
      stopFiller();
      this.returned = null;
      this.openWindow(text, said);
      this.hub.publish("mic", { phase: "idle" });
      this.reflectSoon();
    }
  }

  /** The live picture the model answers from. Rebuilt every utterance. */
  brainSystem(): string {
    const lines: string[] = [PERSONA, "", "Right now:"];
    const brief = this.tracker.brief();
    lines.push(brief ? brief : "No agents are running.");
    if (this.pending)
      lines.push(
        `Waiting for the user's approval: ${this.pending.text || "a tool call"} in ${this.pending.repo}.`,
      );
    const pins = this.board.list();
    if (pins.length) {
      lines.push(
        `On the canvas (${pins.length} pins; the user sees these and can tick, edit and reply on them; read_board gives full bodies):`,
      );
      for (const p of pins.slice(0, 8)) {
        const ask = p.ask?.length && !p.answer ? ` [asking: ${p.ask.join("/")}]` : "";
        lines.push(
          `- [${p.id}] ${p.kind} "${p.title}" by ${p.by}${ask}: ${p.body.slice(0, 600).replace(/\s+/g, " ")}`,
        );
      }
    }
    const recent = this.history.slice(-5).map((h) => h.text);
    if (recent.length)
      lines.push(`Last things said aloud: ${recent.map((t) => `"${t}"`).join(" ")}`);
    if (this.instructions.length)
      lines.push(
        `Instructions waiting for an agent: ${this.instructions.map((i) => `${i.repo}: ${i.text}`).join("; ")}`,
      );
    const mem = this.memory().trim();
    if (mem)
      lines.push(
        `What you remember about the user and their work (your notes; use remember to add, forget to drop):\n${mem.slice(0, 4000)}`,
      );
    const journal = this.journal().trim();
    if (journal)
      lines.push(
        `Your journal of earlier days (what was decided, asked for, made; refer to it when it helps, without being asked):\n${journal.slice(-3000)}`,
      );
    if (this.innerNote)
      lines.push(
        `What you were thinking a moment ago (your private note; nothing in it has been said aloud unless it appears above):\n${this.innerNote}`,
      );
    const register = this.register();
    if (register) lines.push(register);
    if (Date.now() - this.corrected < 60_000)
      lines.push(
        "The user is correcting you. Take it: a few words of acknowledgement, no defence, then do it their way. If it is a fact about them or their work, keep the corrected version with remember and drop the wrong one with forget. Do not repeat the thing you got wrong.",
      );
    if (this.returned && Date.now() - this.returned.at < 60_000)
      lines.push(
        `The user has just come back after ${describeGap(this.returned.after)} and this is the first thing they have said. Say hello in passing, the way a colleague would, then answer.`,
      );
    lines.push(
      `Narration mode: ${this.narrator.mode}. Local time ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, ${new Date().toDateString()}.`,
    );
    return lines.join("\n");
  }

  brainTools(): BrainTool[] {
    const str = (description: string) => ({ type: "string", description });
    return [
      {
        name: "approve",
        description: "Approve the tool call or board question the user is being asked about.",
        input_schema: { type: "object", properties: {} },
        run: () => this.answerWord("yes") ?? "nothing was waiting",
      },
      {
        name: "deny",
        description: "Deny the tool call or board question the user is being asked about.",
        input_schema: { type: "object", properties: {} },
        run: () => this.answerWord("no") ?? "nothing was waiting",
      },
      {
        name: "answer_board",
        description: "Answer the board's open question with one of its offered words.",
        input_schema: {
          type: "object",
          properties: { word: str("the offered word, e.g. apply") },
          required: ["word"],
        },
        run: (i) =>
          this.board.answerCurrent(String(i.word ?? "")) ? "answered" : "nothing was asking",
      },
      {
        name: "instruct_agent",
        description:
          "Give the coding agent an instruction from the user. It is handed over when the agent's current turn ends, or with the user's next prompt if it is idle.",
        input_schema: {
          type: "object",
          properties: {
            instruction: str("what the user wants done, in their words"),
            repo: str("which repo's agent; omit if there is only one"),
          },
          required: ["instruction"],
        },
        run: (i) => this.instruct(String(i.instruction ?? ""), i.repo ? String(i.repo) : undefined),
      },
      {
        name: "create_artifact",
        description: `Put something on the user's canvas: a checklist (one item per line, '- [ ] item'), a note, a markdown document, a table (markdown table), a diagram (one 'a -> b' edge per line, '*x' marks the current node, 'note: …' adds a note), an SVG you draw, a small self-contained HTML page (interactive is fine, it runs sandboxed), or a live web page (kind web, body is the URL: an app running on localhost, a site, or a search engine to give the user a browser). Returns the id. Use sticky for anything the user will want tomorrow. For any page, app, dashboard, mockup, comparison or tool, do not write the code yourself: call design_artifact with a brief instead; a designer model builds it as a React app. Kind react is for code you already have (a component file with export default). ${KIT_GUIDE}`,
        input_schema: {
          type: "object",
          properties: {
            kind: str(
              "checklist | note | markdown | table | diagram | svg | html | react | web | text",
            ),
            title: str("a few words"),
            body: str("the content"),
            sticky: { type: "boolean", description: "keep it until removed" },
            near: str("id of a card this belongs beside; a note next to an artboard"),
            wide: {
              type: "boolean",
              description: "an artboard: wide, for a page, a drawing or an image",
            },
          },
          required: ["kind", "title", "body"],
        },
        run: (i) => {
          let kind = String(i.kind ?? "note");
          let body = String(i.body ?? "");
          if (kind === "web") {
            body = body.trim();
            if (/^localhost|^127\.0\.0\.1|^\d+$/.test(body))
              body = `http://${/^\d+$/.test(body) ? `localhost:${body}` : body}`;
            if (!/^https?:\/\//i.test(body))
              return "web needs a URL starting with http:// or https://";
          }
          if (kind === "html") body = withKit(body);
          if (kind === "diagram") {
            // boxes and arrows in, vectors out, as the show route does
            const svg = diagramToSvg(body);
            if (!svg) return "empty diagram: one 'a -> b' edge per line";
            kind = "svg";
            body = svg;
          }
          const pin = this.board.add({
            kind,
            title: String(i.title ?? ""),
            body,
            repo: "kik",
            by: "kik",
            sticky: Boolean(i.sticky),
            near: i.near ? String(i.near) : undefined,
            size:
              i.wide ||
              kind === "html" ||
              kind === "svg" ||
              kind === "image" ||
              kind === "web" ||
              kind === "react"
                ? "wide"
                : "normal",
            ttl_s: i.sticky ? undefined : 3600,
          });
          // anything made is shown: the canvas pans there and the card pulses
          this.hub.publish("focus", { id: pin.id });
          return `created ${pin.kind} ${pin.id}`;
        },
      },
      {
        name: "design_artifact",
        description:
          "Have a page, app, dashboard, mockup, visual comparison or small tool designed and built for the canvas as a working React app with real UI. Give a brief in a few sentences: what it is for, what it shows, what the user can do on it, any data or facts to include. The full designer takes a minute or two; quick takes about twenty seconds and is rougher: use quick when the user says quick, rough, sketch or mockup, or wants to see something fast. Do not announce the wait yourself; the tool says it aloud. Returns the id; then point_at it. Use this, not create_artifact with html, for anything a designer would make.",
        input_schema: {
          type: "object",
          properties: {
            title: str("a few words"),
            brief: str("what to build, in a few sentences, with the facts it needs"),
            quick: {
              type: "boolean",
              description:
                "a rough sketch in about twenty seconds instead of a finished page in a minute or two",
            },
            sticky: { type: "boolean", description: "keep it until removed" },
            near: str("id of a card this belongs beside"),
          },
          required: ["title", "brief"],
        },
        run: async (i) => {
          const brain = this.brain();
          if (!brain) return "no model available";
          const brief = String(i.brief ?? "").trim();
          if (!brief) return "the brief is empty";
          const picture = this.tracker.brief();
          const quick = Boolean(i.quick);
          // The wait is real, so the tool says so itself, once, and again
          // if it runs long; the model is told not to.
          this.say(
            quick
              ? "Sketching it, give me twenty seconds."
              : "Building that, give me a minute or two.",
            ev.SEV_ATTENTION,
            "head",
          );
          const nudge = setTimeout(
            () => this.say("Still on it.", ev.SEV_MILESTONE, "head"),
            quick ? 40_000 : 75_000,
          );
          nudge.unref();
          const t0 = Date.now();
          let code = "";
          try {
            code = stripFences(
              await brain.generate(
                `Brief: ${brief}\n\nTitle: ${String(i.title ?? "")}${picture ? `\n\nContext, in case it helps: ${picture}` : ""}`,
                quick
                  ? `${DESIGN_BRIEF}\n\nThis one is a quick sketch: the whole idea on one screen, real copy, working controls, but keep it to about two hundred lines and skip secondary states.`
                  : DESIGN_BRIEF,
                {
                  model: quick
                    ? this.settings.brain_model
                    : this.settings.artifact_model || this.settings.brain_model,
                  ...(quick ? { maxTokens: 6000 } : {}),
                },
              ),
            );
          } finally {
            clearTimeout(nudge);
          }
          if (!/export\s+default/.test(code) && !/function\s+App\b/.test(code))
            return "the designer returned no component";
          const pin = this.board.add({
            kind: "react",
            title: String(i.title ?? ""),
            body: code,
            repo: "kik",
            by: "kik",
            sticky: Boolean(i.sticky),
            near: i.near ? String(i.near) : undefined,
            size: "wide",
            ttl_s: i.sticky ? undefined : 3600,
          });
          log(
            `designed ${pin.id} "${pin.title}" ${quick ? "quickly " : ""}in ${Date.now() - t0} ms, ${code.length} chars`,
          );
          this.hub.publish("focus", { id: pin.id });
          this.reflectSoon();
          return `built ${pin.id}`;
        },
      },
      {
        name: "update_artifact",
        description:
          "Change something on the canvas: new body, title, make it sticky, move it beside another card (near), or make it wide. Use the id from the board listing.",
        input_schema: {
          type: "object",
          properties: {
            id: str("the pin id"),
            title: str("new title"),
            body: str("new content, whole"),
            sticky: { type: "boolean" },
            near: str("id of the card to sit beside"),
            wide: { type: "boolean" },
          },
          required: ["id"],
        },
        run: (i) => {
          const target = this.board.get(String(i.id ?? ""));
          const asSvg = target?.kind === "svg" && i.body !== undefined && /->/.test(String(i.body));
          const p = this.board.update(String(i.id ?? ""), {
            title: i.title === undefined ? undefined : String(i.title),
            body:
              i.body === undefined
                ? undefined
                : asSvg
                  ? diagramToSvg(String(i.body)) || String(i.body)
                  : target?.kind === "html"
                    ? withKit(String(i.body))
                    : String(i.body),
            sticky: i.sticky === undefined ? undefined : Boolean(i.sticky),
            near: i.near === undefined ? undefined : String(i.near),
            size: i.wide === undefined ? undefined : i.wide ? "wide" : "normal",
          });
          return p ? `updated ${p.id}` : "no such pin";
        },
      },
      {
        name: "read_board",
        description:
          "Read what is on the canvas: every pin with its id, kind, title, who made it, and body.",
        input_schema: { type: "object", properties: {} },
        run: () =>
          this.board
            .list()
            .map(
              (p) =>
                `[${p.id}] ${p.kind} "${p.title}" by ${p.by}${p.sticky ? " (sticky)" : ""}${p.near ? ` (beside ${p.near})` : ""}:\n${p.body.slice(0, 2000)}`,
            )
            .join("\n\n") || "the board is empty",
      },
      {
        name: "remove_artifact",
        description: "Take one thing off the canvas.",
        input_schema: { type: "object", properties: { id: str("the pin id") }, required: ["id"] },
        run: (i) => (this.board.remove(String(i.id ?? "")) ? "removed" : "no such pin"),
      },
      {
        name: "point_at",
        description:
          "Take the user to something on the canvas: it pans there and pulses. Use it whenever you talk about a card.",
        input_schema: { type: "object", properties: { id: str("the pin id") }, required: ["id"] },
        run: (i) => {
          const id = String(i.id ?? "");
          if (!this.board.get(id)) return "no such pin";
          this.hub.publish("focus", { id });
          return "pointed";
        },
      },
      {
        name: "ask_user",
        description:
          "Ask the user to choose. The question is spoken and shown on the canvas with the options as buttons; the user answers by click or voice. Returns their choice, or 'no answer' after two minutes.",
        input_schema: {
          type: "object",
          properties: {
            question: str("one sentence"),
            options: {
              type: "array",
              items: { type: "string" },
              description: "two to four short options",
            },
          },
          required: ["question", "options"],
        },
        run: async (i) => {
          const question = String(i.question ?? "").trim();
          const options = (Array.isArray(i.options) ? i.options : []).map(String).slice(0, 4);
          if (!question || options.length < 2) return "need a question and at least two options";
          this.say(question, ev.SEV_ATTENTION, "head");
          const pin = this.board.add({
            kind: "markdown",
            title: "your call",
            body: question,
            repo: "kik",
            by: "kik",
            ask: options,
            wait_s: 120,
            ttl_s: 600,
          });
          this.hub.publish("focus", { id: pin.id });
          const answer = await this.board.wait(pin.id, 120);
          return answer ? `the user chose: ${answer}` : "no answer";
        },
      },
      {
        name: "remember",
        description:
          "Keep a fact about the user or their work for future sessions: a preference, a decision, a name, a deadline. One short line. Do this whenever the user tells you something you would want tomorrow.",
        input_schema: { type: "object", properties: { fact: str("one line") }, required: ["fact"] },
        run: (i) => {
          const fact = String(i.fact ?? "")
            .trim()
            .replace(/\s+/g, " ");
          if (!fact) return "nothing to remember";
          const stamp = new Date().toISOString().slice(0, 10);
          this.writeMemory(`${this.memory().trimEnd()}\n- ${stamp}: ${fact}\n`.trimStart());
          return "remembered";
        },
      },
      {
        name: "forget",
        description:
          "Drop a remembered line that is wrong or no longer true. Give a few words that appear in it.",
        input_schema: {
          type: "object",
          properties: { about: str("words that appear in the line") },
          required: ["about"],
        },
        run: (i) => {
          const about = String(i.about ?? "")
            .trim()
            .toLowerCase();
          if (!about) return "say what to forget";
          const lines = this.memory().split("\n");
          const kept = lines.filter((l) => !l.toLowerCase().includes(about));
          this.writeMemory(kept.join("\n"));
          return `${lines.length - kept.length} line(s) forgotten`;
        },
      },
      {
        name: "set_mode",
        description: "Change how much is narrated: silent, attention, normal or verbose.",
        input_schema: {
          type: "object",
          properties: { mode: str("silent | attention | normal | verbose") },
          required: ["mode"],
        },
        run: (i) => {
          this.setMode(String(i.mode ?? "normal"));
          return `mode ${this.narrator.mode}`;
        },
      },
      {
        name: "clear_board",
        description: "Clear everything off the board.",
        input_schema: { type: "object", properties: {} },
        run: () => {
          this.board.clear();
          return "cleared";
        },
      },
      {
        name: "pin_note",
        description: "Pin a short note to the board for the user to read later.",
        input_schema: {
          type: "object",
          properties: { title: str("a few words"), body: str("the note, plain text") },
          required: ["title", "body"],
        },
        run: (i) => {
          this.board.add({
            kind: "text",
            title: String(i.title ?? "note"),
            body: String(i.body ?? ""),
            repo: "kikoe",
          });
          return "pinned";
        },
      },
    ];
  }

  /** Queue an instruction for an agent; says what will happen to it. */
  instruct(text: string, repo?: string): string {
    const sessions = Object.values(this.tracker.snapshot());
    const target =
      repo ??
      sessions.find((s) => s.status === "working")?.repo ??
      sessions[sessions.length - 1]?.repo;
    if (!target) return "no agent is connected; nothing to hand it to";
    this.instructions.push({ repo: target, text, at: Date.now() });
    const s = sessions.find((x) => x.repo === target);
    const when = s?.status === "working" ? "when its turn ends" : "with the user's next prompt";
    log(`instruction queued for ${target}: ${text}`);
    return `queued for ${target}; it gets it ${when}`;
  }

  /**
   * The reply that carries a queued instruction back through a hook: Stop
   * makes the agent continue with it; UserPromptSubmit adds it as context.
   */
  hookReply(payload: Record<string, unknown>, repo: string): Record<string, unknown> | null {
    const event = String(payload.hook_event_name ?? "");
    if (!this.instructions.length) return null;
    const mine = this.instructions.filter((i) => i.repo === repo);
    if (!mine.length) return null;
    const text = mine.map((i) => i.text).join(" Then: ");
    if (event === "Stop" && !payload.stop_hook_active) {
      for (const i of mine) this.instructions.splice(this.instructions.indexOf(i), 1);
      return {
        decision: "block",
        reason: `The user said this by voice, through Kikoe; treat it as their next message: ${text}`,
      };
    }
    if (event === "UserPromptSubmit") {
      for (const i of mine) this.instructions.splice(this.instructions.indexOf(i), 1);
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `The user also said this by voice, through Kikoe, before this prompt: ${text}`,
        },
      };
    }
    return null;
  }

  private control(intent: string, arg: string): string | undefined {
    switch (intent) {
      case "stop":
        this.interrupt();
        return undefined;
      case "pause":
        this.setMode("silent");
        return "Quiet.";
      case "resume":
        this.setMode(this.settings.narrate);
        return "Back.";
      case "mode":
        this.setMode(arg);
        this.settings.narrate = arg;
        return arg === "silent" ? undefined : `${arg}.`;
      case "board":
        if (arg === "clear") {
          this.board.clear();
          return "Cleared.";
        }
        this.hub.publish("view", { view: arg === "show" ? "control" : "room" });
        return undefined;
      case "repeat":
        return this.lastRepeatable || "I haven't said anything yet.";
      case "focus":
        this.hub.publish("view", { view: "room", focus: arg });
        return `${arg}.`;
      case "shutdown":
        this.hub.publish("control", { intent: "shutdown" });
        return "Goodbye.";
      default:
        return undefined;
    }
  }

  // -- what was said, and how fast ----------------------------------------------

  recordSpoken(
    text: string,
    res: { backend: string; ttfaMs: number; audioS: number },
    u: Utterance | undefined,
    startedAtMs: number,
  ): void {
    const firstSound = startedAtMs + Math.max(0, res.ttfaMs);
    const latency = u?.created ? Math.round(firstSound - u.created * 1000) : null;
    const rec: SpokenRecord = {
      ts: Date.now() / 1000,
      text,
      backend: res.backend,
      ttfa_ms: Math.round(res.ttfaMs),
      audio_s: Number(res.audioS.toFixed(2)),
      session: u?.session ?? "",
      label: u?.label ?? "",
      priority: u?.priority ?? ev.SEV_MILESTONE,
      latency_ms: latency !== null && latency >= 0 && latency < 60_000 ? latency : null,
    };
    this.history.push(rec);
    if (this.history.length > HISTORY) this.history.shift();
    if (rec.label) this.lastSpokeRepo = rec.label;
    this.lastSpoken = { text, at: Date.now() };
    if (rec.priority >= 2) this.lastRepeatable = text;
    if (rec.latency_ms !== null) {
      this.latencies.push(rec.latency_ms);
      if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
    }
    this.hub.publish("spoken", { ...rec });
    try {
      writeFileSync(
        path.join(LOGS, "metrics.jsonl"),
        `${JSON.stringify({ event: "spoken", ...rec, chars: text.length })}\n`,
        { flag: "a" },
      );
    } catch {
      /* metrics must never throw */
    }
  }

  /** Event receipt to first sound, over the last hundred lines. Measured, not claimed. */
  latency(): { n: number; p50: number | null; p90: number | null; ttfa_p50: number | null } {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const q = (p: number) =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! : null;
    const ttfas = this.history.map((h) => h.ttfa_ms).sort((a, b) => a - b);
    return {
      n: sorted.length,
      p50: q(0.5),
      p90: q(0.9),
      ttfa_p50: ttfas.length ? ttfas[Math.floor(ttfas.length / 2)]! : null,
    };
  }

  state() {
    return {
      ok: true,
      version: VERSION,
      uptime_s: Math.round((Date.now() - this.startedAt) / 1000),
      brain: {
        on: this.brain() !== null,
        model: this.settings.brain_model,
        key: Boolean(this.anthropicKey),
      },
      instructions: this.instructions.length,
      inner: this.innerNote,
      presence: this.presence,
      journal_days: this.journal()
        .split("\n")
        .filter((l) => l.startsWith("- ")).length,
      look: this.look(),
      mode: this.narrator.mode,
      tts: {
        ladder: this.ladder.names,
        last: this.ladder.lastBackend,
        strict: this.ladder.strict,
        loaded: loadedEngines(),
      },
      speaker: this.speaker.info(),
      arbiter: this.arbiter.state(),
      sessions: this.tracker.snapshot(),
      pending_permission: this.pending
        ? { id: this.pending.id, repo: this.pending.repo, text: this.pending.text }
        : null,
      events_seen: this.eventsSeen,
      hub_subscribers: this.hub.count,
      history: [...this.history].reverse(),
      latency: this.latency(),
      pins: this.board.list(),
      asking: this.board.asking()?.id ?? null,
      mic: { phase: this.micPhase, device: this.micDevice, enabled: this.settings.mic },
      heard: [...this.heardLog].reverse(),
      home: HOME,
    };
  }

  // -- http --------------------------------------------------------------------

  /** "full" can act; "viewer" can only watch; null is refused. */
  private grant(req: http.IncomingMessage, url: URL): "full" | "viewer" | null {
    const h = req.headers.authorization ?? "";
    const presented = h.startsWith("Bearer ")
      ? h.slice(7)
      : String(req.headers["x-kikoe-token"] ?? url.searchParams.get("token") ?? "");
    if (presented === this.token) return "full";
    if (presented === this.viewer) return "viewer";
    return null;
  }

  private json(res: http.ServerResponse, code: number, body: unknown): void {
    const s = JSON.stringify(body);
    res.writeHead(code, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(s),
    });
    res.end(s);
  }

  private body(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 8 * 1024 * 1024) {
          req.destroy();
          reject(new Error("body too large"));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (route === "GET /health")
      return this.json(res, 200, { ok: true, version: VERSION, pid: process.pid });
    // The Room for a browser: the same renderer the app shows, with a shim
    // in place of the preload. The token must be in the URL the user opened;
    // the files themselves are public assets and carry no secret.
    if (req.method === "GET" && url.pathname.startsWith("/fonts/") && this.roomDir) {
      const name = url.pathname
        .slice("/fonts/".length)
        .split("/")
        .filter((p) => p && p !== "..")
        .join("/");
      const file = path.join(this.roomDir, "..", "fonts", name);
      if (!existsSync(file)) return this.json(res, 404, { error: "no such file" });
      res.writeHead(200, {
        "content-type": name.endsWith(".css") ? "text/css" : "font/woff2",
        "cache-control": "max-age=86400",
      });
      res.end(readFileSync(file));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/backdrops/") && this.roomDir) {
      // the bundled backdrops, public assets like the fonts
      const name = url.pathname
        .slice("/backdrops/".length)
        .split("/")
        .filter((p) => p && p !== "..")
        .join("/");
      const file = path.join(this.roomDir, "..", "backdrops", name);
      if (!existsSync(file) || !name.endsWith(".jpg"))
        return this.json(res, 404, { error: "no such file" });
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=86400" });
      res.end(readFileSync(file));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/artifact/")) {
      // A page a card frames. The id is the only key: it opens this one
      // page and nothing else, and the page gets its own content policy.
      const id = url.pathname.slice("/artifact/".length).replace(/\/.*$/, "");
      const pin = this.board.get(id);
      const doc = pin ? renderArtifact(pin) : null;
      if (!pin || doc === null) return this.json(res, 404, { error: "no such artifact" });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": ARTIFACT_CSP,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      res.end(doc);
      return;
    }
    if (req.method === "GET" && url.pathname === "/room" && this.roomDir) {
      // Without the trailing slash the page's relative assets resolve to the
      // root and hit the token check. Send it to /room/ with the query intact.
      res.writeHead(302, { location: `/room/${url.search}` });
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/room/") && this.roomDir) {
      const rel = url.pathname.slice("/room/".length) || "index.html";
      const safe = rel
        .replace(/\\/g, "/")
        .split("/")
        .filter((p) => p && p !== "..")
        .join("/");
      const file = path.join(this.roomDir, safe === "" ? "index.html" : safe);
      const fontsDir = path.join(this.roomDir, "..", "fonts");
      const candidate = safe.startsWith("../fonts/")
        ? path.join(fontsDir, safe.slice("../fonts/".length))
        : file;
      if (!existsSync(candidate) || statSync(candidate).isDirectory())
        return this.json(res, 404, { error: "no such file" });
      const ext = path.extname(candidate).toLowerCase();
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".png": "image/png",
        ".svg": "image/svg+xml",
      };
      res.writeHead(200, {
        "content-type": types[ext] ?? "application/octet-stream",
        "cache-control": "no-cache",
      });
      res.end(readFileSync(candidate));
      return;
    }
    const grant = this.grant(req, url);
    if (!grant) return this.json(res, 401, { error: "unauthorized" });
    // A viewer may look and may not touch.
    const reading =
      req.method === "GET" &&
      ["/state", "/sessions", "/stream", "/pins", "/backdrop"].includes(url.pathname);
    if (grant === "viewer" && !reading)
      return this.json(res, 403, { error: "viewer token: read only" });

    const answerMatch = /^POST \/pins\/([A-Za-z0-9_-]+)\/answer$/.exec(route);
    if (answerMatch) {
      const b = JSON.parse((await this.body(req)) || "{}");
      const ok = this.board.answer(answerMatch[1]!, String(b.answer ?? ""));
      return this.json(res, ok ? 200 : 404, { ok });
    }
    const removeMatch = /^DELETE \/pins\/([A-Za-z0-9_-]+)$/.exec(route);
    if (removeMatch) return this.json(res, 200, { ok: this.board.remove(removeMatch[1]!) });
    const updateMatch = /^POST \/pins\/([A-Za-z0-9_-]+)\/update$/.exec(route);
    if (updateMatch) {
      const b = JSON.parse((await this.body(req)) || "{}");
      const p = this.board.update(updateMatch[1]!, {
        title: typeof b.title === "string" ? b.title : undefined,
        body: typeof b.body === "string" ? b.body : undefined,
        kind: typeof b.kind === "string" ? b.kind : undefined,
        sticky: typeof b.sticky === "boolean" ? b.sticky : undefined,
        w: typeof b.w === "number" ? b.w : undefined,
        h: typeof b.h === "number" ? b.h : undefined,
      });
      return this.json(res, p ? 200 : 404, { ok: Boolean(p) });
    }

    switch (route) {
      case "GET /state":
        return this.json(res, 200, this.state());
      case "GET /sessions":
        return this.json(res, 200, {
          sessions: this.tracker.snapshot(),
          brief: this.tracker.brief(),
        });
      case "GET /stream":
        this.hub.subscribe(res, { sessions: this.tracker.snapshot(), mode: this.narrator.mode });
        return;
      case "POST /hook/claude": {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse((await this.body(req)) || "{}");
        } catch {
          return this.json(res, 400, { error: "bad json" });
        }
        const e = this.hook(payload);
        // A permission request holds the hook open until a spoken answer,
        // the timeout, or a newer question replaces it.
        if (e && e.kind === ev.PERMISSION && payload.hook_event_name === "PermissionRequest") {
          if (this.pending) this.answerPermission(false, this.pending.id);
          const timeoutS = Math.max(3, Number(url.searchParams.get("timeout") ?? 20));
          const p: PendingPermission = {
            id: e.id,
            session: e.session,
            repo: e.repo,
            text: this.tracker.sessions.get(e.session)?.pendingPermission ?? "",
            res,
            timer: setTimeout(() => this.answerPermission(false, e.id), timeoutS * 1000),
          };
          this.pending = p;
          res.on("close", () => {
            if (this.pending?.id === e.id) {
              clearTimeout(p.timer);
              this.pending = null;
            }
          });
          return;
        }
        const carried = this.hookReply(
          payload,
          e?.repo ?? path.basename(String(payload.cwd ?? "")),
        );
        if (carried) return this.json(res, 200, carried);
        return this.json(res, 200, { ok: true, kind: e?.kind ?? null });
      }
      case "POST /event": {
        try {
          const e = ev.fromJSON(await this.body(req));
          this.ingest(e);
          return this.json(res, 200, { ok: true, id: e.id });
        } catch (err) {
          return this.json(res, 400, { error: (err as Error).message });
        }
      }
      case "POST /speak": {
        // JSON, or plain text: the agent's own line arrives as text/plain
        // from curl with no quoting to get wrong.
        const raw = await this.body(req);
        const ctype = String(req.headers["content-type"] ?? "");
        let text = "";
        let priority = ev.SEV_MILESTONE;
        if (ctype.includes("application/json")) {
          const b = JSON.parse(raw || "{}");
          text = String(b.text ?? "").trim();
          priority = Number(b.priority ?? ev.SEV_MILESTONE);
        } else {
          text = raw.trim();
        }
        if (!text) return this.json(res, 400, { error: "no text" });
        const source = String(req.headers["x-kikoe-source"] ?? "manual");
        this.say(text.slice(0, 600), priority, source);
        return this.json(res, 200, { ok: true });
      }
      case "POST /show": {
        // The agent's whiteboard. Plain text with the details in headers, or
        // JSON. A pin with X-Kikoe-Ask holds this request until answered.
        const raw = await this.body(req);
        const ctype = String(req.headers["content-type"] ?? "");
        const h = (k: string) => String(req.headers[k] ?? "");
        let init: Parameters<Board["add"]>[0];
        if (ctype.includes("application/json")) {
          const b = JSON.parse(raw || "{}");
          init = {
            kind: b.kind,
            title: b.title,
            body: String(b.body ?? ""),
            repo: b.repo,
            ttl_s: b.ttl_s,
            sticky: Boolean(b.sticky),
            by: b.by === "you" || b.by === "kik" ? b.by : "agent",
            ask: Array.isArray(b.ask) ? b.ask.map(String) : undefined,
          };
        } else {
          init = {
            kind: h("x-kikoe-kind") || "text",
            title: h("x-kikoe-title"),
            body: raw,
            repo: h("x-kikoe-repo"),
            ttl_s: h("x-kikoe-ttl") ? Number(h("x-kikoe-ttl")) : undefined,
            sticky: h("x-kikoe-sticky") === "1" || h("x-kikoe-sticky") === "true",
            by: h("x-kikoe-by") === "you" ? "you" : "agent",
            ask: h("x-kikoe-ask") ? h("x-kikoe-ask").split(",") : undefined,
          };
        }
        if (!init.body.trim() && init.kind !== "image")
          return this.json(res, 400, { error: "nothing to show" });
        if (!init.repo) init.repo = this.lastSpokeRepo;
        if (init.kind === "diagram") {
          // The agent writes boxes and arrows; the board gets vectors.
          const svg = diagramToSvg(init.body);
          if (!svg) return this.json(res, 400, { error: "empty diagram" });
          init.kind = "svg";
          init.body = svg;
        }
        const source = h("x-kikoe-source") || "manual";
        const waitS = Math.max(
          5,
          Math.min(600, Number(h("x-kikoe-wait") || url.searchParams.get("wait") || 120)),
        );
        if (init.ask?.length) init.wait_s = waitS;
        const pin = this.board.add(init);
        log(
          `pin ${pin.id} ${pin.kind} "${pin.title}" (${pin.repo || "no repo"})${pin.ask.length ? ` asking ${pin.ask.join("/")}` : ""} from ${source}`,
        );
        if (pin.ask.length) {
          const answer = await this.board.wait(pin.id, waitS);
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(answer);
          return;
        }
        return this.json(res, 200, { ok: true, id: pin.id });
      }
      case "GET /backdrop": {
        const file = this.look().image;
        if (!file) return this.json(res, 404, { error: "no custom backdrop" });
        const ext = path.extname(file).toLowerCase();
        const types: Record<string, string> = {
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".png": "image/png",
          ".webp": "image/webp",
        };
        res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" });
        res.end(readFileSync(file));
        return;
      }
      case "GET /pins":
        return this.json(res, 200, {
          pins: this.board.list(),
          asking: this.board.asking()?.id ?? null,
        });
      case "POST /pins/clear":
        return this.json(res, 200, { ok: true, cleared: this.board.clear() });
      case "POST /say": {
        // typed to Kik on the canvas
        const b = JSON.parse((await this.body(req)) || "{}");
        const text = String(b.text ?? "").trim();
        if (!text) return this.json(res, 400, { error: "empty" });
        return this.json(res, 200, this.typed(text));
      }
      case "POST /answer": {
        const b = JSON.parse((await this.body(req)) || "{}");
        const to = this.answerWord(String(b.word ?? ""));
        return this.json(res, to ? 200 : 409, { ok: Boolean(to), to });
      }
      case "POST /heard": {
        const b = JSON.parse((await this.body(req)) || "{}");
        return this.json(
          res,
          200,
          this.hearSegment(String(b.text ?? ""), { dur_s: b.dur_s, stt_ms: b.stt_ms }),
        );
      }
      case "POST /mic": {
        // Phases from the ear: hearing, transcribing, ready, level, dead.
        const b = JSON.parse((await this.body(req)) || "{}");
        const phase = String(b.phase ?? "");
        if (phase === "ready") {
          this.micPhase = "listening";
          this.micDevice = String(b.text ?? "");
          log(`mic ready on ${this.micDevice} at ${b.rate} Hz`);
        } else if (phase === "dead") {
          this.micPhase = "dead";
          log(`mic died: ${b.text}`);
        } else if (phase === "log") log(`mic: ${b.text}`);
        else if (phase === "level") {
          /* a heartbeat with the peak; doctor reads it */
          this.micPhase = Number(b.peak) > 0.002 ? "listening" : "listening (silent input)";
        }
        // Barge-in: talking over Kik stops it. Headsets only; through
        // speakers the mic hears Kik and would cut every line.
        if (phase === "hearing" && this.settings.barge_in && this.arbiter.pending()) {
          log("barge-in: you spoke, Kik stopped");
          this.interrupt();
        }
        if (["hearing", "idle", "transcribing", "dead"].includes(phase))
          this.hub.publish("mic", { phase });
        return this.json(res, 200, { ok: true });
      }
      case "POST /interrupt":
        this.interrupt();
        return this.json(res, 200, { ok: true });
      case "POST /mode": {
        const b = JSON.parse((await this.body(req)) || "{}");
        this.setMode(String(b.mode ?? ""));
        return this.json(res, 200, { ok: true, mode: this.narrator.mode });
      }
      case "POST /permission": {
        const b = JSON.parse((await this.body(req)) || "{}");
        const ok = this.answerPermission(Boolean(b.allow), b.id ? String(b.id) : undefined);
        return this.json(res, ok ? 200 : 409, { ok, pending: this.pending?.id ?? null });
      }
      default:
        return this.json(res, 404, { error: "no such route" });
    }
  }

  /**
   * Bind loopback only. Refuses if something already answers on the port:
   * a foreign process is reported, never bound over.
   */
  async listen(port = this.settings.port): Promise<{ port: number }> {
    const existing = await probe(port);
    if (existing) {
      throw new Error(
        existing.kikoe
          ? `an kikoe daemon is already running on port ${port} (pid ${existing.pid})`
          : `something else is already listening on port ${port}`,
      );
    }
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        log(`handler error: ${(e as Error).message}`);
        if (!res.headersSent) this.json(res, 500, { error: "internal" });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
    this.timers.push(
      setInterval(() => {
        const lines = this.narrator.tick();
        if (lines.length) this.arbiter.submitAll(lines);
      }, 500),
      setInterval(() => this.board.sweep(), 5000),
      setInterval(() => {
        const dropped = unloadIdleEngines();
        if (dropped.length) log(`unloaded idle model: ${dropped.join(", ")}`);
      }, 60_000),
    );
    log(`listening on 127.0.0.1:${port}, speaker ${this.speaker.info().device}`);
    return { port };
  }

  async close(): Promise<void> {
    if (this.held) clearTimeout(this.held.timer);
    if (this.checkinTimer) clearInterval(this.checkinTimer);
    if (this.reflectTimer) clearTimeout(this.reflectTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.pending) this.answerPermission(false, this.pending.id);
    this.board.clear();
    this.arbiter.interrupt();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
    this.ladder.close();
    this.speaker.close();
  }
}

export const VERSION = "0.1.0";

/** Does a transcript echo a line we just spoke? Loose on purpose: STT paraphrases. */
export function similar(heard: string, spoken: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);
  const a = new Set(norm(heard));
  const b = norm(spoken);
  if (!a.size || !b.length) return false;
  const hits = b.filter((w) => a.has(w)).length;
  return hits / Math.max(3, a.size) > 0.6;
}

function safeSpeaker(): Speaker {
  try {
    return new RtAudioSpeaker();
  } catch (e) {
    log(`no audio device: ${(e as Error).message}; playing nothing`);
    return new NullSpeaker();
  }
}

function displayArgs(e: ev.AgentEvent): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["command", "file_path", "path", "pattern", "url", "description"]) {
    const v = e.args?.[k];
    if (v) out[k] = String(v).slice(0, 200);
  }
  return out;
}

/** Is anything answering on the port? Returns what it is, or null. */
export function probe(port: number): Promise<{ kikoe: boolean; pid?: number } | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 800 }, (res) => {
      let data = "";
      res.on("data", (c) => {
        data += c;
      });
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          resolve({ kikoe: Boolean(j.ok && j.version), pid: j.pid });
        } catch {
          resolve({ kikoe: false });
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ kikoe: false });
    });
    req.on("error", () => resolve(null));
  });
}
