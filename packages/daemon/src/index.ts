export { Daemon, VERSION, probe, SELF_SPOKEN_WINDOW_S } from "./daemon.js";
export type { DaemonOptions, SpokenRecord } from "./daemon.js";
export {
  HOME,
  MODELS,
  LOGS,
  DEFAULTS,
  loadSettings,
  saveSettings,
  daemonToken,
  ensureHome,
  elevenKeyFromFile,
  log,
  redact,
} from "./config.js";
export type { Settings } from "./config.js";
export { Hub } from "./hub.js";
export type { Frame } from "./hub.js";
export { NullSpeaker, RtAudioSpeaker, listOutputDevices, resample, earcon } from "./speaker.js";
export type { Speaker, SpeakerInfo, Earcon } from "./speaker.js";
export {
  Ladder,
  PiperRung,
  KokoroRung,
  ElevenRung,
  SystemRung,
  findPiperDir,
  unloadIdleEngines,
  loadedEngines,
  KOKORO_DIR,
} from "./tts.js";
export type { Rung, SpokenResult, VoiceHint } from "./tts.js";
export {
  fetchModel,
  installed as modelInstalled,
  removeModel,
  SPECS,
  KOKORO,
  PIPER,
} from "./models.js";
export type { ModelSpec, Progress } from "./models.js";
export {
  install as installHooks,
  uninstall as uninstallHooks,
  status as hookStatus,
  PROFILES,
  settingsPath,
  hasCurl,
  curlrcPath,
  speakrcPath,
  writeCurlrcs,
  speakCommand,
  installAssets,
  removeAssets,
  legacyAssets,
  isLegacy,
} from "./hooks.js";
export type { InstallResult } from "./hooks.js";
export { Board, KINDS as PIN_KINDS, MAX_PINS, DEFAULT_TTL_S } from "./pins.js";
export type { Pin, PinKind, PinEvent } from "./pins.js";
