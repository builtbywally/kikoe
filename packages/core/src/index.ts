export * as events from "./events.js";
export type { AgentEvent, EventInit, Clock, Kind, RepoResolver } from "./events.js";
export { scrub, firstSentences, spokenFilename, spokenIdentifier } from "./scrub.js";
export { normalizeForSpeech, splitClauses } from "./speak.js";
export type { SpeakOptions } from "./speak.js";
export {
  Narrator,
  isStale,
  summarizeCommand,
  summarizeTestOutput,
  MODES,
  SILENT,
  ATTENTION,
  NORMAL,
  VERBOSE,
  GERUND,
  INFINITIVE,
  PROGRESS_TTL,
  MILESTONE_TTL,
  COALESCE_WINDOW,
} from "./narrator.js";
export type { Utterance, Mode, NarratorOptions } from "./narrator.js";
export {
  ClaudeCodeAdapter,
  HOOK_KINDS,
  asText,
  lastAssistantText,
} from "./adapters/claude-code.js";
export type { ClaudeCodeAdapterOptions } from "./adapters/claude-code.js";
