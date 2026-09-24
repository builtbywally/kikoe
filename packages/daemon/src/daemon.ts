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
  readdirSync,
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
  headKnows,
  headSocial,
  normalize,
  route,
  utterance,
} from "@kikoe/core";
import { Agents } from "./agents.js";
import { Brain, type BrainTool, PERSONA } from "./brain.js";
import { type Grade, askLine, gradeOf, mustAsk } from "./capability.js";
import { CODE_PROVIDER, CodeBrain } from "./codebrain.js";
import {
  HOME,
  LOGS,
  type Settings,
  daemonToken,
  ensureHome,
  jevKeyFromFile,
  loadSettings,
  log,
  viewerToken,
  walkieToken,
} from "./config.js";
import { Hands } from "./hands.js";
import { Hub } from "./hub.js";
import {
  type Command,
  Jev,
  isYoutube,
  searchFor,
  searchQuery,
  siteSearch,
  wantsThePc,
  youtubeEmbed,
  youtubeId,
} from "./jev.js";
import { KIT_GUIDE, withKit } from "./kit.js";
import { LiveBrain } from "./livebrain.js";
import { launch, launchFor } from "./pc.js";

/** What Kik's hands can do; the real one is a kept PowerShell (hands.ts). */
export type HandsLike = Pick<
  Hands,
  | "windows"
  | "front"
  | "focus"
  | "open"
  | "type"
  | "press"
  | "controls"
  | "pressControl"
  | "screenshot"
  | "close"
>;
import { Board } from "./pins.js";
import { Projects, slug } from "./projects.js";
import { ARTIFACT_CSP, DESIGN_BRIEF, renderArtifact, stripFences } from "./runtime.js";
import {
  type Earcon,
  NullSpeaker,
  RtAudioSpeaker,
  type Speaker,
  TappedSpeaker,
  earcon,
} from "./speaker.js";
import { NO_TAILNET, type Tailnet, setServe, tailnetStatus } from "./tailnet.js";
import { Ladder, type VoiceHint, loadedEngines, unloadIdleEngines } from "./tts.js";
import { UsageStore, defaultProviders } from "./usage.js";
import { type VoicePatch, Walkie } from "./walkie.js";
import { Work } from "./work.js";

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
 * A pending permission. Either Claude Code's hook, blocked in `curl` on
 * this response — a spoken yes releases it; no, silence and timeout all
 * deny, and denial is an empty body so Claude Code falls back to its own
 * prompt — or one of Kik's own actions waiting to be allowed (`askPermission`),
 * through the same question, the same binding and the same yes.
 */
interface PendingPermission {
  id: string;
  session: string;
  repo: string;
  text: string;
  /** give the answer: writes the hook's body, or settles Kik's own wait */
  reply: (allow: boolean) => void;
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
  /^(no|nope|wrong|thats wrong|that is wrong|not that|not what i|i said|i didnt say|i did not say|i meant|actually i meant|actually i said|actually no|you misheard|you got that wrong|thats not)\b/;
/**
 * Listening noises, said while someone else talks: never an interruption.
 * One or two words, no content (docs/HEARING.md, "backchannels").
 */
const BACKCHANNEL =
  /^(yeah|yes|yep|yup|mm+|mhm+|hmm+|uh[- ]?huh|okay|ok|right|sure|cool|nice|got it|i see|go on|true|exactly|oh|ah)[.!,]*( (yeah|yes|okay|ok|right|sure))?[.!]*$/i;
/** what Kik says while the model is still thinking */
const FILLERS = ["Hm.", "One sec.", "Let me look.", "Mm."];
/** One question handed to the thinking session. */
interface Thought {
  id: string;
  question: string;
  status: "thinking" | "done" | "failed";
  started: number;
  finished: number;
  /** what was said aloud, or why it failed */
  answer: string;
  /** the card holding the detail, if there was any */
  pin: string;
  abort?: AbortController;
}

/** The thinking session's brief: think properly, then answer in a shape Kik can speak. */
const THINKER = `You are the thinking half of Kik, the voice assistant beside a developer's coding agents. The talking half handed you a question because it needs real thought. Think it through properly: the situation, the options, what could go wrong.

Then answer in this shape. First, what Kik should say aloud: at most three sentences of plain speech — no lists, markdown, code or file paths read out character by character — starting with a few words that say which question this answers ("On the retry question, …"). Give the conclusion, not the working. Then, only if detail would help the user, a line containing only --- followed by the detail in markdown: reasons, steps, a table, code. That part goes on the canvas as a card.`;

/** the first beat when the thinking is slow (Claude Code): it says it is thinking */
const THINKING = [
  "Give me a second to think about that.",
  "Let me think about that.",
  "Good question. One moment.",
  "Hm, let me look into that.",
];
/** the second beat, when nothing on the board is worth saying instead */
const STILL = ["Still thinking.", "Almost there.", "Bear with me."];

/**
 * What the user said with the name cut off, in their own spelling.
 *
 * The router's text is normalized — lower case, no punctuation — which is
 * right for matching and wrong for anything passed on: "github.com" stops
 * being an address, and an agent's task loses its commas. So the raw words
 * are dropped from the front until what is left normalizes to the router's.
 */
export function spokenRest(raw: string, routed: string): string {
  const words = raw.trim().split(/\s+/);
  for (let i = 0; i <= Math.min(3, words.length - 1); i++) {
    const rest = words.slice(i).join(" ");
    if (normalize(rest) === routed) return rest.replace(/^[\s,.!?]+/, "");
  }
  return routed || raw.trim();
}

/**
 * Whisper, stuck, repeats itself: "what what what what", or one sentence five
 * times over a long clip. A run of the same phrase (one to eight words) three
 * or more times becomes one. Two in a row is left alone: people do say
 * "no, no".
 */
export function collapseRepeats(text: string): string {
  const words = text.trim().split(/\s+/);
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  for (let n = 1; n <= 8; n++) {
    for (let i = 0; i + n * 3 <= words.length; i++) {
      const phrase = words
        .slice(i, i + n)
        .map(norm)
        .join(" ");
      if (!phrase) continue;
      let reps = 1;
      while (
        words
          .slice(i + reps * n, i + (reps + 1) * n)
          .map(norm)
          .join(" ") === phrase
      )
        reps++;
      if (reps >= 3) {
        words.splice(i + n, (reps - 1) * n);
        return collapseRepeats(words.join(" "));
      }
    }
  }
  return words.join(" ");
}

/** The site an address belongs to: "youtube.com" for the site and its player alike. */
export function siteOf(url: string): string {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^(www|m)\./, "");
    return h === "youtu.be" ? "youtube.com" : h;
  } catch {
    return "";
  }
}

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
  openrouterKey?: string;
  /** the TypeSafe key for Jev; read from ~/.kikoe/jev_key.txt when not given */
  jevKey?: string;
  /** for tests: what opening something on the PC does instead of opening it */
  launchImpl?: typeof launch;
  /** for tests: Kik's hands, instead of a real PowerShell */
  handsImpl?: HandsLike;
  /** for tests: what starts a Claude Code session for Kik's thinking */
  codeSpawn?: typeof import("node:child_process").spawn;
  /** for tests: how the tailnet is read and served; null never touches it */
  tailnetImpl?: { status: typeof tailnetStatus; serve: typeof setServe } | null;
  /** for tests: the fetch the brain uses */
  fetchImpl?: typeof fetch;
  /** keep sticky pins in ~/.kikoe/board.json (off for smoke and screenshot runs) */
  persistBoard?: boolean;
  onSpeech?: (phase: SpeechPhase, info: SpeechInfo) => void;
  /** how long after an exchange the inner note is rewritten (tests shorten it) */
  reflectMs?: number;
  /** how long the model may take before Kik says "hm" (tests shorten it) */
  fillerMs?: number;
  /** keep last-good usage readings in ~/.kikoe/usage.json ("" for none) */
  usageArchive?: string;
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
  /** the phone as a microphone, when it is switched on */
  walkie: Walkie | null = null;
  /**
   * Given raw 16 kHz PCM, what was said. Set by the app, which owns the ear;
   * without it the walkie has nothing to transcribe with and says so.
   */
  transcribe: ((pcm: Int16Array) => Promise<string>) | null = null;
  /** a name, some folders, a board; the Room shows one at a time */
  readonly projects = new Projects();
  /** agents Kik started itself, so the day need not begin in a terminal */
  readonly agents: Agents;
  /** the agent's work, as cards: diffs, commands, results, replies */
  readonly work: Work;
  /** what is left of each assistant's limit; the island's rings read this */
  readonly usage: UsageStore;
  private lastSpokeRepo = "";
  private lastSpoken: { text: string; at: number } | null = null;
  private lastRepeatable = "";
  micPhase = "off";
  /** told when the ear says it is ready, so its supervisor knows it is back */
  onMicReady?: () => void;
  /** until when an utterance without the name still counts as for us */
  private attentionUntil = 0;
  private anthropicKey = "";
  private openrouterKey = "";
  private jevKey = "";
  private readonly jevKeyGiven: boolean;
  private jevCache: Jev | null = null;
  private readonly launchImpl: typeof launch;
  private readonly handsGiven: HandsLike | null;
  private handsCache: HandsLike | null = null;
  /** app -> until when a yes to working in it still stands (writes only) */
  private grants = new Map<string, number>();
  private readonly codeSpawn: typeof import("node:child_process").spawn | undefined;
  private readonly tailnetImpl: { status: typeof tailnetStatus; serve: typeof setServe } | null;
  private readonly fetchImpl: typeof fetch;
  /** a fetch was handed in (a test), not the platform's own */
  private readonly fetchGiven: boolean;
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
  /**
   * Questions behind the one being asked. A second question used to deny the
   * first outright (the "depth-1 slot", AUDIT gap 4); now it waits its turn,
   * and the arbiter already holds its words until then.
   */
  private queued: PendingPermission[] = [];
  private kikAsks = 0;
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
    this.openrouterKey = opts.openrouterKey ?? "";
    this.jevKeyGiven = opts.jevKey !== undefined;
    this.jevKey = opts.jevKey ?? jevKeyFromFile();
    this.launchImpl = opts.launchImpl ?? launch;
    this.handsGiven = opts.handsImpl ?? null;
    this.codeSpawn = opts.codeSpawn;
    // A test never asks the real Tailscale anything, unless it passes its own.
    this.tailnetImpl =
      opts.tailnetImpl !== undefined
        ? opts.tailnetImpl
        : process.env.VITEST
          ? null
          : { status: tailnetStatus, serve: setServe };
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.fetchGiven = opts.fetchImpl !== undefined;
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
    // Tapped, so a phone on the walkie can hear Kik too. The walkie is looked
    // up on every sample, not captured: it comes and goes with its setting.
    this.speaker = new TappedSpeaker(opts.audio === false ? new NullSpeaker() : safeSpeaker(), {
      pcm: (s, r) => this.walkie?.voice(s, r),
      drop: () => this.walkie?.voiceDrop(),
    });
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
    this.board = new Board(
      (e) => {
        // Every pin says whose board it is on, so the Room can ignore one
        // that belongs to a project you are not looking at.
        this.hub.publish("pin", { ...e, project: e.pin?.project ?? "" });
        if (this.persistBoard) this.saveBoardSoon(e.pin?.project);
      },
      undefined,
      () => this.projects.current.id,
    );
    if (this.persistBoard) {
      this.loadProjects();
      this.loadBoard();
    }
    this.agents = new Agents({ bin: this.settings.claude_bin, log });
    this.work = new Work({
      board: this.board,
      projectOf: (e) => this.projects.of(e.cwd, e.repo).id,
      focus: (id) => this.hub.publish("focus", { id }),
      log,
    });
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
    // A provider switched off in the settings is not read at all — the point of
    // the switch is that its credential stays untouched, not that its ring is
    // merely hidden.
    const off = new Set(this.settings.usage_off ?? []);
    this.usage = new UsageStore({
      fetchImpl: this.fetchImpl,
      providers: defaultProviders().filter((p) => !off.has(p.id)),
      ...(opts.usageArchive !== undefined ? { archive: opts.usageArchive } : {}),
      onChange: (providers) => this.hub.publish("usage", { providers }),
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
    if (this.persistBoard) this.rememberProject(e.cwd, e.repo);
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
    if (
      lines.length &&
      this.settings.brain_narrates &&
      this.brain() &&
      !this.thinksSlowly() &&
      this.brainSpeaksFor(e)
    ) {
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
    // The limits only move while something is spending them, so the poll
    // follows the work rather than a fixed clock. A finished turn is the moment
    // the number has just changed and someone is most likely looking at it.
    this.usage.busy = [...this.tracker.sessions.values()].some((s) => s.status === "working");
    if (e.kind === ev.TURN_END) this.usageSoon();
    // The work feed last, and on the next tick: a hook is a subprocess sitting
    // in front of the agent with a three second budget, and it has already
    // been answered by the time we get here. Cards are never worth a stall.
    queueMicrotask(() => this.work.ingest(e));
    return queued;
  }

  /**
   * One poll a few seconds after a turn ends, and only one however many agents
   * finish at once. The delay is for the endpoint's benefit: it reports the
   * turn's spend a moment after the turn.
   */
  private usageTimer: NodeJS.Timeout | null = null;
  private usageSoon(): void {
    if (this.usageTimer || !this.settings.usage) return;
    this.usageTimer = setTimeout(() => {
      this.usageTimer = null;
      void this.usage.poll();
    }, 4000);
    this.usageTimer.unref();
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
  reconfigure(
    settings: Settings,
    elevenKey?: string,
    anthropicKey?: string,
    openrouterKey?: string,
  ): void {
    if (anthropicKey !== undefined) this.anthropicKey = anthropicKey;
    if (openrouterKey !== undefined) this.openrouterKey = openrouterKey;
    // A key dropped into ~/.kikoe while the app runs is picked up here.
    if (!this.jevKeyGiven) this.jevKey = jevKeyFromFile();
    this.brainCache = null;
    this.jevCache = null;
    this.interrupt();
    const old = this.ladder;
    this.settings = settings;
    this.ladder = new Ladder({ settings, ...(elevenKey ? { elevenKey } : {}) });
    old.close();
    this.narrator.setMode(settings.narrate);
    this.hub.publish("tts", { ladder: this.ladder.names, strict: this.ladder.strict });
    this.hub.publish("look", this.look());
    this.applyUsageSettings();
  }

  /** Which rings the island draws, after a settings change. */
  applyUsageSettings(settings?: Settings): void {
    if (settings) this.settings = settings;
    const off = new Set(this.settings.usage_off ?? []);
    this.usage.setProviders(
      this.settings.usage ? defaultProviders().filter((p) => !off.has(p.id)) : [],
    );
    if (this.settings.usage) this.usage.start();
    else this.usage.stop();
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
    p.reply(allow);
    this.hub.publish("permission", { id: p.id, session: p.session, allow });
    log(`permission ${p.id} ${allow ? "allowed" : "denied"} (${p.repo})`);
    this.nextPermission();
    return true;
  }

  /** Put a question in line: asked now if nothing is, or after the ones ahead. */
  private enqueuePermission(p: PendingPermission): void {
    if (!this.pending) this.pending = p;
    else this.queued.push(p);
  }

  /** The next question in line becomes the one being asked, and may be spoken. */
  private nextPermission(): void {
    this.pending = this.queued.shift() ?? null;
    this.arbiter.wake();
  }

  /**
   * A question that timed out or whose asker went away. The one being asked
   * is denied the normal way; one still in line is simply taken out of it.
   */
  private expirePermission(id: string): void {
    if (this.pending?.id === id) {
      this.answerPermission(false, id);
      return;
    }
    const i = this.queued.findIndex((q) => q.id === id);
    if (i < 0) return;
    const [q] = this.queued.splice(i, 1);
    if (q) {
      clearTimeout(q.timer);
      q.reply(false);
      log(`permission ${id} expired in line (${q.repo})`);
    }
  }

  /**
   * Ask the user before Kik does something itself: the gate every one of its
   * hands goes through. A read is free; a write is asked; an irreversible
   * action is asked and said as such, and cannot be allowed any other way.
   * Resolves to the answer; silence is a no.
   */
  askPermission(what: string, grade: Grade, timeoutS = 30): Promise<boolean> {
    if (!mustAsk(grade)) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.kikAsks = (this.kikAsks + 1) % 0xffff;
      const id = `kik-${Date.now().toString(36)}${this.kikAsks.toString(36)}`;
      const p: PendingPermission = {
        id,
        session: "kik",
        repo: "kik",
        text: what,
        reply: resolve,
        timer: setTimeout(() => this.expirePermission(id), timeoutS * 1000),
      };
      this.enqueuePermission(p);
      log(`permission ${id} asked by Kik (${grade}): ${what}`);
      this.arbiter.submitAll([
        utterance(askLine(what, grade), {
          priority: ev.SEV_ATTENTION,
          dedupe: `perm:${id}`,
          eventId: id,
          session: "kik",
          ttl: timeoutS,
        }),
      ]);
      this.hub.publish("event", { kind: "permission", repo: "kik", text: what, id });
    });
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
    opts: {
      force?: boolean;
      decided?: boolean;
      via?: "phone";
      /** Jev's answer, already asked for while deciding whether this was for us */
      pre?: Promise<Command | null>;
    } = {},
  ): { kind: string; intent: string; said?: string } {
    const clean = collapseRepeats(text.trim());
    // Whisper names sounds it cannot read as words: "[buzzing]", "(music)",
    // or a lone "(". Nothing was said, so nothing is routed, answered or kept.
    if (clean && !/\p{L}/u.test(clean.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ""))) {
      log(`heard only a noise tag, dropped (${clean.length} chars)`);
      this.hub.publish("mic", { phase: "idle" });
      return { kind: "empty", intent: "" };
    }
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
    let d = route(clean, {
      aliases,
      awaitingAnswer: awaiting,
      offered,
      attending,
      // A sentence with "you" in it used to count as said to Kik outright,
      // which is how a game in the room reached an agent 181 times. With Jev
      // there, it is judged like any other nameless sentence; the rule is
      // kept only for when there is no Jev to ask.
      youQuestions: this.settings.hear_you !== false && this.jev() === null,
    });
    // "switch to X" is a board only if X is a project: "switch to chrome" is
    // a window, and goes on to the switchboard.
    if (d.kind === "control" && d.intent === "focus" && !this.projects.resolve(d.arg))
      d = { ...d, kind: "work", intent: "instruct", arg: "" };
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
      void this.decideDirected(clean, meta, opts.via);
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

    // "Which project?" was asked; a name now answers it, whatever else it is.
    const asked = this.askedProject;
    if (asked && Date.now() < asked.until) {
      const p = this.projects.resolve(d.text || clean);
      if (p) {
        this.askedProject = null;
        void this.carryOut({ ...asked.command, project: p.name, projectSure: 1 }, clean, d, record);
        return { kind: "command", intent: asked.command.action };
      }
    }
    this.askedProject = null;

    // Questions and work go past the switchboard first: Kik, the agent, a new
    // session, the PC. Social and control never do; a hello needs no judge
    // and a stop must be instant.
    if ((d.kind === "question" || d.kind === "work") && this.jev() !== null) {
      this.hub.publish("mic", { phase: "thinking", text: clean });
      void this.dispatch(clean, d, record, opts.via, opts.pre);
      return { kind: "deciding", intent: d.kind };
    }
    return this.respond(d, clean, record);
  }

  /** What was heard, answered the way it was before the switchboard: the model, or the rules. */
  private respond(
    d: ReturnType<typeof route>,
    clean: string,
    record: (kind: string, intent: string, said?: string) => void,
  ): { kind: string; intent: string; said?: string } {
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
        said = headSocial(d.intent, d.text);
        break;
      case "work":
        // This used to be "say it to the terminal", which was true when
        // there was nothing to hand an instruction to. There is now: it goes
        // to whichever agent is running, and starts one if none is. It lives
        // in the rulebook rather than the model because the first thing you
        // ask for in a morning should not depend on an account balance.
        said = sentence(this.instruct(d.text || clean));
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

  // --- the switchboard ---------------------------------------------------------------

  /**
   * Something real to say while thinking, in place of a second "hm": an
   * agent waiting on the user, or one that failed. Never the same thing twice
   * in ten minutes; null when the board has nothing worth it.
   */
  private meanwhile(): string | null {
    const s = Object.values(this.tracker.snapshot());
    const waiting = s.find((x) => x.status === "waiting");
    const failed = s.find((x) => x.status === "failed");
    const line = waiting
      ? `Meanwhile, ${waiting.label} is waiting on you.`
      : failed
        ? `Meanwhile, ${failed.label} hit an error.`
        : null;
    if (!line) return null;
    if (this.lastMeanwhile.text === line && Date.now() - this.lastMeanwhile.at < 600_000)
      return null;
    this.lastMeanwhile = { text: line, at: Date.now() };
    return line;
  }
  private lastMeanwhile = { text: "", at: 0 };

  // --- the thinking session ------------------------------------------------------------

  /**
   * What Kik said aloud or learned outside a reply since the last message: a
   * filler, a thought that came back. The talking session is told on its next
   * message, so it never disowns something it said ("what do you mean, let me
   * look into that?" was asked, and the old head had no idea).
   */
  private asides: string[] = [];
  private sayAside(line: string, why = "while getting your answer ready"): void {
    this.say(line, ev.SEV_MILESTONE, "head");
    this.asides.push(`You said aloud ${why}: "${line}"`);
    this.asides = this.asides.slice(-6);
  }

  private thoughts: Thought[] = [];
  private thoughtSeq = 0;

  /**
   * Hand a question to the thinking session: a separate Claude Code run with
   * extended thinking and the stronger model, in the background. The talking
   * session carries on; the answer is spoken when it lands and its detail, if
   * any, goes on the canvas. The "kik · thinking" card shows it working.
   */
  think(question: string, context = ""): string {
    const bin = this.agents.bin();
    if (!bin) return "there is no Claude Code on this machine to think with";
    const q = question.trim();
    if (!q) return "what should I think about?";
    if (this.thoughts.filter((t) => t.status === "thinking").length >= 2)
      return "two thoughts are already running; answer from what you know, or wait for them";
    const t: Thought = {
      id: `t${++this.thoughtSeq}`,
      question: q,
      status: "thinking",
      started: Date.now(),
      finished: 0,
      answer: "",
      pin: "",
      abort: new AbortController(),
    };
    this.thoughts = [t, ...this.thoughts].slice(0, 8);
    this.publishThoughts();
    const model = this.settings.think_model || "opus";
    const thinker = new CodeBrain({
      bin,
      model,
      dir: path.join(HOME, "brain"),
      log,
      ...(this.codeSpawn ? { spawnImpl: this.codeSpawn } : {}),
    });
    const prompt = [
      `The question: ${q}`,
      context ? `What Kik knows that bears on it: ${context}` : "",
      `The live picture:\n${this.brainSystem().slice(PERSONA.length).trim()}`,
      this.brainCache ? `The recent conversation:\n${this.brainCache.recent(6)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    log(`thinking: ${t.id} on ${model}`);
    thinker
      .generate(prompt, THINKER, {
        model,
        think: 12_000,
        ...(t.abort ? { signal: t.abort.signal } : {}),
      })
      .then((out) => this.thought(t, out))
      .catch((e) => {
        t.status = "failed";
        t.finished = Date.now();
        t.answer = (e as Error).message.slice(0, 200);
        log(`thinking: ${t.id} failed: ${t.answer}`);
        this.publishThoughts();
        this.sayAside("My thinking on that didn't finish.", "when a thought failed");
      });
    return `thinking started as ${t.id}; tell the user in a few words that you are on it, and carry on`;
  }

  /** A thought landed: say it, put its detail on the canvas, tell the talking session. */
  private thought(t: Thought, out: string): void {
    const [spokenPart, ...rest] = out.split(/^\s*---\s*$/m);
    const spoken = (spokenPart ?? "").trim() || "I thought it through; it's on the canvas.";
    const detail = rest.join("\n---\n").trim();
    t.status = "done";
    t.finished = Date.now();
    t.answer = spoken;
    if (detail) {
      const pin = this.board.add({
        kind: "markdown",
        title: `thought · ${t.question.slice(0, 48)}`,
        body: detail,
        project: this.projects.current.id,
        repo: "kik",
        by: "kik",
        ttl_s: 86_400,
      });
      t.pin = pin.id;
    }
    log(`thinking: ${t.id} done in ${Math.round((t.finished - t.started) / 1000)} s`);
    this.publishThoughts();
    this.say(spoken, ev.SEV_ATTENTION, "head");
    this.asides.push(
      `Your thinking on "${t.question.slice(0, 120)}" came back, and you said it aloud: ${spoken}${detail ? " (the detail is on the canvas)" : ""}`,
    );
    this.asides = this.asides.slice(-6);
    this.rememberExchange(`(thinking) ${t.question}`, spoken);
  }

  /** The thoughts, for the Room's thinking card: newest first, no controllers. */
  thoughtsView(): Array<Omit<Thought, "abort">> {
    return this.thoughts.map(({ abort: _, ...t }) => t);
  }
  private publishThoughts(): void {
    this.hub.publish("thinking", { thoughts: this.thoughtsView() });
  }

  /** when Kik last said its model account is out of credit */
  private creditNoticeAt = 0;

  /** A command that stopped to ask "which project?", waiting for the name. */
  private askedProject: { command: Command; until: number } | null = null;

  /**
   * Ask Jev what to do with an addressed sentence, then do it. Anything Jev
   * is unsure of, or says is Kik's own, goes on the way it always went, so
   * a slow network or a missing key changes nothing but speed.
   */
  private async dispatch(
    clean: string,
    d: ReturnType<typeof route>,
    record: (kind: string, intent: string, said?: string) => void,
    via?: "phone",
    pre?: Promise<Command | null>,
  ): Promise<void> {
    const jev = this.jev();
    const t0 = Date.now();
    // `pre` is the answer already asked for alongside "was that for me?"
    const c = pre
      ? await pre
      : jev
        ? await jev.command(spokenRest(clean, d.text), this.commandContext())
        : null;
    if (c)
      log(
        `jev: ${c.action} ${c.sure.toFixed(2)}${c.project ? ` in ${c.project} ${c.projectSure.toFixed(2)}` : ""} (${Date.now() - t0} ms)`,
      );
    // A look-up with a site already open is a search there, whatever Jev made
    // of it: "look up low five please", with YouTube on the canvas, reached
    // the talking session, which said it could not search the web.
    const asked = spokenRest(clean, d.text);
    const recentSite =
      this.lastCanvasSite && Date.now() - this.lastCanvasSite.at < 30 * 60_000
        ? siteOf(this.lastCanvasSite.url)
        : "";
    if (
      c &&
      (c.action === "kik" || c.sure < Daemon.JEV_SURE) &&
      recentSite &&
      /^(?:please |can you |could you |now )*(?:look(?:ing)? up|search(?:ing)? for|search|find|play)\b/i.test(
        asked,
      )
    ) {
      log(`jev: ${c.action} ${c.sure.toFixed(2)}, but it is a look-up; searching ${recentSite}`);
      c.action = "canvas";
      c.sure = 1;
      c.url = "";
    }
    if (!c || c.action === "kik" || c.sure < Daemon.JEV_SURE) {
      this.respond(d, clean, record);
      return;
    }
    const said = asked;
    const toPc = wantsThePc(said);
    // "Search lo-fi" with no site said means the site already open: the last
    // one put on the canvas, if it was in the last half hour.
    if (
      (c.action === "open" || c.action === "canvas") &&
      !c.url &&
      searchQuery(said) &&
      this.lastCanvasSite &&
      Date.now() - this.lastCanvasSite.at < 30 * 60_000
    ) {
      const site = siteOf(this.lastCanvasSite.url);
      if (site) {
        c.url = `https://www.${site}`;
        c.open = "website";
        log(`jev: no site named; searching the open one, ${site}`);
      }
    }
    // "On the desktop, please" right after a card: the site on that card, on
    // the PC. Without this the follow-up had no address in it and did nothing.
    if (toPc && c.action === "open" && !c.url && this.lastCanvasSite) {
      if (Date.now() - this.lastCanvasSite.at < 120_000) {
        c.url = this.lastCanvasSite.url;
        c.open = "website";
      }
    }
    // A site nobody named is not guessed (it made low-fi.com and file.com):
    // what was asked for is searched for, and Kik says so.
    if (
      !c.url &&
      (c.action === "canvas" ||
        (c.action === "open" && (c.open === "website" || c.open === "browser")))
    ) {
      const q = searchFor(said);
      if (q) {
        c.url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
        c.open = "website";
        log(`jev: no site named; searching Google for "${q}"`);
      }
    }
    // From the phone, "open YouTube" in the desk's browser helps nobody on
    // the couch; the canvas is the screen they are holding. Unless they said
    // where: "on my computer", "on the desktop", "in Chrome" mean the PC.
    if (
      via === "phone" &&
      !toPc &&
      c.action === "open" &&
      (c.open === "website" || c.open === "browser") &&
      c.url
    )
      c.action = "canvas";
    // And the other way: Jev heard "canvas", but the sentence names the PC.
    if (toPc && c.action === "canvas" && c.url) {
      c.action = "open";
      c.open = "website";
    }
    // A project half-heard is asked about rather than guessed: starting work
    // in the wrong repo is worse than one short question.
    const needsProject = c.action === "agent" || c.action === "new_session" || c.action === "open";
    if (needsProject && c.project && c.projectSure < Daemon.JEV_PROJECT_SURE) {
      const other = this.projects
        .all()
        .map((p) => p.name)
        .find((n) => n !== c.project && n !== this.projects.current.name);
      const said = `Which project, ${c.project}${other ? ` or ${other}` : ""}?`;
      this.askedProject = { command: c, until: Date.now() + ATTENTION_MS };
      record(d.kind, `ask:${c.action}`, said);
      this.openWindow(clean, said);
      this.say(said, ev.SEV_ATTENTION, "head");
      this.hub.publish("mic", { phase: "idle" });
      return;
    }
    await this.carryOut(c, clean, d, record);
  }

  /** What Jev is told beside the sentence: the projects, what is running, the last exchange. */
  private commandContext() {
    const current = this.projects.current.name;
    return {
      projects: [
        current,
        ...this.projects
          .all()
          .map((p) => p.name)
          .filter((n) => n !== current),
      ],
      current,
      running: this.tracker.brief(),
      last: this.lastExchange.at
        ? `User: ${this.lastExchange.you} | Kik: ${this.lastExchange.kik}`
        : "",
    };
  }

  /** Jev only lets this through above this; below it, the old path answers. */
  private static readonly JEV_SURE = 0.6;
  /** A named project below this is asked about, not assumed. */
  private static readonly JEV_PROJECT_SURE = 0.5;

  private async carryOut(
    c: Command,
    clean: string,
    d: ReturnType<typeof route>,
    record: (kind: string, intent: string, said?: string) => void,
  ): Promise<void> {
    const project = c.project ? this.projects.resolve(c.project) : undefined;
    let said: string;
    switch (c.action) {
      case "new_session":
        said = sentence(this.startAgent(project?.name ?? "", c.task, { fresh: true }));
        break;
      case "agent":
        said = sentence(this.instruct(c.task, project?.name));
        break;
      case "open": {
        if (c.open === "app" && c.app) {
          said = sentence(await this.openApp(c.app));
          break;
        }
        // A named site and a subject open the site's search, not its front page.
        const rest = spokenRest(clean, d.text);
        said = sentence(this.openOnPc({ ...c, url: siteSearch(c.url, rest) }, project));
        break;
      }
      case "canvas": {
        const rest = spokenRest(clean, d.text);
        said = sentence(await this.showOnCanvas(siteSearch(c.url, rest), searchQuery(rest)));
        break;
      }
      case "think": {
        // Straight to the thinking session: the talking one would only have
        // handed it over. Said before it starts, so the user knows at once.
        const r = this.think(spokenRest(clean, d.text));
        said = /^thinking started/.test(r)
          ? "On it. I'll think that through and come back to you."
          : sentence(r);
        break;
      }
      case "stop_agent": {
        const n = this.agents.stop(project?.id);
        said = n ? "Stopped it." : "Nothing of mine is running.";
        break;
      }
      default:
        this.respond(d, clean, record);
        return;
    }
    record(d.kind, c.action, said);
    this.rememberExchange(clean, said);
    this.openWindow(clean, said);
    this.say(said, ev.SEV_ATTENTION, "head");
    this.hub.publish("mic", { phase: "idle" });
  }

  /**
   * A site on the canvas, as a live web card, where "open YouTube here" means
   * here: in the Room, on whichever screen is looking. The same card the
   * model's create_artifact makes, so it looks and behaves the same.
   */
  async showOnCanvas(url: string, query = ""): Promise<string> {
    // YouTube will not be shown inside another page on a phone, and its
    // homepage never can be; its player can. So a YouTube ask becomes the
    // player: the video named, or the top result for what was asked for.
    let body = url;
    let title = url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/.*$/, "");
    // a search says what it looked for, so "google.com" is not all Kik says
    const q = /[?&](?:q|query|search_query|k|search)=([^&]+)/.exec(url)?.[1];
    if (q) title = `${title.replace(/\.com$/, "")} · ${decodeURIComponent(q.replace(/\+/g, " "))}`;
    if (isYoutube(url) || (query && !url)) {
      const id = youtubeId(url) || (query ? await this.youtubeSearch(query) : "");
      if (id) {
        body = youtubeEmbed(id);
        title = query ? `youtube · ${query}` : "youtube";
      } else if (query) {
        return `I couldn't find ${query} on YouTube`;
      }
    }
    if (!/^https?:\/\//i.test(body)) return "which site?";
    const name = title;
    // A site already on the canvas is where the next look-up goes: "open
    // YouTube", then "search lo-fi on YouTube", made a second card beside
    // the first, the way no one uses a browser.
    const site = siteOf(body);
    const open = this.board
      .list(this.projects.current.id)
      .filter((p) => p.kind === "web" && siteOf(p.body) === site)
      .sort((a, b) => b.updated - a.updated)[0];
    if (open) {
      this.board.update(open.id, { body, title: name });
      this.hub.publish("focus", { id: open.id });
      log(`canvas: ${name} in the open card ${open.id}`);
      this.lastCanvasSite = { url: url || body, at: Date.now() };
      return `${name} is on the canvas`;
    }
    const pin = this.board.add({
      kind: "web",
      title: name,
      body,
      project: this.projects.current.id,
      repo: "kik",
      by: "kik",
      size: "wide",
      ttl_s: 3600,
    });
    this.hub.publish("focus", { id: pin.id });
    log(`canvas: ${name} as ${pin.id}`);
    // The site as it was asked for, not its player: "on the desktop, please"
    // opens it in the PC's browser, where youtube.com itself works.
    this.lastCanvasSite = { url: url || body, at: Date.now() };
    return `${name} is on the canvas`;
  }

  /** The last site put on the canvas, for "no, on the desktop". */
  private lastCanvasSite: { url: string; at: number } | null = null;

  /**
   * The top YouTube video for a query, read from the results page: the first
   * video id in it. No key and no API; if YouTube changes its page, this
   * finds nothing and Kik says so rather than showing the wrong thing.
   */
  async youtubeSearch(query: string): Promise<string> {
    try {
      const r = await this.fetchImpl(
        `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
        {
          headers: {
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
            "accept-language": "en",
          },
          signal: AbortSignal.timeout(6000),
        },
      );
      const html = await r.text();
      const id = /"videoId":"([\w-]{11})"/.exec(html)?.[1] ?? "";
      log(`youtube: "${query}" -> ${id || "nothing"}`);
      return id;
    } catch (e) {
      log(`youtube: search failed: ${(e as Error).message}`);
      return "";
    }
  }

  /** The editor, a folder, a terminal or a site, from a fixed menu. */
  /**
   * An app by name, with the hands: brought to the front if it is already
   * open, started if not. Asked first, like anything the hands do.
   */
  async openApp(name: string): Promise<string> {
    const hands = this.hands();
    if (!hands)
      return `I can't open ${name} with my hands switched off. Settings, "Let Kik use this PC"`;
    const low = name.toLowerCase();
    const open = (await hands.windows().catch(() => [])).find(
      (w) => w.name.toLowerCase().includes(low) || w.title.toLowerCase().includes(low),
    );
    if (open)
      return this.withLeave(
        `switch to ${open.title || open.name}`,
        "",
        async () => {
          const w = await hands.focus(low);
          return w ? `${w.name} is in front` : `I couldn't bring ${name} forward`;
        },
        "switching windows",
      );
    return this.withLeave(
      `open ${name}`,
      "",
      async () => `${await hands.open(name)}`,
      `open ${low}`,
    );
  }

  openOnPc(c: Command, named?: { name: string; roots: string[] }): string {
    if (!this.settings.pc) return "opening things on this PC is switched off in Settings";
    const p = named ?? this.projects.current;
    const dir = p.roots[0] ?? "";
    const l = launchFor(c.open, { dir, url: c.url, name: p.name });
    if (typeof l === "string") return l;
    this.launchImpl(l, dir, log);
    log(`pc: ${c.open} -> ${l.bin} ${l.args.join(" ")}`);
    return l.said;
  }

  /**
   * Is the head Claude Code? Then every thought is a process and four to
   * seven seconds on the user's subscription, so only what the user asks for
   * goes through it: the conversation and the designer. Narration, the
   * minute check-in and the inner note stay on the rules.
   */
  private thinksSlowly(): boolean {
    return (this.settings.brain_provider || "anthropic") === CODE_PROVIDER;
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
    if (!brain || !this.settings.brain_checkin || this.thinksSlowly()) return;
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
    return this.settings.hear_you && (this.jev() !== null || this.brain() !== null);
  }

  private async decideDirected(
    text: string,
    meta: { dur_s?: number; stt_ms?: number },
    via?: "phone",
  ): Promise<void> {
    const brain = this.brain();
    let yes = false;
    let by = "nobody";
    let pre: Promise<Command | null> | undefined;
    // While Kik is speaking, the question is not "was that for me" but "is
    // that an interruption" (the user, 2026-09-24: with an open mic, "Jev
    // needs to understand if I'm interrupting"). A backchannel — "yeah",
    // "mm", "okay" — never is, and is not even asked about; anything else is
    // Jev's to judge against the line being spoken.
    const speaking = this.arbiter.state().current;
    if (speaking) {
      if (BACKCHANNEL.test(text.trim())) {
        log(`heard a backchannel while Kik spoke; carrying on (${text.split(/\s+/).length} words)`);
        return;
      }
      const p = (await this.jev()?.interrupting(speaking, text)) ?? null;
      if (p !== null) {
        // 0.7, not 0.5: on real sentences every interruption scored 0.91 or
        // more, and "okay so where did I put my keys" 0.61. Cutting Kik off
        // for nothing costs more than hearing it finish.
        log(`interrupting? ${p >= 0.7 ? "yes" : "no"} by jev ${p.toFixed(2)}`);
        if (p < 0.7) return;
        this.interrupt();
        this.hear(text, meta, { force: true, decided: true, ...(via ? { via } : {}) });
        return;
      }
    }
    try {
      const ago = this.lastExchange.at
        ? Math.round((Date.now() - this.lastExchange.at) / 1000)
        : -1;
      const last = this.lastExchange.at
        ? `${ago} seconds ago. User: ${this.lastExchange.you}\nKik: ${this.lastExchange.kik}`
        : "(no exchange yet)";
      // Jev first: a typed yes/no is what this question is, and a prompted
      // chat model is the setup the research calls the worst at it
      // (docs/HEARING.md). The model is the fallback, not the judge.
      //
      // And "what should happen with it" is asked at the same moment, not
      // after: the two together take ~310 ms where one then the other took
      // ~590. If the answer is no, the second is thrown away unread.
      const jev = this.jev();
      if (jev) pre = jev.command(text, this.commandContext());
      const p = (await jev?.directed(text, last)) ?? null;
      if (p !== null) {
        yes = p >= 0.5;
        by = `jev ${p.toFixed(2)}`;
      } else if (brain) {
        yes = await brain.directed(text, last);
        by = "model";
      }
    } catch (e) {
      log(`directed check failed: ${(e as Error).message}`);
    }
    log(`follow-up? ${yes ? "yes" : "no"} by ${by} (${text.split(/\s+/).length} words)`);
    this.hear(
      text,
      meta,
      yes
        ? { force: true, decided: true, ...(pre ? { pre } : {}), ...(via ? { via } : {}) }
        : { decided: true },
    );
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
    if (this.reflectTimer || !this.brain() || this.thinksSlowly()) return;
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

  // --- boards on disk: one per project, back the way it was left ------------------
  //
  // A board used to be one file and the renderer's own note said it was "as
  // ephemeral as speech": positions lived in a Map and died on reload. That
  // was right for a whiteboard and wrong for a workspace, so pins now carry
  // x and y and each project keeps its own file.
  private boardTimer: NodeJS.Timeout | null = null;
  private readonly persistBoard: boolean;
  private readonly dirtyBoards = new Set<string>();
  /** the single board from before projects; read once, then left alone */
  private legacyBoardFile(): string {
    return path.join(HOME, "board.json");
  }
  private boardsDir(): string {
    return path.join(HOME, "boards");
  }
  private boardFile(project: string): string {
    return path.join(this.boardsDir(), `${project || "kik"}.json`);
  }
  private projectsFile(): string {
    return path.join(HOME, "projects.json");
  }

  private loadProjects(): void {
    try {
      if (!existsSync(this.projectsFile())) return;
      const n = this.projects.load(JSON.parse(readFileSync(this.projectsFile(), "utf8")));
      if (n) log(`projects: ${n} back from disk, current ${this.projects.current.id}`);
    } catch (e) {
      log(`projects: could not read: ${(e as Error).message}`);
    }
  }

  /**
   * The projects sitting beside the ones we already know.
   *
   * A project registers itself the first time a hook arrives from it, which
   * is fine except that "open Marine" then fails until an agent has run in
   * Marine — and the whole point is to open a board before there is anything
   * on it. So when a folder becomes a project, its siblings become projects
   * too: one directory listing, no file is read, and only folders that are
   * repos count. Nothing is scanned that is not next door to somewhere the
   * user has already run an agent.
   */
  discoverSiblings(root: string): number {
    if (!root) return 0;
    const parent = path.dirname(root);
    if (!parent || parent === root) return 0;
    let found = 0;
    try {
      for (const entry of readdirSync(parent, { withFileTypes: true }).slice(0, 60)) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const dir = path.join(parent, entry.name);
        if (!existsSync(path.join(dir, ".git"))) continue;
        const known = this.projects.get(slug(entry.name));
        this.projects.of(dir, entry.name);
        if (!known) found++;
      }
    } catch (e) {
      log(`projects: could not look beside ${parent}: ${(e as Error).message}`);
    }
    return found;
  }

  private readonly scanned = new Set<string>();

  /** A hook came from somewhere; make sure that place, and its neighbours, exist. */
  private rememberProject(cwd: string, repo: string): void {
    if (!cwd) return;
    const p = this.projects.of(cwd, repo);
    const root = p.roots[0] ?? cwd;
    if (this.scanned.has(root)) return;
    this.scanned.add(root);
    const n = this.discoverSiblings(root);
    if (n) log(`projects: found ${n} beside ${p.id}`);
    this.saveProjects();
  }

  private saveProjects(): void {
    if (!this.persistBoard) return;
    try {
      mkdirSync(HOME, { recursive: true });
      writeFileSync(this.projectsFile(), JSON.stringify(this.projects.toJSON()));
    } catch (e) {
      log(`projects: could not write: ${(e as Error).message}`);
    }
  }

  /**
   * Every project's board, and the old single board once.
   *
   * The migration is deliberately non-destructive: `board.json` is read and
   * left where it is, so a downgrade still finds its pins.
   */
  private loadBoard(): void {
    try {
      if (existsSync(this.boardsDir())) {
        let n = 0;
        for (const f of readdirSync(this.boardsDir())) {
          if (!f.endsWith(".json")) continue;
          const id = f.slice(0, -5);
          this.projects.ensure(id, "");
          n += this.board.load(JSON.parse(readFileSync(path.join(this.boardsDir(), f), "utf8")));
        }
        if (n) log(`boards: ${n} pins back from disk`);
        return;
      }
      if (!existsSync(this.legacyBoardFile())) return;
      const raw = JSON.parse(readFileSync(this.legacyBoardFile(), "utf8"));
      const n = this.board.load(raw);
      if (n) {
        // Pins from before projects have no project; they belong to whatever
        // is current, which on a first run is the only one there is.
        const here = this.projects.current.id;
        for (const p of this.board.list()) if (!p.project) p.project = here;
        for (const id of this.board.projects()) this.dirtyBoards.add(id);
        this.saveBoardSoon();
        log(`boards: migrated ${n} pins from board.json into ${here}`);
      }
    } catch (e) {
      log(`boards: could not read: ${(e as Error).message}`);
    }
  }

  private saveBoardSoon(project?: string): void {
    if (project !== undefined) this.dirtyBoards.add(project);
    else for (const id of this.board.projects()) this.dirtyBoards.add(id);
    if (this.boardTimer) return;
    this.boardTimer = setTimeout(() => {
      this.boardTimer = null;
      const todo = [...this.dirtyBoards];
      this.dirtyBoards.clear();
      try {
        mkdirSync(this.boardsDir(), { recursive: true });
        for (const id of todo) {
          writeFileSync(this.boardFile(id), JSON.stringify(this.board.toJSON(id)));
        }
      } catch (e) {
        log(`boards: could not write: ${(e as Error).message}`);
      }
    }, 300);
    this.boardTimer.unref();
  }

  /**
   * Whose board a new pin belongs on.
   *
   * Kik's own artifacts go on the board you are looking at — it made them for
   * this conversation. An agent's pin goes to the project its repo names, if
   * that is a project, and otherwise keeps you company on the current one.
   */
  projectFor(repo?: string): string {
    if (repo && repo !== "kik") {
      const p = this.projects.resolve(repo);
      if (p) return p.id;
    }
    return this.projects.current.id;
  }

  /**
   * Look at another project: the whole Room swaps. Everything else keeps
   * running — an agent in a project you are not watching still works, still
   * makes cards, and can still interrupt you for a permission.
   */
  openProject(spoken: string): string {
    const found = this.projects.resolve(spoken);
    if (!found) {
      const names = this.projects
        .all()
        .slice(0, 4)
        .map((p) => p.name)
        .join(", ");
      return names ? `no project by that name; there is ${names}` : "no projects yet";
    }
    this.projects.open(found.id);
    // What the ear called it, so the next time is direct rather than fuzzy.
    this.projects.learn(found.id, spoken);
    this.saveProjects();
    this.publishProject();
    log(`project: opened ${found.id}`);
    return `opened ${found.name}`;
  }

  /** The whole board for the current project, in one frame, so a swap is one render. */
  publishProject(): void {
    const p = this.projects.current;
    this.hub.publish("project", {
      id: p.id,
      name: p.name,
      pins: this.board.list(p.id),
      projects: this.projects.all().map((x) => ({ id: x.id, name: x.name })),
    });
  }

  /** The user typed to Kik on the canvas: addressed, no name needed. */
  typed(text: string, via?: "phone"): { kind: string; intent: string; said?: string } {
    return this.hear(text, {}, { force: true, decided: true, ...(via ? { via } : {}) });
  }

  // --- the phone as a microphone --------------------------------------------------

  /**
   * Start or stop the walkie server to match the setting.
   *
   * Called on boot and whenever the setting changes. Off is the default and
   * off means the socket is closed, not merely ignored: this is the one
   * listener Kikoe has that is not loopback.
   */
  async syncWalkie(): Promise<void> {
    await this.syncWalkieServer();
    await this.syncTailnet();
  }

  /** Where this machine sits on a tailnet, if it does; read on every walkie change. */
  tailnet: Tailnet = NO_TAILNET;

  /**
   * Keep our Tailscale Serve rule in step with the walkie: up while the
   * walkie is on and the user asked for it, down otherwise. Only ever the
   * rule pointing at the walkie; any other serve config is the user's.
   */
  async syncTailnet(): Promise<void> {
    const port = this.settings.walkie_port || 4571;
    const ts = this.tailnetImpl;
    if (ts === null) return;
    this.tailnet = await ts.status(port);
    if (!this.tailnet.running) return;
    const want = this.walkie !== null && this.settings.walkie_tailscale;
    if (want && !this.tailnet.serving) {
      const r = await ts.serve(true, port);
      log(`tailscale: ${r.said}`);
      this.tailnetNote = r.ok ? "" : r.said;
    } else if (!want && this.tailnet.serving) {
      const r = await ts.serve(false, port);
      log(`tailscale: ${r.said}`);
    } else return;
    this.tailnet = await ts.status(port);
  }
  /** why the serve rule could not be put up, for Settings to show */
  tailnetNote = "";

  private async syncWalkieServer(): Promise<void> {
    const want = this.settings.walkie;
    if (want && !this.walkie) {
      // The canvas goes to the phone too, when there is a Room to serve: the
      // phone reads through the walkie as a viewer and talks as the walkie.
      const bound = this.server?.address();
      const daemonPort = bound && typeof bound === "object" ? bound.port : this.settings.port;
      this.walkie = new Walkie({
        port: this.settings.walkie_port || 4571,
        token: walkieToken(),
        onAudio: (pcm, open) => this.walkieHeard(pcm, open === true),
        // the voice settings, from the phone; the app fills `phoneVoice`
        onVoice: {
          get: () => this.phoneVoice?.get() ?? {},
          set: (p) => this.phoneVoice?.set(p) ?? {},
        },
        onText: (text) => {
          log(`walkie: typed ${text.split(/\s+/).length} words`);
          return this.typed(text, "phone").kind;
        },
        ...(this.roomDir ? { room: { port: daemonPort, viewer: this.viewer } } : {}),
        log,
      });
      try {
        await this.walkie.start();
      } catch (e) {
        log(`walkie: could not start: ${(e as Error).message}`);
        this.walkie = null;
      }
      return;
    }
    if (!want && this.walkie) {
      const w = this.walkie;
      this.walkie = null;
      await w.stop();
    }
  }

  /**
   * A held button on a phone, transcribed and treated as spoken to Kik.
   *
   * Push to talk is its own answer to "was that for me": you held a button
   * on a page called Kik, so the name gate and the model judgement are
   * skipped and it goes straight in as addressed.
   */
  /** Kik's voice settings as the phone sees and changes them; set by the app. */
  phoneVoice?: {
    get: () => Promise<unknown> | unknown;
    set: (patch: VoicePatch) => Promise<unknown> | unknown;
  };

  private async walkieHeard(pcm: Int16Array, openMic = false): Promise<string> {
    if (!this.transcribe) {
      log("walkie: no ear to transcribe with");
      return "";
    }
    this.hub.publish("mic", { phase: "transcribing", source: "walkie" });
    // the handshake happens while Whisper listens, not after it
    this.jev()?.warm();
    const t0 = Date.now();
    const text = (await this.transcribe(pcm)).trim();
    log(`walkie: heard "${text}" in ${Date.now() - t0} ms`);
    if (!text) {
      this.hub.publish("mic", { phase: "idle" });
      return "";
    }
    // A held button is its own "this is for you". The open mic is not: what
    // it hears is judged like anything the headset overhears.
    if (openMic) this.hear(text, {}, { via: "phone" });
    else this.hear(text, {}, { force: true, decided: true, via: "phone" });
    return text;
  }

  /** The switchboard, when there is a key and the setting is on. */
  jev(): Jev | null {
    if (!this.settings.jev || !this.jevKey) return null;
    if (!this.jevCache)
      // A test's fake fetch goes to Jev; the real one does not, because Jev's
      // own kept-open connection is ~450 ms faster than fetch's (jev.ts).
      this.jevCache = new Jev({
        key: this.jevKey,
        ...(this.fetchGiven ? { fetchImpl: this.fetchImpl } : {}),
        log,
      });
    return this.jevCache;
  }

  /** Kik's hands on this PC, when the setting is on (Windows only). */
  hands(): HandsLike | null {
    if (!this.settings.hands) return null;
    if (this.handsGiven) return this.handsGiven;
    if (process.platform !== "win32") return null;
    if (!this.handsCache) this.handsCache = new Hands({ log });
    return this.handsCache;
  }

  /**
   * Do something with the hands that changes the PC: asked first, through
   * the permission gate. A yes to working in an app stands for two minutes,
   * so typing a paragraph is not a question per key — for writes only: an
   * irreversible action is asked every time, and no yes carries over to it.
   */
  private async withLeave(
    what: string,
    detail: string,
    act: () => Promise<string>,
    scope?: string,
  ): Promise<string> {
    const hands = this.hands();
    if (!hands) return "my hands are switched off in Settings";
    const front = scope ? null : await hands.front().catch(() => null);
    const key = (scope ?? front?.name ?? "").toLowerCase();
    const grade = gradeOf("write", `${what} ${detail}`);
    const standing = grade === "write" && key !== "" && (this.grants.get(key) ?? 0) > Date.now();
    if (!standing) {
      const where = front?.title ? ` in ${front.title.slice(0, 60)}` : "";
      const yes = await this.askPermission(`${what}${where}`, grade);
      if (!yes) return "not done: the user did not say yes";
      if (grade === "write" && key) this.grants.set(key, Date.now() + 120_000);
    }
    // The yes was for the window it named. If another one came to the front
    // while it was asked (a dialog, a restored tab), nothing is done in it.
    if (front) {
      const now = await hands.front().catch(() => null);
      if (!now || now.pid !== front.pid || now.title !== front.title) {
        log(
          `hands: ${what} not done; the window changed to ${now?.title || now?.name || "nothing"}`,
        );
        return `not done: the window in front changed to ${now?.title || now?.name || "something else"}`;
      }
    }
    try {
      const done = await act();
      log(`hands: ${what} -> ${done}`);
      return done;
    } catch (e) {
      log(`hands: ${what} failed: ${(e as Error).message}`);
      return `that didn't work: ${(e as Error).message}`;
    }
  }

  /** The key for the provider in the settings; empty means no brain. */
  private brainKey(): string {
    return this.settings.brain_provider === "openrouter" ? this.openrouterKey : this.anthropicKey;
  }

  brain(): Brain | null {
    if (!this.settings.brain) return null;
    const provider = this.settings.brain_provider || "anthropic";
    // Claude Code on the user's subscription: no key, only the binary.
    if (provider === CODE_PROVIDER) {
      if (
        this.brainCache?.provider === CODE_PROVIDER &&
        this.brainCache.model === this.settings.brain_model
      )
        return this.brainCache;
      const bin = this.agents.bin();
      if (!bin) return null;
      // The talking session: kept open, thinking off. Deep thought goes to a
      // separate thinking session through the think_deeply tool.
      const live = new LiveBrain(
        {
          bin,
          model: this.settings.brain_model,
          dir: path.join(HOME, "brain"),
          log,
          ...(this.codeSpawn ? { spawnImpl: this.codeSpawn } : {}),
        },
        PERSONA,
      );
      this.brainCache = live;
      if (this.persistBoard) {
        live.seed(this.conversationFromDisk());
        // started before the first word, so the first answer is warm too
        void live.warm(this.brainTools()).catch((e) => log(`claude code: ${(e as Error).message}`));
      }
      return this.brainCache;
    }
    const key = this.brainKey();
    if (!key) return null;
    if (
      !this.brainCache ||
      this.brainCache.model !== this.settings.brain_model ||
      this.brainCache.provider !== provider
    ) {
      this.brainCache = new Brain({
        key,
        model: this.settings.brain_model,
        provider,
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
    // While the model thinks, a person would say something. Asked for in the
    // user's words: "give me two seconds to think about this", "or it could
    // start a different subject". So two beats: a line that says it is
    // thinking, and if it is still thinking, something real from the board
    // rather than a second "hm". Through Claude Code the wait is four to
    // seven seconds, so the first beat comes sooner and a hello gets one too.
    const slow = brain.provider === CODE_PROVIDER && !(brain instanceof LiveBrain);
    const pickFrom = (list: string[]) => {
      const pick = list.filter((f) => f !== this.lastFiller);
      const f = pick[Math.floor(Math.random() * pick.length)] ?? list[0] ?? "Hm.";
      this.lastFiller = f;
      return f;
    };
    const timers: NodeJS.Timeout[] = [];
    if (kind !== "social" || slow) {
      timers.push(
        setTimeout(
          () => this.sayAside(pickFrom(slow && kind !== "social" ? THINKING : FILLERS)),
          slow ? Math.min(this.fillerMs, 900) : this.fillerMs,
        ),
      );
      timers.push(
        setTimeout(
          () => this.sayAside(this.meanwhile() ?? pickFrom(STILL)),
          (slow ? Math.min(this.fillerMs, 900) : this.fillerMs) + 4500,
        ),
      );
    }
    const stopFiller = () => {
      for (const t of timers.splice(0)) clearTimeout(t);
    };
    try {
      said = await brain.reply(text, {
        system: this.brainSystem(),
        tools: this.brainTools(),
        asides: this.asides.splice(0),
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
      // The model being gone is not a reason to stop talking.
      //
      // Three answers, in order of what can actually help. A question about
      // the status board is answered here, instantly and free. Work goes to
      // the agent, as it always did. And anything else — a real question,
      // the kind a person asks — also goes to the agent, because it is a
      // whole Claude on the user's own subscription and Kik going quiet
      // while a perfectly good mind sits idle in the next room is silly.
      const sessions = Object.values(this.tracker.snapshot());
      // Out of credit looks, from the chair, like Kik going simple for no
      // reason: every hello answered the same. Say why, once an hour.
      const broke = /\b(402|billing|credit)/i.test((e as Error).message);
      const why =
        broke && Date.now() - this.creditNoticeAt > 3600_000
          ? "My thinking account is out of credit, so I'm on simple answers. "
          : "";
      if (why) this.creditNoticeAt = Date.now();
      said =
        kind === "social"
          ? headSocial(intent, text)
          : kind === "question" && headKnows(text)
            ? headAnswer(text, sessions)
            : this.settings.agents
              ? sentence(this.instruct(text))
              : kind === "question"
                ? headAnswer(text, sessions)
                : "I can't reach the model right now. Say that to the terminal.";
      said = why + said;
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
    // What is left of the limits. Here rather than in a tool because it is the
    // kind of thing the user asks in passing — "how much have I got left?" —
    // and a tool round trip to answer it would be slower than the question.
    const usage = this.settings.usage ? this.usage.brief() : "";
    if (usage)
      lines.push(
        `Limits left (used, so higher is worse; say these as plain numbers and never invent one that is not here):\n${usage}`,
      );
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
    const thinking: BrainTool[] = this.agents.bin()
      ? [
          {
            name: "think_deeply",
            description:
              "Hand a question that needs real thought to your thinking session: a design question, a hard bug, a plan, a comparison, a decision with trade-offs. It runs in the background with extended thinking and a stronger model, shows on the canvas as it works, and its answer is spoken when it lands, in a minute or so. Give the question and everything you know that bears on it. After calling, tell the user in a few words that you are on it, then carry on; do not wait for it.",
            input_schema: {
              type: "object",
              properties: {
                question: str("the question, in full, as the thinking session should read it"),
                context: str(
                  "what you know that bears on it: the situation, constraints, what was said",
                ),
              },
              required: ["question"],
            },
            run: (i) => this.think(String(i.question ?? ""), String(i.context ?? "")),
          },
        ]
      : [];
    const hands = this.hands();
    const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);
    const handsTools: BrainTool[] = hands
      ? [
          {
            name: "list_windows",
            description:
              "The windows open on this PC: each app's name and window title. Free to call; nothing changes.",
            input_schema: { type: "object", properties: {} },
            run: async () => JSON.stringify(await hands.windows()),
          },
          {
            name: "read_window",
            description:
              "What is in the window in front: its title and its named buttons, fields, links, tabs and text, from Windows UI Automation. Free to call. Work one step at a time on the PC: read the window, do one thing, read it again to check it happened. Prefer keyboard shortcuts to pressing buttons where both work.",
            input_schema: { type: "object", properties: {} },
            run: async () =>
              JSON.stringify({ window: await hands.front(), controls: await hands.controls() }),
          },
          {
            name: "show_screen",
            description:
              "Put a picture of the PC's screen on the canvas, for the user to see from the phone or when asked what is on screen. Free to call; nothing changes.",
            input_schema: { type: "object", properties: {} },
            run: async () => {
              const img = await hands.screenshot();
              if (!img.startsWith("data:image/")) return "I couldn't take the screenshot";
              const pin = this.board.add({
                kind: "image",
                title: "the screen",
                body: img,
                project: this.projects.current.id,
                repo: "kik",
                by: "kik",
                size: "wide",
                ttl_s: 1800,
              });
              this.hub.publish("focus", { id: pin.id });
              return "the screen is on the canvas";
            },
          },
          {
            name: "focus_window",
            description:
              "Bring a window to the front, by part of its title or its app's name as list_windows gave them. The user is asked first.",
            input_schema: {
              type: "object",
              properties: { match: str("part of the window's title, or the app's name") },
              required: ["match"],
            },
            run: (i) => {
              const match = String(i.match ?? "");
              return this.withLeave(
                `switch to ${match}`,
                "",
                async () => {
                  const w = await hands.focus(match);
                  return w ? `in front: ${w.title || w.name}` : "no window like that";
                },
                "switching windows",
              );
            },
          },
          {
            name: "open_app",
            description:
              "Open an app on this PC by name (notepad, chrome, spotify, word, calculator, a Start menu entry). The user is asked first. For a website on the canvas use create_artifact; for a project's folder or editor, the switchboard already does that.",
            input_schema: {
              type: "object",
              properties: { name: str("the app, as it is called in the Start menu") },
              required: ["name"],
            },
            run: (i) => {
              const name = String(i.name ?? "");
              return this.withLeave(`open ${name}`, "", () => hands.open(name), `open ${name}`);
            },
          },
          {
            name: "type_text",
            description:
              "Type text into whatever has the focus in the window in front; a newline presses Enter. The user is asked first and told what will be typed, so read_window first to be sure the right field has the focus.",
            input_schema: {
              type: "object",
              properties: { text: str("exactly what to type") },
              required: ["text"],
            },
            run: (i) => {
              const text = String(i.text ?? "");
              return this.withLeave(`type "${short(text)}"`, text, async () => {
                await hands.type(text);
                return "typed";
              });
            },
          },
          {
            name: "press_keys",
            description:
              "Press a key or a chord: enter, tab, esc, backspace, up, down, ctrl+s, ctrl+t, ctrl+l, alt+tab, ctrl+shift+t, f5; the Windows key and its chords (win, win+d for the desktop, win+e for files); and the media keys: play, pause, next, previous, mute, volume up, volume down. The user is asked first.",
            input_schema: {
              type: "object",
              properties: { keys: str("the key or chord, like ctrl+s") },
              required: ["keys"],
            },
            run: (i) => {
              const keys = String(i.keys ?? "");
              return this.withLeave(`press ${keys}`, keys, async () => {
                await hands.press(keys);
                return "pressed";
              });
            },
          },
          {
            name: "press_button",
            description:
              "Press a button, link, tab or checkbox in the window in front by its name, as read_window gave it. The user is asked first; one whose name means it cannot be undone (Send, Delete, Buy, Publish, Pay) is asked every time and said as such.",
            input_schema: {
              type: "object",
              properties: { name: str("the control's name, as read_window gave it") },
              required: ["name"],
            },
            run: (i) => {
              const name = String(i.name ?? "");
              return this.withLeave(`press "${name}"`, name, () => hands.pressControl(name));
            },
          },
        ]
      : [];
    return [
      ...thinking,
      ...handsTools,
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
            // a video link becomes its player, which plays on the phone too
            const vid = youtubeId(body);
            if (vid) body = youtubeEmbed(vid);
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
            project: this.projects.current.id,
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
            project: this.projects.current.id,
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
        description:
          "Take one thing off the canvas. It waits in a bin for an hour; restore_artifacts brings back what was last removed. Only remove what the user asked to go: a card they kept, or something just made, is theirs, so ask first when a request is vague like 'close all windows'.",
        input_schema: { type: "object", properties: { id: str("the pin id") }, required: ["id"] },
        run: (i) =>
          this.board.remove(String(i.id ?? ""))
            ? "removed (in the bin for an hour)"
            : "no such pin",
      },
      {
        name: "restore_artifacts",
        description:
          "Bring back what was last taken off the canvas (a clear, or the cards removed a moment ago), from the bin. Use it for 'undo', 'bring them back', 'I didn't mean that'.",
        input_schema: { type: "object", properties: {} },
        run: () => {
          const n = this.board.restore();
          return n ? `brought back ${n}` : "the bin is empty";
        },
      },
      {
        name: "start_agent",
        description:
          "Start a coding agent in a project and give it the job. Use this when the user asks for work doing and nothing is running there — you do not need to ask them to open a terminal first. The agent's progress comes back on its own: you will hear about it and the canvas will fill. Give the task in the user's own words, with enough of the context you have that it can begin without asking.",
        input_schema: {
          type: "object",
          properties: {
            task: str("what it should do, in the user's words"),
            project: str("which project; omit for the one on screen"),
          },
          required: ["task"],
        },
        run: (i) => this.startAgent(String(i.project ?? ""), String(i.task ?? "")),
      },
      {
        name: "open_project",
        description:
          "Show another project's board. Each project keeps its own canvas, arranged the way the user left it. Use it when they ask to switch, open, or go to a project by name, or when what they want is clearly about another one. The agents in other projects keep running either way.",
        input_schema: {
          type: "object",
          properties: { name: str("the project, as the user said it") },
          required: ["name"],
        },
        run: (i) => this.openProject(String(i.name ?? "")),
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
            project: this.projects.current.id,
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
        description:
          "Clear everything off the board except kept cards. What goes waits in a bin for an hour (restore_artifacts); tell the user they can say undo.",
        input_schema: { type: "object", properties: {} },
        run: () => {
          const n = this.board.clear();
          return `cleared ${n} (in the bin for an hour; undo brings them back)`;
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
          // A note is pinned to be read later, so it does not fade away first.
          this.board.add({
            kind: "text",
            title: String(i.title ?? "note"),
            body: String(i.body ?? ""),
            project: this.projects.current.id,
            repo: "kikoe",
            sticky: true,
          });
          return "pinned (kept)";
        },
      },
    ];
  }

  /** Queue an instruction for an agent; says what will happen to it. */
  /**
   * How much has to be said before it counts as a job.
   *
   * The ear mishears, and "time" arriving as work:instruct once queued a
   * one-word instruction to a real agent. A fragment is far more likely to
   * be a misheard scrap than a task, and the cost of ignoring a real short
   * one is that you say it again.
   */
  private static readonly MIN_INSTRUCTION_WORDS = 4;

  instruct(text: string, repo?: string): string {
    const words = text.trim().split(/\s+/).filter(Boolean);
    // "what what what what" is four words and one idea, and it reached a real
    // agent from the phone. Count the different words, not the words.
    const distinct = new Set(words.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")));
    distinct.delete("");
    if (words.length < Daemon.MIN_INSTRUCTION_WORDS || distinct.size < 3) {
      return "I didn't catch enough of that to pass on; say it again?";
    }
    const sessions = Object.values(this.tracker.snapshot());
    const target =
      repo ??
      sessions.find((s) => s.status === "working")?.repo ??
      sessions[sessions.length - 1]?.repo;
    // Nothing to hand it to used to be the end of the sentence, which meant
    // the first instruction of the day always failed and you opened a
    // terminal. Now it is a reason to start one.
    if (!target) return this.startAgent(repo ?? "", text);
    const s = sessions.find((x) => x.repo === target);
    // Mid-turn, the queue is the only way in: a second `-p` cannot interrupt
    // a turn already running, and the Stop hook hands this over the moment
    // it ends. Idle, there is nothing to wait for — say it straight into the
    // conversation and it starts now.
    if (s && s.status !== "working" && this.settings.agents) {
      const said = this.startAgent(target, text);
      if (!/^(started|passed)/.test(said)) return said;
      log(`instruction sent to ${target}: ${text}`);
      return said;
    }
    this.instructions.push({ repo: target, text, at: Date.now() });
    const when = s?.status === "working" ? "when its turn ends" : "with the user's next prompt";
    log(`instruction queued for ${target}: ${text}`);
    return `queued for ${target}; it gets it ${when}`;
  }

  /**
   * Start a coding agent in a project, with something to do.
   *
   * The work comes back the way it always has — hooks, narration, cards on
   * the canvas — because the session Kik starts is an ordinary one. What is
   * new is only that nobody had to open a terminal to begin it.
   */
  startAgent(name: string, prompt: string, opts: { fresh?: boolean } = {}): string {
    if (!this.settings.agents) return "starting agents is switched off in Settings";
    const project = name
      ? (this.projects.resolve(name) ?? this.projects.current)
      : this.projects.current;
    // "Open a new session" means a new conversation, not the standing one.
    // Forgotten only when nothing is running there: a refused start must not
    // cost the conversation that is still going.
    if (opts.fresh && !this.agents.running.some((r) => r.project === project.id)) {
      this.projects.forget(project.id);
    }
    // What the user said first, then what the machine knows: being told the
    // folder is missing when the real problem is an empty task is a worse
    // answer than the one about the task.
    const task = prompt.trim();
    if (!task) return "tell me what it should do";
    const cwd = project.roots[0] ?? "";
    if (!cwd) return `I don't know where ${project.name} is on disk`;
    // The project's own conversation: made once, resumed for ever after, so
    // this morning's first sentence lands where last night's left off. There
    // is no process to keep alive — `-p` starts and exits — so "a session is
    // already there" costs an id and nothing else.
    const fresh = !project.session;
    const session = this.projects.sessionFor(project.id);
    const { ok, said } = this.agents.start(project.id, cwd, task, session, fresh);
    if (ok) this.saveProjects();
    if (ok) {
      // Show it happening: the board the work will land on is the one to be
      // looking at.
      if (this.projects.current.id !== project.id) {
        this.projects.open(project.id);
        this.saveProjects();
        this.publishProject();
      }
      this.hub.publish("sessions", {
        sessions: this.tracker.snapshot(),
        brief: this.tracker.brief(),
      });
    }
    return said;
  }

  /**
   * Do something about a card.
   *
   * The canvas has been a window onto the work: you could read a diff and a
   * test run and do nothing about either. This makes the cards act — and it
   * does it by *asking the agent*, never by touching the repo. Kikoe writes
   * to no source file and runs no build of its own, so a revert is an edit
   * the agent makes and you can see, and a re-run is the command it already
   * ran. Nothing new can reach your disk that could not before.
   */
  actOnPin(id: string, action: string): { ok: boolean; said: string } {
    const pin = this.board.get(id);
    if (!pin) return { ok: false, said: "that card is gone" };
    const repo = pin.repo && pin.repo !== "kik" ? pin.repo : undefined;
    const what = pinSubject(pin);
    let instruction = "";
    switch (action) {
      case "again":
        if (!what.command) return { ok: false, said: "that card has no command on it" };
        instruction = `Run this again and tell me what changed: ${what.command}`;
        break;
      case "revert":
        if (!what.file) return { ok: false, said: "that card has no file on it" };
        instruction = `Undo the change you just made to ${what.file}. Put it back as it was, change nothing else, and say only what you did.`;
        break;
      case "explain":
        instruction = what.file
          ? `Explain the change you made to ${what.file}: what it does and why, in a few sentences.`
          : `Explain what this did and what it means: ${what.command || pin.title}`;
        break;
      default:
        return { ok: false, said: `I don't know how to ${action}` };
    }
    const said = this.instruct(instruction, repo);
    log(`card ${id}: ${action} -> ${said}`);
    return { ok: true, said };
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
      case "agent": {
        this.interrupt();
        const n = this.agents.stop();
        // Only the runs Kik started can be stopped from here; one in a
        // terminal belongs to the terminal.
        return n ? "Stopped it." : "Nothing I started is running.";
      }
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
          const n = this.board.clear();
          return n ? "Cleared. Say undo to bring them back." : "It's already clear.";
        }
        if (arg === "undo") {
          const n = this.board.restore();
          return n ? `Back: ${n === 1 ? "one card" : `${n} cards`}.` : "Nothing to bring back.";
        }
        this.hub.publish("view", { view: arg === "show" ? "control" : "room" });
        return undefined;
      case "repeat":
        return this.lastRepeatable || "I haven't said anything yet.";
      case "focus": {
        // "switch to marine" has routed here since the beginning and only ever
        // published a frame the Room ignored. Now it moves the whole board,
        // and it does it in the rulebook, so it works with no key.
        const said = this.openProject(arg);
        this.hub.publish("view", { view: "room", focus: arg });
        return `${said}.`;
      }
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
        provider: this.settings.brain_provider || "anthropic",
        key: Boolean(this.brainKey()),
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
      // The Room shows one project, so the state it starts from is that one.
      pins: this.board.list(this.projects.current.id),
      project: {
        id: this.projects.current.id,
        name: this.projects.current.name,
        all: this.projects.all().map((p) => ({ id: p.id, name: p.name })),
      },
      asking: this.board.asking()?.id ?? null,
      walkie: {
        on: this.walkie !== null,
        port: this.settings.walkie_port,
        // The link carries its own token; it is shown in Settings so the
        // phone can be pointed at it, and it is not a key.
        urls: this.walkie?.urls() ?? [],
        ear: this.transcribe !== null,
        // Away from home: the tailnet's own HTTPS name when our serve rule
        // is up (a real certificate, no warning), else its 100.x address.
        tailnet: {
          ...this.tailnet,
          want: this.settings.walkie_tailscale,
          note: this.tailnetNote,
          url: !this.walkie
            ? ""
            : this.tailnet.serving && this.tailnet.dns
              ? `https://${this.tailnet.dns}/?t=${encodeURIComponent(walkieToken())}`
              : this.tailnet.ip
                ? `https://${this.tailnet.ip}:${this.settings.walkie_port || 4571}/?t=${encodeURIComponent(walkieToken())}`
                : "",
        },
      },
      mic: { phase: this.micPhase, device: this.micDevice, enabled: this.settings.mic },
      heard: [...this.heardLog].reverse(),
      // the thinking session's questions, for the "kik · thinking" card
      thinking: this.thoughtsView(),
      usage: this.usage.list(),
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
      ["/state", "/sessions", "/stream", "/pins", "/backdrop", "/usage"].includes(url.pathname);
    if (grant === "viewer" && !reading)
      return this.json(res, 403, { error: "viewer token: read only" });

    const answerMatch = /^POST \/pins\/([A-Za-z0-9_-]+)\/answer$/.exec(route);
    if (answerMatch) {
      const b = JSON.parse((await this.body(req)) || "{}");
      const ok = this.board.answer(answerMatch[1]!, String(b.answer ?? ""));
      return this.json(res, ok ? 200 : 404, { ok });
    }
    const actMatch = /^POST \/pins\/([A-Za-z0-9_-]+)\/act$/.exec(route);
    if (actMatch) {
      const b = JSON.parse((await this.body(req)) || "{}");
      const r = this.actOnPin(actMatch[1]!, String(b.action ?? ""));
      return this.json(res, r.ok ? 200 : 400, r);
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
        // The card's viewport buttons have always sent `wide`; nothing has
        // ever read it, so a phone-sized page stayed a normal card.
        size: b.wide === true ? "wide" : b.wide === false ? "normal" : undefined,
        w: typeof b.w === "number" ? b.w : undefined,
        h: typeof b.h === "number" ? b.h : undefined,
        x: typeof b.x === "number" ? b.x : undefined,
        y: typeof b.y === "number" ? b.y : undefined,
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
        this.hub.subscribe(res, {
          sessions: this.tracker.snapshot(),
          mode: this.narrator.mode,
          // The rings draw from the hello frame, so an island started long
          // after the last poll shows the archived readings rather than three
          // empty circles until the next one lands.
          usage: this.usage.list(),
        });
        return;
      case "GET /usage":
        return this.json(res, 200, { providers: this.usage.list() });
      case "POST /usage/refresh":
        await this.usage.poll();
        return this.json(res, 200, { providers: this.usage.list() });
      case "POST /hook/claude": {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse((await this.body(req)) || "{}");
        } catch {
          return this.json(res, 400, { error: "bad json" });
        }
        const e = this.hook(payload);
        // A permission request holds the hook open until a spoken answer or
        // the timeout. A second one waits behind the first instead of
        // denying it; the arbiter holds its words until it is its turn.
        if (e && e.kind === ev.PERMISSION && payload.hook_event_name === "PermissionRequest") {
          const timeoutS = Math.max(3, Number(url.searchParams.get("timeout") ?? 20));
          let answered = false;
          const p: PendingPermission = {
            id: e.id,
            session: e.session,
            repo: e.repo,
            text: this.tracker.sessions.get(e.session)?.pendingPermission ?? "",
            reply: (allow) => {
              answered = true;
              const body = allow
                ? JSON.stringify({
                    hookSpecificOutput: {
                      hookEventName: "PermissionRequest",
                      decision: "allow",
                      decisionReason: "approved by voice",
                    },
                  })
                : "";
              if (res.writableEnded) return;
              res.writeHead(200, { "content-type": "application/json" });
              res.end(body);
            },
            timer: setTimeout(() => this.expirePermission(e.id), timeoutS * 1000),
          };
          this.enqueuePermission(p);
          // curl gave up (the agent's own timeout, or it was cancelled):
          // nobody is waiting on this question any more
          res.on("close", () => {
            if (answered) return;
            clearTimeout(p.timer);
            if (this.pending?.id === e.id) this.nextPermission();
            else this.queued = this.queued.filter((q) => q.id !== e.id);
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
        // A pusher names a repo, not a project. If that repo is a project, the
        // card goes to its board; otherwise it lands where you are looking.
        if (!init.project) init.project = this.projectFor(init.repo);
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
          // ?project=all for every board; by default, the one on screen
          pins: this.board.list(
            url.searchParams.get("project") === "all"
              ? undefined
              : url.searchParams.get("project") || this.projects.current.id,
          ),
          project: this.projects.current.id,
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
          this.onMicReady?.();
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
        // Speech has started: open Jev's connection now, while the user is
        // still talking and Whisper has yet to hear the end, so the decision
        // after it is ~280 ms and not ~760.
        if (phase === "hearing") this.jev()?.warm();
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
      // Serve waits on a one-time approval in the Tailscale console; once the
      // user clicks it, the rule goes up on its own within two minutes.
      setInterval(() => {
        if (this.walkie && this.settings.walkie_tailscale && !this.tailnet.serving)
          void this.syncTailnet();
      }, 120_000),
      setInterval(() => {
        const dropped = unloadIdleEngines();
        if (dropped.length) log(`unloaded idle model: ${dropped.join(", ")}`);
      }, 60_000),
    );
    if (this.settings.usage) this.usage.start();
    log(`listening on 127.0.0.1:${port}, speaker ${this.speaker.info().device}`);
    // the first sentence of the day should not be the one that pays the handshake
    this.jev()?.warm();
    return { port };
  }

  async close(): Promise<void> {
    if (this.brainCache instanceof LiveBrain) this.brainCache.close();
    for (const t of this.thoughts) t.abort?.abort();
    if (this.held) clearTimeout(this.held.timer);
    if (this.checkinTimer) clearInterval(this.checkinTimer);
    if (this.reflectTimer) clearTimeout(this.reflectTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    if (this.usageTimer) clearTimeout(this.usageTimer);
    this.usage.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.handsCache?.close();
    // Closing denies everything asked, the ones in line too: an agent must not
    // wait on a question nobody is left to hear.
    for (const q of this.queued.splice(0)) {
      clearTimeout(q.timer);
      q.reply(false);
    }
    if (this.pending) this.answerPermission(false, this.pending.id);
    // The one socket that is not loopback goes first, and always.
    if (this.walkie) {
      const w = this.walkie;
      this.walkie = null;
      await w.stop();
    }
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

/**
 * What a work card is about: the command it ran, or the file it changed.
 *
 * Read back out of the body rather than stored beside it, because the body
 * is a format this codebase writes — `$ command` on a run, `--- a/file` on
 * a diff — and a second copy of the same fact is a second thing to keep
 * true.
 */
/** A tool's answer, said out loud: a capital and a full stop. */
function sentence(s: string): string {
  const t = s.trim();
  if (!t) return "";
  return /[.!?]$/.test(t)
    ? t.charAt(0).toUpperCase() + t.slice(1)
    : `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
}

export function pinSubject(pin: { kind: string; body: string; title: string }): {
  command: string;
  file: string;
} {
  if (pin.kind === "run" || pin.kind === "result") {
    const m = /^\$ (.+)$/m.exec(pin.body);
    return { command: (m?.[1] ?? "").trim(), file: "" };
  }
  if (pin.kind === "diff") {
    const m = /^--- a\/(.+)$/m.exec(pin.body);
    return { command: "", file: (m?.[1] ?? "").trim() };
  }
  return { command: "", file: "" };
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
