/**
 * The register, as code. Strips everything that reads badly aloud: fences,
 * diffs, tables, paths, identifiers, markdown furniture. Returns prose a
 * speaker can say once and be understood.
 *
 * Read docs/VOICE.md before changing any rule here. The eval suite checks
 * every line every fixture produces against these rules.
 */

import { type SpeakOptions, normalizeForSpeech } from "./speak.js";

const FENCE = /```[\s\S]*?```/g;
const INLINE_FENCE = /```[\s\S]*/g; // unterminated fence
const INLINE_CODE = /`[^`\n]{0,200}`/g;
// Diff stripping is block-scoped on purpose: a line-level `^[+-]\s` rule also
// matches ordinary markdown bullets and silently eats list content.
const DIFF_MARKERS = /^@@ .*@@|^--- a\/|^\+\+\+ b\/|^diff --git /m;
const DIFF_LINE = /^\s*(?:@@ .*?@@.*|diff --git .*|index [0-9a-f]+\.\..*|[+-]{3} .*|[+-]\s.*)$/gm;
const TABLE_LINE = /^\s*\|.*\|\s*$/gm;
const HEADING = /^\s{0,3}#{1,6}\s*/gm;
const LIST_BULLET = /^\s*[-*+]\s+/gm;
const NUM_BULLET = /^\s*\d+[.)]\s+/gm;
const TODO_BOX = /^\s*[-*]?\s*\[[ xX~]\]\s*/gm;
const PATHISH = /(?:[A-Za-z]:)?(?:[\w.\-]+[\\/]){1,}([\w.\-]+)/g;
const FILE_LINE_REF = /\b([\w.\-]+\.\w{1,5}):(\d+)\b/g;
const EMOJI =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
const BLANKS = /\n{2,}/g;
const SPACES = /[ \t]{2,}/g;

/** 'src/auth/token_refresh.ts' -> 'token refresh' */
export function spokenFilename(path: string | null | undefined): string {
  if (!path) return "a file";
  const trimmed = String(path)
    .trim()
    .replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? "";
  const dot = base.lastIndexOf(".");
  let stem = dot > 0 ? base.slice(0, dot) : base;
  stem = stem.replace(/[_\-.]+/g, " ").trim();
  return stem || base;
}

const CALL_SUFFIX = /\(\s*\)\s*$/;
const DOTTED = /(?<=[A-Za-z])\.(?=[A-Za-z])/g;
const CAMEL = /(?<=[a-z0-9])(?=[A-Z])/g;

/**
 * 'lock.acquire()' -> 'lock acquire'.  'getUserById' -> 'get user by id'.
 *
 * Punctuation a reader skims over is not skimmable in audio: TTS either
 * spells it out or swallows the word around it.
 */
export function spokenIdentifier(token: string | null | undefined): string {
  let t = String(token ?? "")
    .trim()
    .replace(/^`+|`+$/g, "");
  if (!t) return "";
  if (/[\\/]/.test(t)) return spokenFilename(t); // a path: say the filename, nothing else
  t = t.replace(CALL_SUFFIX, "");
  t = t.replace(DOTTED, " ");
  t = t.replace(CAMEL, " ");
  t = t.replace(/[_\-]+/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  // Only lowercase words we split ourselves; an acronym the author wrote
  // (API, TS2345) should survive as they wrote it.
  return t
    .split(" ")
    .map((w) => (/^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w))
    .join(" ");
}

// A bare identifier in prose: nobody backticked it, but it still reads as code.
const BARE_IDENTIFIER = /\b(?![A-Z]{2,}\b)(?=\w*[_(]|\w*[a-z]\w*[A-Z])[A-Za-z][\w.]*(?:\(\s*\))?/g;

/** Strip everything that reads badly aloud. Returns speakable prose. */
export function scrub(text: string | null | undefined, opts: SpeakOptions = {}): string {
  let t = text ?? "";
  t = t.replace(FENCE, " ");
  t = t.replace(INLINE_FENCE, " ");
  t = t.replace(TABLE_LINE, " ");
  if (DIFF_MARKERS.test(t)) t = t.replace(DIFF_LINE, " ");
  t = t.replace(EMOJI, " ");
  t = t.replace(HEADING, "");
  t = t.replace(TODO_BOX, "");
  t = t.replace(LIST_BULLET, "");
  t = t.replace(NUM_BULLET, "");
  t = t.replace(INLINE_CODE, (m) => " " + spokenIdentifier(m) + " ");
  t = t.replace(FILE_LINE_REF, (_m, f: string, n: string) => spokenFilename(f) + " line " + n);
  t = t.replace(PATHISH, (m) => spokenFilename(m));
  t = t.replace(BARE_IDENTIFIER, (m) => spokenIdentifier(m));
  t = t.replace(BLANKS, ". ");
  t = t.replace(/\n/g, ". ");
  t = t.replace(SPACES, " ");
  t = t.replace(/(\.\s*){2,}/g, ". ");
  // A clause ending in ":" or "," that lost its continuation to scrubbing
  // would read as "Here it is:. Done." Collapse it to a clean stop.
  t = t.replace(/[,;:]\s*([.!?])/g, "$1");
  // Keep terminal punctuation: TTS prosody depends on it.
  t = normalizeForSpeech(t, opts).replace(/^[ ,;:]+|[ ,;:]+$/g, "");
  return t.replace(/\s+([.!?])/g, "$1");
}

/**
 * Lead with the answer. Everything after the first couple of sentences is
 * detail the listener can ask for.
 */
export function firstSentences(text: string, limit = 2, maxChars = 240): string {
  if (!text) return "";
  const parts = text.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let total = 0;
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if (out.length && total + p.length > maxChars) break;
    out.push(p);
    total += p.length;
    if (out.length >= limit) break;
  }
  return out.join(" ");
}
