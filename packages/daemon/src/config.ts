/**
 * Runtime state and settings live in one directory: `~/.kikoe`, or
 * `KIKOE_HOME`. Environment wins over the saved file, which wins over the
 * default. Secrets (the ElevenLabs key) never go in the settings file: the
 * app stores them through the OS keychain, and the daemon reads a plain
 * `elevenlabs_key.txt` only as the developer fallback.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = process.env.KIKOE_HOME || path.join(os.homedir(), ".kikoe");
export const MODELS = process.env.KIKOE_MODELS || path.join(HOME, "models");
export const RUN = path.join(HOME, "run");
export const LOGS = path.join(HOME, "logs");

export interface Settings {
  /** auto | piper | kokoro | eleven | system */
  tts: string;
  /** silent | attention | normal | verbose */
  narrate: string;
  port: number;
  elevenlabs_voice: string;
  elevenlabs_voice_name: string;
  elevenlabs_model: string;
  /** use the chosen voice and no other */
  tts_strict: boolean;
  /** attention | balanced | full */
  hook_profile: string;
  /** which Claude Code settings file the hooks were written to */
  claude_settings: string;
  start_at_login: boolean;
  onboarded: boolean;
  /** off | cues | replace: sound cues around lines, or instead of progress lines */
  earcons: string;
  /** a voice per repo label: { api: { backend: "eleven", voice: "<id>" } } */
  voices: Record<string, { backend?: string; voice?: string }>;
  /** the listening half, off until the user turns it on */
  mic: boolean;
  /** a distinctive fragment of the input device name, never an index */
  mic_device: string;
  /** the name that opens a conversation, plus the misspellings STT produces */
  wake_name: string;
  /** system | dark | light */
  theme: string;
  /** tiny | base: the Whisper English model the ear uses */
  stt_model: string;
  /** keep the text of what was not for us too; for tuning the name gate, off by default */
  hear_debug: boolean;
  /** a question aimed at "you" is for Kik, name or no name */
  hear_you: boolean;
  /** talking over Kik stops it (headset only; through speakers it hears itself) */
  barge_in: boolean;
  /** the canvas backdrop: grid | plain | paper | ink | aurora | nebula | custom */
  backdrop: string;
  backdrop_dim: number;
  backdrop_blur: boolean;
  /** the user's own image, copied into HOME */
  backdrop_image: string;
  /** a model in the head: what is addressed to Kik goes to the API */
  brain: boolean;
  brain_model: string;
  /**
   * who serves the model: anthropic (the key in the keychain) or openrouter
   * (the key in ~/.kikoe/openrouter_key.txt, the same Messages format, any
   * Claude model by the same name). The Anthropic account ran dry once and
   * Kik was the rulebook for a day; a second door costs one setting.
   */
  brain_provider: string;
  /** the model phrases milestones, errors and endings in its own words */
  brain_narrates: boolean;
  /** it may speak up unprompted when something is worth it */
  brain_checkin: boolean;
  /** it says hello when the user comes back after a while away */
  brain_greets: boolean;
  /** the model that designs pages and apps for the canvas; sharper than the voice */
  artifact_model: string;
  /** the thinking session's model, when Kik thinks through Claude Code */
  think_model: string;
  /**
   * Your phone as a microphone, on the local network.
   *
   * The one part of Kikoe that is not loopback, so it is off until you say
   * otherwise and the socket closes again the moment you switch it back.
   * It needs HTTPS — a browser will not hand over a microphone to a plain
   * http page that is not localhost — so it serves a self-signed
   * certificate the phone is asked to trust once.
   */
  walkie: boolean;
  walkie_port: number;
  /**
   * Put the walkie on the user's tailnet with Tailscale Serve: a real
   * certificate at machine.tailnet.ts.net, reachable from their own devices
   * anywhere. Only while the walkie is on; off takes the rule down.
   */
  walkie_tailscale: boolean;
  /**
   * Kik may start a coding agent itself, so the first move of the day is not
   * a terminal. It spawns a process, which is worth a switch; permissions
   * are still asked for and answered by voice, always.
   */
  agents: boolean;
  /** where Claude Code lives, when it is not somewhere obvious */
  claude_bin: string;
  /**
   * Jev decides where what you say goes: to Kik, to the agent, to a new
   * session, to the PC; and whether a nameless sentence was for Kik at all.
   * Only with a key in ~/.kikoe/jev_key.txt; without one, the old rules.
   */
  jev: boolean;
  /** Kik may open the editor, a folder, a terminal or a website on this PC */
  pc: boolean;
  /**
   * Kik's hands (docs/OS.md, L1): switch windows, open apps, type, press
   * keys and buttons, read what is in the window in front. Off until turned
   * on; every change is asked for aloud, and anything that cannot be undone
   * always is.
   */
  hands: boolean;
  /** rings on the island for what is left of each assistant's limit */
  usage: boolean;
  /** providers switched off by hand; a listed id is never read at all */
  usage_off: string[];
}

export const DEFAULTS: Settings = {
  tts: "auto",
  narrate: "normal",
  port: 4570,
  elevenlabs_voice: "",
  elevenlabs_voice_name: "",
  elevenlabs_model: "eleven_flash_v2_5",
  tts_strict: false,
  hook_profile: "balanced",
  claude_settings: "",
  start_at_login: false,
  onboarded: false,
  earcons: "cues",
  voices: {},
  mic: false,
  mic_device: "",
  wake_name: "kikoe",
  theme: "system",
  stt_model: "tiny",
  hear_debug: false,
  hear_you: true,
  barge_in: false,
  backdrop: "grid",
  backdrop_dim: 0.35,
  backdrop_blur: true,
  backdrop_image: "",
  brain: false,
  brain_model: "claude-haiku-4-5-20251001",
  brain_provider: "anthropic",
  brain_narrates: true,
  brain_checkin: true,
  brain_greets: true,
  artifact_model: "claude-sonnet-5",
  think_model: "opus",
  walkie: false,
  walkie_port: 4571,
  walkie_tailscale: false,
  agents: true,
  claude_bin: "",
  jev: true,
  pc: true,
  hands: false,
  usage: true,
  usage_off: [],
};

const FILE = () => path.join(HOME, "config.local.json");

export function ensureHome(): void {
  for (const d of [HOME, MODELS, RUN, LOGS]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

export function loadSettings(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(readFileSync(FILE(), "utf8"));
  } catch {
    /* first run */
  }
  const env = process.env;
  const s: Settings = { ...DEFAULTS, ...saved };
  if (env.KIKOE_TTS) s.tts = env.KIKOE_TTS;
  if (env.KIKOE_NARRATE) s.narrate = env.KIKOE_NARRATE;
  if (env.KIKOE_PORT) s.port = Number(env.KIKOE_PORT) || s.port;
  if (env.KIKOE_ELEVEN_VOICE) s.elevenlabs_voice = env.KIKOE_ELEVEN_VOICE;
  if (env.KIKOE_ELEVEN_MODEL) s.elevenlabs_model = env.KIKOE_ELEVEN_MODEL;
  return s;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  ensureHome();
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(readFileSync(FILE(), "utf8"));
  } catch {
    /* fresh */
  }
  const next = { ...saved, ...patch };
  writeFileSync(FILE(), JSON.stringify(next, null, 2) + "\n", "utf8");
  return { ...DEFAULTS, ...next };
}

/**
 * The daemon token: generated on first run, mode 600, never in the repo.
 * Anything that can speak and approve tool calls sits behind it.
 */
export function daemonToken(): string {
  if (process.env.KIKOE_TOKEN) return process.env.KIKOE_TOKEN.trim();
  ensureHome();
  const file = path.join(HOME, "daemon_token.txt");
  try {
    const t = readFileSync(file, "utf8").trim();
    if (t) return t;
  } catch {
    /* create */
  }
  const t = randomBytes(24).toString("hex");
  writeFileSync(file, t + "\n", { encoding: "utf8", mode: 0o600 });
  return t;
}

/**
 * The viewer token: reads the stream, the state and the board, and nothing
 * else. For a second screen that must never be able to approve a tool call.
 */
export function viewerToken(): string {
  ensureHome();
  const file = path.join(HOME, "viewer_token.txt");
  try {
    const t = readFileSync(file, "utf8").trim();
    if (t) return t;
  } catch {
    /* create */
  }
  const t = `v-${randomBytes(18).toString("hex")}`;
  writeFileSync(file, `${t}\n`, { encoding: "utf8", mode: 0o600 });
  return t;
}

/**
 * The walkie token: opens the phone page and nothing else.
 *
 * Its own token, not the daemon's, because this one is typed into a phone
 * and lives in a browser's history on the far side of a network. It can
 * push audio in; it cannot read the board, approve a tool call, or speak.
 */
export function walkieToken(): string {
  ensureHome();
  const file = path.join(HOME, "walkie_token.txt");
  try {
    const t = readFileSync(file, "utf8").trim();
    if (t) return t;
  } catch {
    /* create */
  }
  const t = `w-${randomBytes(18).toString("hex")}`;
  writeFileSync(file, `${t}\n`, { encoding: "utf8", mode: 0o600 });
  return t;
}

/** Developer fallback for the ElevenLabs key; the app prefers the keychain. */
export function anthropicKeyFromFile(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  try {
    return readFileSync(path.join(HOME, "anthropic_key.txt"), "utf8").trim();
  } catch {
    return "";
  }
}

/** The OpenRouter key lives in a plain file only; nothing else reads it. */
export function openrouterKeyFromFile(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  try {
    return readFileSync(path.join(HOME, "openrouter_key.txt"), "utf8").trim();
  } catch {
    return "";
  }
}

/** The TypeSafe key for Jev, in a plain file like the OpenRouter one. */
export function jevKeyFromFile(): string {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY.trim();
  try {
    return readFileSync(path.join(HOME, "jev_key.txt"), "utf8").trim();
  } catch {
    return "";
  }
}

export function elevenKeyFromFile(): string {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  try {
    return readFileSync(path.join(HOME, "elevenlabs_key.txt"), "utf8").trim();
  } catch {
    return "";
  }
}

export function log(line: string): void {
  try {
    ensureHome();
    const stamp = new Date().toISOString();
    writeFileSync(path.join(LOGS, "daemon.log"), `${stamp} ${redact(line)}\n`, { flag: "a" });
  } catch {
    /* logging must never throw */
  }
}

/** Keys never reach a log line, with a test to say so. */
export function redact(s: string): string {
  return s
    .replace(/(xi-api-key["':\s=]+)[^\s"',}]+/gi, "$1[redacted]")
    .replace(/(authorization["':\s=]+(?:bearer\s+)?)[^\s"',}]+/gi, "$1[redacted]")
    .replace(/\bsk_[a-f0-9]{20,}\b/gi, "[redacted]");
}
