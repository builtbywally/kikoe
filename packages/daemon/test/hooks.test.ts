import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Point the daemon's home at a scratch directory before it is imported.
const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-test-"));
process.env.KIKOE_HOME = HOME;
// Never the real ~/.claude: a test that reaches it deletes real files.
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let hooks: typeof import("../src/hooks.js");
let config: typeof import("../src/config.js");

beforeAll(async () => {
  hooks = await import("../src/hooks.js");
  config = await import("../src/config.js");
});

const FOREIGN = {
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "python ~/mine/notify.py" }] }],
    PostToolUse: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command:
              "~/.claudetalks/.venv/Scripts/python.exe -S ~/claudetalks/hooks/claude_code_hook.py",
          },
        ],
      },
    ],
  },
  permissions: { allow: ["Bash(npm test)"] },
};

describe("hook install", () => {
  it("merges into existing settings, marks its own, and removes exactly those", () => {
    const file = path.join(HOME, "settings.json");
    writeFileSync(file, JSON.stringify(FOREIGN, null, 2));

    const r = hooks.install({ profile: "balanced", file, port: 4570, token: "tok" });
    expect(r.events.length).toBe(hooks.PROFILES.balanced!.length);
    expect(readFileSync(`${file}.kikoe-bak`, "utf8")).toContain("mine/notify.py");

    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.permissions).toEqual(FOREIGN.permissions);
    // Ours are there.
    expect(after.hooks.PermissionRequest[0].matcher).toBe("*");
    expect(after.hooks.PermissionRequest[0].hooks[0].timeout).toBe(25);
    expect(after.hooks.Stop.length).toBe(2);
    // The stranger's hooks survived, including the predecessor project's.
    expect(after.hooks.Stop[0].hooks[0].command).toContain("mine/notify.py");
    expect(
      after.hooks.PostToolUse.some((g: { hooks: { command: string }[] }) =>
        g.hooks[0]!.command.includes("claudetalks"),
      ),
    ).toBe(true);

    // Installing again does not double up.
    hooks.install({ profile: "attention", file, port: 4570, token: "tok" });
    const again = JSON.parse(readFileSync(file, "utf8"));
    expect(again.hooks.Stop.length).toBe(2);
    expect(again.hooks.PostToolUse.length).toBe(1); // attention has no PostToolUse; only the foreign one remains

    const u = hooks.uninstall({ file });
    expect(u.removed.sort()).toEqual([...hooks.PROFILES.attention!].sort());
    const gone = JSON.parse(readFileSync(file, "utf8"));
    expect(gone.hooks.Stop).toEqual(FOREIGN.hooks.Stop);
    expect(gone.hooks.PostToolUse).toEqual(FOREIGN.hooks.PostToolUse);
    expect(gone.permissions).toEqual(FOREIGN.permissions);
  });

  it("refuses to touch malformed JSON", () => {
    const file = path.join(HOME, "broken.json");
    writeFileSync(file, "{ not json");
    expect(() => hooks.install({ file, port: 4570, token: "t" })).toThrow(/malformed JSON/);
  });

  it("keeps the token out of settings.json", () => {
    const file = path.join(HOME, "s2.json");
    const r = hooks.install({ file, port: 4570, token: "supersecret" });
    expect(readFileSync(file, "utf8")).not.toContain("supersecret");
    if (r.kind === "curl")
      expect(readFileSync(hooks.curlrcPath(), "utf8")).toContain("supersecret");
    expect(r.command).not.toContain("supersecret");
  });

  it("reports status from the file, not from memory", () => {
    const file = path.join(HOME, "s3.json");
    expect(hooks.status(file).installed).toEqual([]);
    hooks.install({ profile: "attention", file, port: 4570, token: "t" });
    const s = hooks.status(file);
    expect(s.installed.length).toBe(hooks.PROFILES.attention!.length);
    expect(["curl", "node"]).toContain(s.kind);
  });
});

describe("redaction", () => {
  it("keys never reach a log line", () => {
    const line =
      'POST xi-api-key: sk_0123456789abcdef0123456789abcdef Authorization: Bearer abc.def {"xi-api-key":"zzz"}';
    const out = config.redact(line);
    expect(out).not.toContain("sk_0123456789abcdef");
    expect(out).not.toContain("abc.def");
    expect(out).not.toContain("zzz");
    expect(out).toContain("[redacted]");
  });
});

describe("migration", () => {
  it("removes the old hooks and leaves ours, assets included", () => {
    const file = path.join(HOME, "migrate.json");
    writeFileSync(file, JSON.stringify(FOREIGN));
    hooks.install({ file, profile: "balanced", port: 4570, token: "t" });
    hooks.installAssets();
    const before = hooks.status(file);
    expect(before.installed.length).toBeGreaterThan(0);
    expect(before.legacy.length).toBeGreaterThan(0);
    const r = hooks.uninstall({ file, legacy: true, keepOurs: true });
    expect(r.legacyRemoved.length).toBeGreaterThan(0);
    expect(r.removed).toEqual([]);
    const after = hooks.status(file);
    expect(after.legacy).toEqual([]);
    expect(after.installed).toEqual(before.installed);
    expect(hooks.assetStatus().length).toBe(2);
    // the foreign hook that is neither ours nor legacy is untouched
    expect(JSON.stringify(JSON.parse(readFileSync(file, "utf8")))).toContain("notify.py");
  });
});
