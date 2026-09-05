/**
 * Narration evals: does it say the right thing, and stay quiet otherwise?
 *
 * The project's central claim is that the hard part is not speech but
 * knowing when to talk. Each fixture in evals/ is a stream of real Claude
 * Code hook payloads plus what should come out, including the many that
 * should produce silence. They run through the real path: adapter,
 * narrator, coalescing.
 *
 * Two kinds of assertion: per-fixture expectations, and register invariants
 * applied to every line every fixture produces. The invariants encode the
 * parts of VOICE.md a machine can check.
 *
 * To add a case, drop a JSON file in evals/. Give it a `why`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter, Narrator, type Utterance } from "@earshot/core";
import { describe, expect, it } from "vitest";

const EVALS = fileURLToPath(new URL("../../../evals/", import.meta.url));
const CWD = "/repo/storefront";

interface Fixture {
  name: string;
  why?: string;
  mode?: string;
  settle?: boolean;
  hooks: Record<string, unknown>[];
  expect: {
    spoken?: number;
    spoken_at_most?: number;
    contains_any?: string[];
    excludes?: string[];
    min_priority?: number;
    max_priority?: number;
    ends_with?: string;
  };
}

const FIXTURES: Array<[string, Fixture]> = readdirSync(EVALS)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(EVALS, f), "utf8"))]);

/** Run a fixture's hook stream and return the utterances it produces. */
function narrate(fixture: Fixture): Utterance[] {
  // An injectable clock: the settle fixtures jump time forward instead of
  // sleeping, and nothing global is patched, so nothing can leak.
  let offset = 0;
  const now = () => Date.now() / 1000 + offset;
  const narrator = new Narrator({ mode: fixture.mode ?? "normal", now });
  const adapter = new ClaudeCodeAdapter({ cwd: CWD, now });

  const lines: Utterance[] = [];
  for (const hook of fixture.hooks) {
    const event = adapter.ingestHook({ ...hook, session_id: "eval", cwd: CWD });
    if (event) lines.push(...narrator.narrate(event));
  }
  if (fixture.settle) offset += 60;
  lines.push(...narrator.tick());
  return lines;
}

// --- per-fixture expectations -----------------------------------------------

describe("narration fixtures", () => {
  it.each(FIXTURES)("%s", (_id, fixture) => {
    const exp = fixture.expect;
    const lines = narrate(fixture);
    const spoken = lines.map((u) => u.text);
    const context = spoken.join("\n  ") || "(silence)";
    const why = fixture.why ?? "";
    const explain = (msg: string) => `${fixture.name}: ${msg}\n  ${context}\n\n${why}`;

    if (exp.spoken !== undefined) {
      expect(spoken.length, explain(`expected ${exp.spoken} line(s), got ${spoken.length}`)).toBe(
        exp.spoken,
      );
    }
    if (exp.spoken_at_most !== undefined) {
      expect(spoken.length, explain("too many lines")).toBeLessThanOrEqual(exp.spoken_at_most);
    }

    const blob = spoken.join(" ").toLowerCase();

    if (exp.contains_any?.length) {
      const hit = exp.contains_any.some((n) => blob.includes(n.toLowerCase()));
      expect(hit, explain(`none of ${JSON.stringify(exp.contains_any)} found`)).toBe(true);
    }
    for (const banned of exp.excludes ?? []) {
      expect(blob.includes(banned.toLowerCase()), explain(`must not say ${banned}`)).toBe(false);
    }
    if (exp.min_priority !== undefined) {
      const top = lines.length ? Math.max(...lines.map((u) => u.priority)) : -1;
      expect(top, explain("not urgent enough")).toBeGreaterThanOrEqual(exp.min_priority);
    }
    if (exp.max_priority !== undefined) {
      for (const u of lines) {
        expect(u.priority, explain("too urgent")).toBeLessThanOrEqual(exp.max_priority);
      }
    }
    if (exp.ends_with !== undefined) {
      const last = spoken[spoken.length - 1]?.trimEnd() ?? "";
      expect(last.endsWith(exp.ends_with), explain(`expected to end with ${exp.ends_with}`)).toBe(
        true,
      );
    }
  });
});

// --- register invariants, applied to everything -----------------------------
//
// The parts of VOICE.md a machine can check. Each is a thing that makes a
// line unlistenable, not a style preference.

const BANNED: Array<[RegExp, string]> = [
  [/```/, "a code fence"],
  [/`/, "a backtick"],
  [/^\s*#{1,6}\s/m, "a markdown heading"],
  [/^\s*[-*]\s/m, "a markdown bullet"],
  [/\|.*\|/, "a table row"],
  [/\w\/\w/, "a file path"],
  [/\w\.(ts|js|tsx|jsx|py|rs|go|java|rb|json|yaml|yml|toml)\b/, "a filename with an extension"],
  [/\w_\w/, "a snake_case identifier"],
  [/[a-z][A-Z]\w/, "a camelCase identifier"],
  [/\(\)/, "an empty call's parentheses"],
  [/;/, "a semicolon"],
];

const ROBOT_TELLS = [
  "great question",
  "certainly!",
  "i'd be happy to",
  "let me know if",
  "i hope this helps",
  "as an ai",
  "in conclusion",
  "to summarize",
];

const MAX_WORDS = 20;

const LINES: Array<[string, string]> = FIXTURES.flatMap(([, fixture]) =>
  narrate(fixture).map((u): [string, string] => [fixture.name, u.text]),
);

describe("the register", () => {
  it("produced at least one line to check", () => {
    expect(LINES.length).toBeGreaterThan(0);
  });

  it.each(LINES)("%s: speakable — %s", (name, text) => {
    for (const [re, what] of BANNED) {
      expect(
        re.test(text),
        `${name}: spoken line contains ${what}\n  ${JSON.stringify(text)}`,
      ).toBe(false);
    }
  });

  it.each(LINES)("%s: no robot tells — %s", (name, text) => {
    const lowered = text.toLowerCase();
    for (const tell of ROBOT_TELLS) {
      expect(lowered.includes(tell), `${name}: ${tell} in ${JSON.stringify(text)}`).toBe(false);
    }
  });

  it.each(LINES)("%s: short enough to hear — %s", (name, text) => {
    for (const sentence of text.trim().split(/(?<=[.!?])\s+/)) {
      const words = sentence.split(/\s+/).filter((w) => w);
      expect(
        words.length,
        `${name}: ${words.length}-word sentence, limit is ${MAX_WORDS}\n  ${JSON.stringify(sentence)}`,
      ).toBeLessThanOrEqual(MAX_WORDS);
    }
  });
});

describe("the suite itself", () => {
  it("every fixture says why it exists", () => {
    for (const [, fixture] of FIXTURES) {
      expect((fixture.why ?? "").trim(), `${fixture.name} has no 'why'`).not.toBe("");
    }
  });

  it("actually covers silence", () => {
    // A narration suite made only of things it should say cannot catch a
    // narrator that never shuts up.
    const silent = FIXTURES.filter(([, f]) => f.expect.spoken === 0);
    expect(silent.length, "not enough fixtures asserting silence").toBeGreaterThanOrEqual(2);
  });
});
