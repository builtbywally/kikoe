/**
 * Last-mile text shaping for a speaker: units, abbreviations, clause splits.
 * Runs on a finished string. Anything that must happen before the text is
 * finished (streaming) lives elsewhere.
 */

const MARKDOWN = /[*_`#>|]+/g;
const MULTISPACE = /\s+/g;
const URL = /https?:\/\/\S+/g;

const UNITS: Array<[RegExp, string]> = [
  [/\b(\d+)\s*%/gi, "$1 percent"],
  [/\b(\d+)\s*ms\b/gi, "$1 milliseconds"],
  [/\b(\d{1,3})s\b/g, "$1 seconds"],
  [/\b(\d+)\s*kb\b/gi, "$1 kilobytes"],
  [/\b(\d+)\s*mb\b/gi, "$1 megabytes"],
  [/\b(\d+)\s*gb\b/gi, "$1 gigabytes"],
  [/\b(\d+)\s*km\b/gi, "$1 kilometres"],
  [/\b(\d+)\s*kg\b/gi, "$1 kilograms"],
  [/\b(\d+)\s*min\b/gi, "$1 minutes"],
  [/\b(\d+)\s*sec\b/gi, "$1 seconds"],
  [/\b(\d+)\s*hrs?\b/gi, "$1 hours"],
  [/\b(\d+)\s*°C\b/g, "$1 degrees celsius"],
  [/\b(\d+)\s*°F\b/g, "$1 degrees fahrenheit"],
];

const ABBREV: Array<[RegExp, string]> = [
  [/\bapprox\.?/gi, "approximately"],
  [/\be\.g\./gi, "for example"],
  [/\bi\.e\./gi, "that is"],
  [/\bvs\./gi, "versus"],
  [/\basap\b/gi, "as soon as possible"],
  [/\bconfig\b/gi, "configuration"],
  [/\brepo\b/gi, "repository"],
  [/\benv\b/gi, "environment"],
];

// Arabic comma (U+060C), semicolon (U+061B) and question mark (U+061F).
const CLAUSE_SPLIT = /(?<=[,;:،؛])\s+/;
const SENTENCE_END = /[.!?؟]\s*$/;
const MIN_CLAUSE = 12;
const MAX_CLAUSE = 120;

export interface SpeakOptions {
  /** ISO language of the voice. Unit and abbreviation rewriting is English only. */
  lang?: string;
}

export function normalizeForSpeech(text: string, opts: SpeakOptions = {}): string {
  let t = (text ?? "").replace(MARKDOWN, " ");
  t = t.replace(URL, "a link");
  // English only, and not merely because they are no-ops elsewhere: a unit
  // rule that matches Arabic-Indic digits hands the speaker mixed script in
  // a language the voice is not speaking.
  if ((opts.lang ?? "en") === "en") {
    for (const [re, repl] of UNITS) t = t.replace(re, repl);
    for (const [re, repl] of ABBREV) t = t.replace(re, repl);
  }
  t = t.replace(/--/g, ", ").replace(/—/g, ", ").replace(/–/g, " to ");
  t = t.replace(MULTISPACE, " ");
  return t.trim();
}

export function splitClauses(sentence: string, maxChars: number = MAX_CLAUSE): string[] {
  const s = sentence.trim();
  if (s.length <= maxChars) return s ? [s] : [];
  const parts = s.split(CLAUSE_SPLIT);
  const clauses: string[] = [];
  let cur = "";
  for (const part of parts) {
    let candidate: string;
    if (cur) {
      const joiner = /[,;:]$/.test(cur) ? " " : ", ";
      candidate = cur + joiner + part;
    } else {
      candidate = part;
    }
    if (candidate.length <= maxChars || !cur) {
      cur = candidate;
    } else {
      clauses.push(cur);
      cur = part;
    }
  }
  if (cur) clauses.push(cur);
  const merged: string[] = [];
  for (const clause of clauses) {
    const last = merged[merged.length - 1];
    if (last !== undefined && clause.length < MIN_CLAUSE) {
      merged[merged.length - 1] = `${last}, ${clause}`;
    } else if (last !== undefined && last.length < MIN_CLAUSE) {
      merged[merged.length - 1] = `${last}, ${clause}`;
    } else {
      merged.push(clause);
    }
  }
  if (merged.length) {
    const last = merged[merged.length - 1]!;
    if (!SENTENCE_END.test(last)) merged[merged.length - 1] = last.replace(/[,;: ]+$/, "");
  }
  return merged.filter((c) => c);
}
