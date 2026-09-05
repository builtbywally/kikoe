/**
 * Wire kikoe into Claude Code, idempotently and non-destructively: the
 * hooks in settings.json, the output style that lets Claude write its own
 * spoken line, and the `speak` skill. Merges into existing settings, marks
 * what it owns, backs the file up first, and can remove exactly that again.
 *
 * The hook itself is `curl`: it ships with every OS the audience uses,
 * starts in about ten milliseconds, and prints the daemon's response to
 * stdout, which is exactly how a hook returns a decision. The URL and the
 * token live in `~/.kikoe/hook.curlrc` (owner-only), not in settings.json.
 * On a machine with no curl, a stdlib-only Node hook is written instead.
 */

import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, ensureHome } from "./config.js";

export const MARKER = "kikoe";
export const ASSET_MARKER = "<!-- installed by kikoe -->";

/**
 * Every hook is a subprocess on the agent's critical path, so richness is
 * opt-in. What matters is how often an event fires, not how many are listed.
 */
const ATTENTION = ["Notification", "PermissionRequest", "Elicitation", "Stop", "StopFailure"];
const BALANCED = [
  ...ATTENTION,
  "PostToolUseFailure",
  "PermissionDenied",
  "SubagentStop",
  "TaskCompleted",
  "SessionStart",
  "SessionEnd",
  "PostToolUse",
];
export const PROFILES: Record<string, string[]> = {
  attention: ATTENTION,
  balanced: BALANCED,
  full: [...BALANCED, "PreToolUse", "UserPromptSubmit", "SubagentStart", "TaskCreated"],
};

/** Events where Claude Code expects a tool matcher. */
const MATCHER_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
]);

/** Seconds Claude Code waits for the hook. Permission requests wait for a spoken answer. */
const TIMEOUTS: Record<string, number> = { PermissionRequest: 25, Elicitation: 25, Stop: 5 };
const DEFAULT_TIMEOUT = 3;

/**
 * Claude Code's home. Overridable so that tests, and anyone with a relocated
 * Claude Code, never touch the real one by accident: the day this was not
 * overridable, the test suite deleted the author's own output styles.
 */
export function claudeDir(): string {
  return process.env.KIKOE_CLAUDE_DIR || path.join(os.homedir(), ".claude");
}

export function settingsPath(scope: "user" | "project" = "user", cwd = process.cwd()): string {
  if (scope === "project") return path.join(cwd, ".claude", "settings.json");
  return path.join(claudeDir(), "settings.json");
}

export const curlrcPath = () => path.join(HOME, "hook.curlrc");
export const speakrcPath = () => path.join(HOME, "speak.curlrc");
export const showrcPath = () => path.join(HOME, "show.curlrc");
export const nodeHookPath = () => path.join(HOME, "hook.js");

export function hasCurl(): boolean {
  const exts = process.platform === "win32" ? [".exe"] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const ext of exts) if (dir && existsSync(path.join(dir, `curl${ext}`))) return true;
  }
  return process.platform === "win32" && existsSync("C:\\Windows\\System32\\curl.exe");
}

/**
 * Owner-only. Mode 600 is a no-op on NTFS, so Windows gets an ACL: strip
 * inheritance and grant the current user alone. Best effort: a failure here
 * must not stop the install.
 */
export function ownerOnly(file: string): void {
  if (process.platform !== "win32") return;
  const user = process.env.USERNAME || os.userInfo().username;
  execFile(
    "icacls",
    [file, "/inheritance:r", "/grant:r", `${user}:F`],
    { windowsHide: true },
    () => {},
  );
}

function writePrivate(file: string, body: string): void {
  writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
  ownerOnly(file);
}

/** The curl configs the hook and the speak command read: URL and token, never in settings.json. */
export function writeCurlrcs(port: number, token: string): void {
  ensureHome();
  const common = [
    `header = "Authorization: Bearer ${token}"`,
    "silent",
    "show-error",
    "max-time = 30",
    "",
  ];
  writePrivate(
    curlrcPath(),
    [
      "# kikoe hook: written by the app, read by curl on every hook call.",
      `url = "http://127.0.0.1:${port}/hook/claude"`,
      'header = "Content-Type: application/json"',
      ...common,
    ].join("\n"),
  );
  writePrivate(
    showrcPath(),
    [
      "# kikoe show: the agent's whiteboard. Body is the content; kind, title,",
      "# repo and ask ride in X-Kikoe-* headers passed on the command line.",
      `url = "http://127.0.0.1:${port}/show"`,
      'header = "Content-Type: text/plain"',
      'header = "X-Kikoe-Source: agent"',
      `header = "Authorization: Bearer ${token}"`,
      "silent",
      "show-error",
      "max-time = 130",
      "",
    ].join("\n"),
  );
  writePrivate(
    speakrcPath(),
    [
      "# kikoe speak: the agent's own spoken line.",
      `url = "http://127.0.0.1:${port}/speak"`,
      'header = "Content-Type: text/plain"',
      'header = "X-Kikoe-Source: agent"',
      ...common,
    ].join("\n"),
  );
}

/** The stdlib-only Node hook for machines without curl. Exit 0 always. */
export function nodeHookSource(port: number): string {
  return `#!/usr/bin/env node
// kikoe hook (Node fallback). Reads the payload on stdin, POSTs it to the
// daemon, prints the daemon's answer, exits 0 whatever happens.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const home = process.env.KIKOE_HOME || path.join(os.homedir(), ".kikoe");
let token = "";
try { token = fs.readFileSync(path.join(home, "daemon_token.txt"), "utf8").trim(); } catch {}
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const body = Buffer.concat(chunks);
  const req = http.request({ host: "127.0.0.1", port: ${port}, path: "/hook/claude", method: "POST",
    headers: { "content-type": "application/json", "content-length": body.length, authorization: "Bearer " + token },
    timeout: 28000 }, (res) => { res.pipe(process.stdout); res.on("end", () => process.exit(0)); });
  req.on("timeout", () => { req.destroy(); process.exit(0); });
  req.on("error", () => process.exit(0));
  req.end(body);
});
`;
}

export function hookCommand(kind: "curl" | "node"): string {
  if (kind === "curl") return `curl -K "${curlrcPath().replace(/\\/g, "/")}" --data-binary @-`;
  return `node "${nodeHookPath().replace(/\\/g, "/")}"`;
}

export function speakCommand(): string {
  return `curl -K "${speakrcPath().replace(/\\/g, "/")}" --data-raw`;
}

export function showCommand(): string {
  return `curl -K "${showrcPath().replace(/\\/g, "/")}"`;
}

type HookEntry = { type: string; command: string; timeout?: number; _source?: string };
type HookGroup = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Record<string, HookGroup[]> | undefined; [k: string]: unknown };

function load(file: string): Settings {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`refusing to touch malformed JSON at ${file}: ${(e as Error).message}`);
  }
}

function save(file: string, data: Settings): string {
  mkdirSync(path.dirname(file), { recursive: true });
  let backup = "";
  if (existsSync(file)) {
    backup = `${file}.kikoe-bak`;
    copyFileSync(file, backup);
  }
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return backup;
}

/**
 * Ownership is detected by the command, not by a custom field: Claude Code
 * rewrites settings.json and strips keys it doesn't know.
 */
export function isOurs(group: HookGroup): boolean {
  for (const h of group.hooks ?? []) {
    const c = String(h.command ?? "")
      .replace(/\\/g, "/")
      .toLowerCase();
    if (h._source === MARKER) return true;
    if (c.includes("/.kikoe/hook.curlrc") || c.includes("/.kikoe/hook.js")) return true;
    if (c.includes("kikoe") && /hook\.(curlrc|js)/.test(c)) return true;
  }
  return false;
}

/**
 * A hook left by the predecessor projects. Recognised, never written, and
 * only removed on request: it may still be a working install of the old
 * package that the user wants to keep.
 */
export function isLegacy(group: HookGroup): boolean {
  for (const h of group.hooks ?? []) {
    const c = String(h.command ?? "")
      .replace(/\\/g, "/")
      .toLowerCase();
    const src = String(h._source ?? "").toLowerCase();
    if (["claudetalks-voice", "cloudtalks-voice", "jarvis-voice"].includes(src)) return true;
    if (/claude_code_hook\.py|codex_notify\.py/.test(c) && /claudetalks|cloudtalks|jarvis/.test(c))
      return true;
    if (c.includes("/claudetalks/hooks/")) return true;
  }
  return false;
}

export interface InstallResult {
  file: string;
  backup: string;
  events: string[];
  command: string;
  kind: "curl" | "node";
  assets: string[];
}

export function install(opts: {
  profile?: string;
  file?: string;
  port: number;
  token: string;
  dryRun?: boolean;
  /** also write the output style and the speak skill */
  assets?: boolean;
}): InstallResult {
  const profile = opts.profile ?? "balanced";
  const events = PROFILES[profile];
  if (!events)
    throw new Error(`unknown profile ${profile}; one of ${Object.keys(PROFILES).join(", ")}`);
  const file = opts.file ?? settingsPath();
  const kind: "curl" | "node" = hasCurl() ? "curl" : "node";
  if (!opts.dryRun) {
    writeCurlrcs(opts.port, opts.token);
    if (kind === "node") writePrivate(nodeHookPath(), nodeHookSource(opts.port));
  }
  const command = hookCommand(kind);

  const data = load(file);
  const hooks: Record<string, HookGroup[]> = { ...(data.hooks ?? {}) };
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = (hooks[ev] ?? []).filter((g) => !isOurs(g));
    if (!hooks[ev]!.length) delete hooks[ev];
  }
  for (const ev of events) {
    const entry: HookEntry = {
      type: "command",
      command,
      timeout: TIMEOUTS[ev] ?? DEFAULT_TIMEOUT,
    };
    const group: HookGroup = MATCHER_EVENTS.has(ev)
      ? { matcher: "*", hooks: [entry] }
      : { hooks: [entry] };
    hooks[ev] = [...(hooks[ev] ?? []), group];
  }
  data.hooks = hooks;
  const backup = opts.dryRun ? "" : save(file, data);
  const assets = opts.assets !== false && !opts.dryRun ? installAssets() : [];
  return { file, backup, events, command, kind, assets };
}

export function uninstall(opts: { file?: string; dryRun?: boolean; legacy?: boolean } = {}): {
  file: string;
  removed: string[];
  legacyRemoved: string[];
  assets: string[];
} {
  const file = opts.file ?? settingsPath();
  const data = load(file);
  const hooks = data.hooks ?? {};
  const removed: string[] = [];
  const legacyRemoved: string[] = [];
  for (const ev of Object.keys(hooks)) {
    const before = hooks[ev] ?? [];
    const after = before.filter((g) => {
      if (isOurs(g)) return false;
      if (opts.legacy && isLegacy(g)) {
        legacyRemoved.push(ev);
        return false;
      }
      return true;
    });
    if (before.some(isOurs)) removed.push(ev);
    if (after.length) hooks[ev] = after;
    else delete hooks[ev];
  }
  data.hooks = Object.keys(hooks).length ? hooks : undefined;
  if (!opts.dryRun && (removed.length || legacyRemoved.length)) save(file, data);
  const assets = opts.dryRun ? [] : removeAssets(Boolean(opts.legacy));
  return { file, removed, legacyRemoved: [...new Set(legacyRemoved)], assets };
}

export function status(file = settingsPath()): {
  file: string;
  installed: string[];
  kind: "curl" | "node" | "";
  legacy: string[];
  assets: string[];
  legacyAssets: string[];
} {
  let data: Settings;
  try {
    data = load(file);
  } catch {
    return { file, installed: [], kind: "", legacy: [], assets: [], legacyAssets: [] };
  }
  const installed: string[] = [];
  const legacy: string[] = [];
  let kind: "curl" | "node" | "" = "";
  for (const [ev, groups] of Object.entries(data.hooks ?? {})) {
    for (const g of groups) {
      if (isOurs(g)) {
        installed.push(ev);
        kind = (g.hooks[0]?.command ?? "").startsWith("curl") ? "curl" : "node";
      } else if (isLegacy(g)) legacy.push(ev);
    }
  }
  return {
    file,
    installed: installed.sort(),
    kind,
    legacy: [...new Set(legacy)].sort(),
    assets: assetStatus(),
    legacyAssets: legacyAssets(),
  };
}

// --- the output style and the skill ------------------------------------------
//
// Plain markdown files in the user's ~/.claude tree. Their names are not ours
// to reserve, so an existing file is never overwritten unless it carries our
// marker. A voice layer that silently replaces a skill someone wrote is not
// a good houseguest.

const ASSETS: Record<string, { rel: string[]; body: () => string }> = {
  "output-style": { rel: ["output-styles", "kikoe.md"], body: outputStyle },
  skill: { rel: ["skills", "speak", "SKILL.md"], body: speakSkill },
};

function assetPath(rel: string[]): string {
  return path.join(claudeDir(), ...rel);
}

function marked(file: string): boolean {
  try {
    return readFileSync(file, "utf8").includes(ASSET_MARKER);
  } catch {
    return false;
  }
}

function isLegacyAsset(file: string): boolean {
  try {
    const b = readFileSync(file, "utf8");
    // Files from the predecessor project, and from this one under its working name.
    return !b.includes(ASSET_MARKER) && /installed by (claudetalks|earshot)|ct speak/.test(b);
  } catch {
    return false;
  }
}

export function installAssets(): string[] {
  const written: string[] = [];
  for (const { rel, body } of Object.values(ASSETS)) {
    const file = assetPath(rel);
    // Theirs, not ours: leave it. A predecessor's file counts as ours to replace.
    if (existsSync(file) && !marked(file) && !isLegacyAsset(file)) continue;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body(), "utf8");
    written.push(file);
  }
  return written;
}

const LEGACY_ASSET_PATHS = () => [
  assetPath(["output-styles", "claudetalks.md"]),
  assetPath(["output-styles", "voice.md"]),
  assetPath(["skills", "speak", "SKILL.md"]),
];

export function removeAssets(legacy = false): string[] {
  const removed: string[] = [];
  const candidates = Object.values(ASSETS).map((a) => assetPath(a.rel));
  if (legacy) candidates.push(...LEGACY_ASSET_PATHS());
  for (const file of new Set(candidates)) {
    if (marked(file) || (legacy && isLegacyAsset(file))) {
      try {
        unlinkSync(file);
        removed.push(file);
      } catch {
        /* already gone */
      }
    }
  }
  return removed;
}

export function assetStatus(): string[] {
  return Object.values(ASSETS)
    .map((a) => assetPath(a.rel))
    .filter((f) => marked(f));
}

/** Legacy assets from the predecessor project, if present. */
export function legacyAssets(): string[] {
  return LEGACY_ASSET_PATHS().filter(isLegacyAsset);
}

function speakLine(): string {
  return `${speakCommand()} "Race is fixed. Three tests still failing, all Windows path stuff."`;
}

function outputStyle(): string {
  return `---
name: Kikoe Voice
description: Work normally, and at the end of a turn say one good line out loud through kikoe.
---
${ASSET_MARKER}
# Voice

You are Claude Code, working normally, with one addition: this user is not
reading the screen. They are somewhere else in the room and they hear you.

Everything you already do stays exactly as it is. Your terminal output stays
full and precise. Nothing below trades away correctness for performance.

## The command

There is a text-to-speech service on this machine:

\`\`\`bash
${speakLine()}
\`\`\`

An ordinary Bash call. It returns in well under a second, prints nothing, and
does not block. If it errors, kikoe isn't running: say so once in text,
then carry on. Never retry it in a loop.

Call it with the Bash tool. Writing the command inside a code fence plays
nothing; it is a tool call like any other. The text goes in double quotes;
avoid double quotes inside it.

## When to speak

**At the end of your turn, speak one line.** Three other moments earn a line
mid-turn: you need them (a permission prompt, a decision only they can make),
something broke, or a long wait ended.

Stay quiet for everything else: file reads, greps, individual edits, progress
for its own sake. Two spoken lines in a turn is usually one too many. A bare
acknowledgement needs no line at all.

## How to say it

- **Lead with the answer.** "Tests pass," then the detail, never the reverse.
- **One sentence is the default.** Two short ones at most.
- **Under about twenty words a sentence.** No parentheses, no semicolons.
- **Never speak code, diffs, paths, or markdown.** Say "token refresh", not a
  file path. Say "get user by id", not an identifier.
- **Never speak a secret.**
- **Numbers plainly.** "Eighteen passed, two failed."
- **Contractions, always.** No robot tells: no "Great question", no "I'd be
  happy to", no announcing what you're about to do.
- **Talk to them, not about the task.** "Your build's green" beats "the build
  process completed successfully".

The spoken line is not a summary of your terminal output. It is what you
would say while they're across the room, phrased differently and shorter.
Don't add a transcript of the spoken line to your response.

When you need a decision, ask it in a form answerable by voice, with the
consequence in it: "It wants to delete node modules. Shall I?"

## The board

Some things can't be said: a diff, a failing test's lines, a diagram, a
before-and-after. Those go on the board, with a spoken line that points
at them. The bar is the same as for speaking: a diff you want approved, a
failure worth seeing, a decision worth a picture. Never a file you merely
read.

\`\`\`bash
git diff | ${showCommand()} -H "X-Kikoe-Kind: diff" -H "X-Kikoe-Title: token refresh" --data-binary @-
${showCommand()} -H "X-Kikoe-Kind: markdown" -H "X-Kikoe-Title: why the retry is bounded" --data-binary @notes.md
\`\`\`

Kinds: diff, markdown, text, table, image, html, svg, diagram.

**Vectors.** A picture beats a paragraph for a flow or a shape. Two ways:

\`\`\`bash
# boxes and arrows, laid out for you: one edge per line, * marks the current node
printf 'fetch -> retry x3 -> give up\nretry x3 -> backoff 200, 800, 3200 ms\n*retry x3\nnote: a fourth attempt never helped\n' | ${showCommand()} -H "X-Kikoe-Kind: diagram" -H "X-Kikoe-Title: why the retry is bounded" --data-binary @-
# any SVG you draw yourself; use currentColor so it takes the theme
${showCommand()} -H "X-Kikoe-Kind: svg" -H "X-Kikoe-Title: the state machine" --data-binary @states.svg
\`\`\`

To ask with it, add
\`-H "X-Kikoe-Ask: apply,no"\`: the command blocks until the user answers
by voice or click and prints the answer, so you can act on it.
`;
}

function speakSkill(): string {
  return `---
name: speak
description: "Speak aloud to the user through kikoe. Use whenever the user is working by voice, asks you to talk to them, says they are stepping away, or asks a question out loud, and at natural attention points during long work: finishing a turn, needing permission, hitting an error, or finishing a test run. Also use when the user says 'talk to me', 'tell me when you're done', 'read that out', 'speak', or 'voice mode'. Speaking is for moments a person would look up for, not a narration of every step."
---
${ASSET_MARKER}
You can talk. There is a text-to-speech service on this machine and a command
that sends a line to it:

\`\`\`bash
${speakLine()}
\`\`\`

Run it as an ordinary Bash command. It returns quickly and prints nothing. If
it fails, kikoe isn't running: say so once in text and carry on; never retry
in a loop.

Default to silence. Speak when a colleague would have looked up: you need
them, something broke, you finished, they asked, or a long wait ended. Lead
with the answer, one sentence, under twenty words, no code, no paths, no
markdown, no secrets, contractions always, no robot tells.

What can't be said goes on the board, with a line that points at it:

\`\`\`bash
git diff | ${showCommand()} -H "X-Kikoe-Kind: diff" -H "X-Kikoe-Title: token refresh" --data-binary @-
\`\`\`

Add \`-H "X-Kikoe-Ask: apply,no"\` to ask with it; the command blocks until
the user answers and prints the answer.
`;
}
