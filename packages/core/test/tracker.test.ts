import { ClaudeCodeAdapter, Tracker, events as ev } from "@kikoe/core";
import { describe, expect, it } from "vitest";

describe("tracker", () => {
  it("follows a session from prompt to permission to done", () => {
    let t = 1000;
    const tr = new Tracker(() => t);
    const ad = new ClaudeCodeAdapter({ cwd: "/repo/api", now: () => t });
    const feed = (p: Record<string, unknown>) =>
      tr.apply(ad.ingestHook({ session_id: "s", cwd: "/repo/api", ...p })!);

    feed({ hook_event_name: "UserPromptSubmit", prompt: "fix it" });
    expect(tr.snapshot().s!.status).toBe("working");

    t += 5;
    feed({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "src/a.ts" },
    });
    expect(tr.snapshot().s!.current_tool).toBe("Edit");
    expect(tr.snapshot().s!.files_touched).toEqual(["src/a.ts"]);

    feed({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "3 failed, 41 passed",
    });
    expect(tr.snapshot().s!.last_test_result).toBe("41 passed, 3 failed");

    feed({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "git push" },
    });
    const w = tr.snapshot().s!;
    expect(w.status).toBe("waiting");
    expect(w.pending_permission).toContain("git push");
    expect(tr.waiting().length).toBe(1);

    feed({ hook_event_name: "Stop", last_assistant_message: "Done." });
    const d = tr.snapshot().s!;
    expect(d.status).toBe("idle");
    expect(d.turns).toBe(1);
    expect(d.pending_permission).toBe("");
    expect(tr.brief()).toContain("api: idle");
  });

  it("a working session that goes quiet reads as idle, and is evicted later", () => {
    let t = 0;
    const tr = new Tracker(() => t);
    tr.apply(ev.make({ kind: ev.TOOL_START, session: "s", tool: "Bash", cwd: "/r/x" }, () => t));
    expect(tr.snapshot().s!.status).toBe("working");
    t += 300;
    expect(tr.snapshot().s!.status).toBe("idle");
    t += 15 * 60;
    tr.evict();
    expect(Object.keys(tr.snapshot())).toEqual([]);
  });
});
