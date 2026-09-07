/**
 * The work feed: cards from what the agent did.
 *
 * The load-bearing behaviours here are the two that keep the canvas a canvas
 * rather than a log: a busy turn must never evict Kik's own artifacts, and
 * editing one file five times must be one card, not five.
 */

import { ClaudeCodeAdapter } from "@kikoe/core";
import { beforeEach, describe, expect, it } from "vitest";
import { Board, MAX_PINS, MAX_WORK } from "../src/pins.js";
import { Work, patchCounts, patchToDiff, tail, worthShowing } from "../src/work.js";

const adapter = new ClaudeCodeAdapter();

function hunk(lines: string[], newStart = 10) {
  return { oldStart: newStart, oldLines: 2, newStart, newLines: 2, lines };
}

function editEvent(file: string, lines: string[], session = "s1") {
  return adapter.ingestHook({
    hook_event_name: "PostToolUse",
    session_id: session,
    cwd: "C:/repo",
    tool_name: "Edit",
    tool_input: { file_path: file },
    tool_response: { filePath: file, structuredPatch: [hunk(lines)] },
  });
}

function bashEvent(command: string, resp: Record<string, unknown>, session = "s1") {
  return adapter.ingestHook({
    hook_event_name: "PostToolUse",
    session_id: session,
    cwd: "C:/repo",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: resp,
  });
}

describe("patch formatting", () => {
  it("keeps the hunk header, because line numbers are usually the question", () => {
    const text = patchToDiff([hunk([" ctx", "-old", "+new"], 42)], "src/a.ts");
    expect(text).toContain("--- a/src/a.ts");
    expect(text).toContain("@@ -42,2 +42,2 @@");
    expect(text).toContain("+new");
  });

  it("counts what changed", () => {
    expect(patchCounts([hunk([" ctx", "-a", "-b", "+c"])])).toEqual({ added: 1, removed: 2 });
  });

  it("keeps the tail of a long output, where the answer usually is", () => {
    const out = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const t = tail(out, 5);
    expect(t).toContain("45 earlier lines");
    expect(t).toContain("line 49");
    expect(t).not.toContain("line 10");
  });
});

describe("what earns a card", () => {
  it("shows work with a result", () => {
    expect(worthShowing("pnpm test", false)).toBe(true);
    expect(worthShowing("pnpm build", false)).toBe(true);
    expect(worthShowing("git commit -m x", false)).toBe(true);
    expect(worthShowing("vercel deploy", false)).toBe(true);
  });

  it("stays quiet about looking around", () => {
    expect(worthShowing("ls -la", false)).toBe(false);
    expect(worthShowing("cat package.json", false)).toBe(false);
    expect(worthShowing("git status", false)).toBe(false);
  });

  it("always shows a failure, however boring the command", () => {
    expect(worthShowing("ls -la", true)).toBe(true);
  });
});

describe("Work", () => {
  let board: Board;
  let work: Work;
  let focused: string[];

  beforeEach(() => {
    board = new Board(() => {});
    focused = [];
    work = new Work({ board, focus: (id) => focused.push(id) });
  });

  const workPins = () => board.list().filter((p) => p.stream === "work");

  it("turns an edit into a diff card", () => {
    work.ingest(editEvent("C:/repo/src/tracker.ts", [" ctx", "-a", "+b"]));
    const [pin] = workPins();
    expect(pin?.kind).toBe("diff");
    expect(pin?.title).toBe("tracker.ts  +1 −1");
    expect(pin?.stream).toBe("work");
    expect(pin?.by).toBe("agent");
    expect(pin?.body).toContain("+b");
  });

  it("makes one card for one file, however many times it is edited", () => {
    work.ingest(editEvent("C:/repo/a.ts", [" ctx", "+one"]));
    work.ingest(editEvent("C:/repo/a.ts", [" ctx", "+two"]));
    work.ingest(editEvent("C:/repo/a.ts", [" ctx", "+three"]));

    expect(workPins()).toHaveLength(1);
    const [pin] = workPins();
    expect(pin?.title).toBe("a.ts  +3 −0");
    expect(pin?.body).toContain("+one");
    expect(pin?.body).toContain("+three");
  });

  it("keeps separate files apart", () => {
    work.ingest(editEvent("C:/repo/a.ts", ["+one"]));
    work.ingest(editEvent("C:/repo/b.ts", ["+two"]));
    expect(workPins()).toHaveLength(2);
  });

  it("starts a fresh group on a new turn, so yesterday's file is not reopened", () => {
    work.ingest(editEvent("C:/repo/a.ts", ["+one"]));
    work.ingest(
      adapter.ingestHook({
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        cwd: "C:/repo",
        prompt: "now do the other thing",
      }),
    );
    work.ingest(editEvent("C:/repo/a.ts", ["+two"]));
    expect(workPins()).toHaveLength(2);
  });

  it("sits a turn's cards beside the first of them", () => {
    work.ingest(editEvent("C:/repo/a.ts", ["+one"]));
    work.ingest(editEvent("C:/repo/b.ts", ["+two"]));
    const [first, second] = workPins();
    expect(first?.near).toBe("");
    expect(second?.near).toBe(first?.id);
  });

  it("shows a test run as a result, with its verdict for a title", () => {
    work.ingest(bashEvent("pnpm test", { stdout: "Tests  18 passed, 2 failed" }));
    const [pin] = workPins();
    expect(pin?.kind).toBe("result");
    expect(pin?.title).toBe("18 passed, 2 failed");
  });

  it("shows a plain command as a run, with stderr kept", () => {
    work.ingest(bashEvent("pnpm build", { stdout: "out", stderr: "TS2305 somewhere" }));
    const [pin] = workPins();
    expect(pin?.kind).toBe("run");
    expect(pin?.body).toContain("$ pnpm build");
    expect(pin?.body).toContain("--- stderr ---");
    expect(pin?.body).toContain("TS2305");
  });

  it("says nothing about looking around", () => {
    work.ingest(bashEvent("ls -la", { stdout: "a\nb" }));
    expect(workPins()).toHaveLength(0);
  });

  it("takes the canvas to a failure, and not to an ordinary edit", () => {
    work.ingest(editEvent("C:/repo/a.ts", ["+one"]));
    expect(focused).toHaveLength(0);
    work.ingest(bashEvent("pnpm build", { stdout: "", stderr: "boom" }));
    expect(focused).toHaveLength(1);
  });

  it("puts the whole reply up at the end of a turn", () => {
    work.ingest(
      adapter.ingestHook({
        hook_event_name: "Stop",
        session_id: "s1",
        cwd: "C:/repo",
        last_assistant_message: "# Done\n\nTwo files changed and the tests pass.",
      }),
    );
    const [pin] = workPins();
    expect(pin?.kind).toBe("markdown");
    expect(pin?.body).toContain("Two files changed");
  });

  it("never lets a busy turn evict what Kik made", () => {
    const artifact = board.add({ kind: "markdown", body: "the design", by: "kik", repo: "repo" });
    for (let i = 0; i < MAX_WORK * 2; i++) {
      work.ingest(editEvent(`C:/repo/f${i}.ts`, ["+x"]));
    }
    expect(board.get(artifact.id)).toBeDefined();
    expect(workPins().length).toBeLessThanOrEqual(MAX_WORK);
  });

  it("does not let Kik's whiteboard evict the work either", () => {
    for (let i = 0; i < 5; i++) work.ingest(editEvent(`C:/repo/f${i}.ts`, ["+x"]));
    for (let i = 0; i < MAX_PINS * 2; i++) {
      board.add({ kind: "note", body: `n${i}`, by: "kik", repo: "repo" });
    }
    expect(workPins()).toHaveLength(5);
  });

  it("keeps work off the disk: it belongs to a session that will be over", () => {
    work.ingest(editEvent("C:/repo/a.ts", ["+one"]));
    board.add({ kind: "note", body: "kept", by: "kik", sticky: true, repo: "repo" });
    const saved = board.toJSON();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.body).toBe("kept");
  });

  it("does not let a work card fade out from under you", () => {
    let clock = 1000;
    const b = new Board(
      () => {},
      () => clock,
    );
    const w = new Work({ board: b });
    w.ingest(editEvent("C:/repo/a.ts", ["+one"]));
    b.add({ kind: "note", body: "fades", by: "kik", repo: "repo", ttl_s: 60 });
    clock += 10_000;
    b.sweep();
    const left = b.list();
    expect(left).toHaveLength(1);
    expect(left[0]?.kind).toBe("diff");
  });

  it("survives a tool response it has never seen", () => {
    expect(() => work.ingest(bashEvent("pnpm test", { weird: { shape: 1 } }))).not.toThrow();
  });
});
