export * as events from "./events.js";
export type {
  AgentEvent,
  EventInit,
  Clock,
  Kind,
  RepoResolver,
  Hunk,
  ToolResult,
} from "./events.js";
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
  toolResult,
  lastAssistantText,
} from "./adapters/claude-code.js";
export type { ClaudeCodeAdapterOptions } from "./adapters/claude-code.js";
export { Tracker, IDLE, WORKING, WAITING, FAILED } from "./tracker.js";
export type { Session, SessionSnapshot } from "./tracker.js";
export { Arbiter, CollectingSink, permissionId, utterance } from "./arbiter.js";
export type {
  SpeechSink,
  SpeechPhase,
  SpeechInfo,
  PermissionBinding,
  ArbiterOptions,
} from "./arbiter.js";
export { route, gate, nameLike, normalize, DEFAULT_ALIASES } from "./router.js";
export type { Decision, RouteOptions } from "./router.js";
export { answer as headAnswer, social as headSocial, knows as headKnows } from "./head.js";
export { diagramToSvg, parseDiagram } from "./diagram.js";
export type { Diagram } from "./diagram.js";
