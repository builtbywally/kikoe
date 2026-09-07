/**
 * The projection that stopped throwing the work away.
 *
 * `asText` answers "what should be said about this" and returns "" for an
 * edit, which is right for the voice and is why the diff Claude Code already
 * computed never reached the canvas. These tests pin the shapes Claude Code
 * actually sends, so a schema change is a red test rather than an empty card.
 */

import { describe, expect, it } from "vitest";
import * as ev from "../src/events.js";
import { ClaudeCodeAdapter, asText, toolResult } from "../src/index.js";

describe("toolResult", () => {
  it("keeps the patch an Edit returns, which asText cannot see", () => {
    const resp = {
      filePath: "C:/repo/src/tracker.ts",
      oldString: "const a = 1;",
      newString: "const a = 2;",
      originalFile: "…",
      structuredPatch: [
        {
          oldStart: 40,
          oldLines: 3,
          newStart: 40,
          newLines: 3,
          lines: [" ctx", "-const a = 1;", "+const a = 2;"],
        },
      ],
      userModified: false,
    };

    // The bug, kept as a test so nobody "fixes" asText instead.
    expect(asText(resp)).toBe("");

    const r = toolResult(resp);
    expect(r.filePath).toBe("C:/repo/src/tracker.ts");
    expect(r.structuredPatch).toHaveLength(1);
    expect(r.structuredPatch?.[0]?.newStart).toBe(40);
    expect(r.structuredPatch?.[0]?.lines).toContain("+const a = 2;");
  });

  it("keeps stderr, which was never read at all", () => {
    const r = toolResult({
      stdout: "",
      stderr: "error TS2305: no exported member",
      interrupted: false,
    });
    expect(r.stderr).toContain("TS2305");
    expect(r.stdout).toBe("");
  });

  it("marks an interrupted command", () => {
    expect(toolResult({ stdout: "half", interrupted: true }).interrupted).toBe(true);
  });

  it("is empty for a response it does not recognise", () => {
    expect(toolResult({ type: "text", text: "hello" })).toEqual({});
    expect(toolResult("a string")).toEqual({});
    expect(toolResult(null)).toEqual({});
    expect(toolResult([1, 2])).toEqual({});
  });

  it("drops malformed hunks rather than trusting them", () => {
    const r = toolResult({
      structuredPatch: [{ lines: ["+ok"] }, { oldStart: 1 }, "nonsense", null],
    });
    expect(r.structuredPatch).toHaveLength(1);
    expect(r.structuredPatch?.[0]?.oldStart).toBe(0);
  });

  it("accepts file_path as well as filePath", () => {
    expect(toolResult({ file_path: "a/b.ts" }).filePath).toBe("a/b.ts");
  });
});

describe("the adapter carries the result through", () => {
  const adapter = new ClaudeCodeAdapter();

  it("puts the patch on the event and still says nothing about it", () => {
    const e = adapter.ingestHook({
      hook_event_name: "PostToolUse",
      session_id: "s1",
      cwd: "C:/repo",
      tool_name: "Edit",
      tool_input: { file_path: "C:/repo/a.ts", old_string: "x", new_string: "y" },
      tool_response: {
        filePath: "C:/repo/a.ts",
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x", "+y"] },
        ],
      },
    });

    expect(e.kind).toBe(ev.TOOL_END);
    // Nothing new to say: the voice is unchanged by this feature.
    expect(e.text).toBe("");
    // But the change is now on the event.
    expect(e.result.structuredPatch).toHaveLength(1);
    // An edit that returns no prose still counts as having worked.
    expect(e.status).toBe("ok");
  });

  it("gives a turn's reply room to be read, not just spoken", () => {
    const long = "a".repeat(9000);
    const e = adapter.ingestHook({
      hook_event_name: "Stop",
      session_id: "s1",
      cwd: "C:/repo",
      last_assistant_message: long,
    });
    expect(e.text.length).toBe(9000);
  });

  it("leaves an event with no tool response with an empty result", () => {
    const e = adapter.ingestHook({
      hook_event_name: "SessionStart",
      session_id: "s1",
      cwd: "C:/repo",
    });
    expect(e.result).toEqual({});
  });
});
