import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-upg-"));
process.env.KIKOE_HOME = HOME;
// Never the real ~/.claude: a test that reaches it deletes real files.
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let hooks: typeof import("../src/hooks.js");
let speaker: typeof import("../src/speaker.js");
let daemonMod: typeof import("../src/daemon.js");

beforeAll(async () => {
  hooks = await import("../src/hooks.js");
  speaker = await import("../src/speaker.js");
  daemonMod = await import("../src/daemon.js");
});

const LEGACY = {
  hooks: {
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command:
              '"C:\\Users\\me\\.claudetalks\\.venv\\Scripts\\python.exe" -S "C:\\Users\\me\\orca\\claudetalks\\hooks\\claude_code_hook.py"',
          },
        ],
      },
      { hooks: [{ type: "command", command: "python ~/mine/notify.py" }] },
    ],
    PostToolUse: [
      {
        matcher: "*",
        hooks: [
          { type: "command", command: "python -S /home/me/claudetalks/hooks/claude_code_hook.py" },
        ],
      },
    ],
  },
};

describe("migration from ClaudeTalks", () => {
  it("recognises the old hooks, never adopts them, removes them only on request", () => {
    const file = path.join(HOME, "settings.json");
    writeFileSync(file, JSON.stringify(LEGACY));
    const s = hooks.status(file);
    expect(s.installed).toEqual([]);
    expect(s.legacy).toEqual(["PostToolUse", "Stop"]);

    // Installing ours leaves theirs alone.
    hooks.install({ profile: "attention", file, port: 4570, token: "t", assets: false });
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.hooks.Stop.length).toBe(3);

    // A plain uninstall removes ours only.
    hooks.uninstall({ file });
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.Stop.length).toBe(2);

    // The migration removes the old ones and keeps the stranger's.
    const r = hooks.uninstall({ file, legacy: true });
    expect(r.legacyRemoved.sort()).toEqual(["PostToolUse", "Stop"]);
    const gone = JSON.parse(readFileSync(file, "utf8"));
    expect(gone.hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "python ~/mine/notify.py" }] },
    ]);
    expect(gone.hooks.PostToolUse).toBeUndefined();
  });
});

describe("the suite never touches the real Claude home", () => {
  it("writes assets under the overridden directory only", () => {
    const file = path.join(HOME, "assets.json");
    writeFileSync(file, "{}");
    const r = hooks.install({ profile: "attention", file, port: 4570, token: "t" });
    expect(r.assets.length).toBe(2);
    for (const a of r.assets) expect(a.startsWith(path.join(HOME, "claude"))).toBe(true);
    expect(hooks.claudeDir()).toBe(path.join(HOME, "claude"));
  });
});

describe("earcons", () => {
  it("are short, quiet, and click-free at the edges", () => {
    for (const kind of ["tick", "question", "done", "error"] as const) {
      const pcm = speaker.earcon(kind, 24000);
      expect(pcm.length / 24000).toBeLessThan(0.35);
      let peak = 0;
      for (const v of pcm) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeLessThan(0.3);
      expect(Math.abs(pcm[0]!)).toBeLessThan(0.001);
      expect(Math.abs(pcm[pcm.length - 1]!)).toBeLessThan(0.001);
    }
  });
});

describe("the agent's own line", () => {
  it("silences the Stop hook's summary for that turn, and nothing else", async () => {
    const cfg = await import("../src/config.js");
    const d = new daemonMod.Daemon({ audio: false, settings: { ...cfg.DEFAULTS, tts: "none" } });
    const cwd = HOME;
    // Claude spoke for itself.
    d.say("Race is fixed.", 2, "agent");
    const queued = d.hook({
      hook_event_name: "Stop",
      session_id: "s",
      cwd,
      last_assistant_message: "Fixed the race in the token refresh.",
    });
    expect(queued?.kind).toBe("turn_end");
    // The self-spoken line is queued; the summary is not.
    const st = d.arbiter.state();
    expect(st.queued + (st.speaking ? 1 : 0)).toBeLessThanOrEqual(1);
    // A permission question still gets through inside the window.
    d.hook({
      hook_event_name: "PermissionRequest",
      session_id: "s",
      cwd,
      tool_name: "Bash",
      tool_input: { command: "git push" },
    });
    expect(d.tracker.snapshot().s?.status).toBe("waiting");
    expect(d.state().sessions.s?.pending_permission).toContain("git push");
    return d.close();
  });

  it("records what it said with a measured latency", async () => {
    const d = new daemonMod.Daemon({ audio: false });
    d.recordSpoken("Done.", { backend: "test", ttfaMs: 40, audioS: 0.5 }, undefined, Date.now());
    expect(d.state().history[0]?.text).toBe("Done.");
    expect(d.state().history[0]?.latency_ms).toBeNull();
    await d.close();
  });
});
