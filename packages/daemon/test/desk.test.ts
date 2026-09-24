import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DESK_ALLOW, DESK_DENY, ensureDesk } from "../src/desk.js";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-desk-"));

describe("the desk's permissions", () => {
  it("reads freely, asks to make things, and can never send or destroy", () => {
    const dir = ensureDesk(HOME);
    const s = JSON.parse(readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
    const allow: string[] = s.permissions.allow;
    const deny: string[] = s.permissions.deny;
    expect(allow).toContain("mcp__claude_ai_Gmail__search_threads");
    expect(allow).toContain("mcp__claude_ai_Google_Calendar__list_events");
    // making something is asked, so it is on neither list
    for (const t of [
      "Gmail__create_draft",
      "Google_Calendar__create_event",
      "Dolmapp__create_design",
    ]) {
      expect(allow).not.toContain(`mcp__claude_ai_${t}`);
      expect(deny).not.toContain(`mcp__claude_ai_${t}`);
    }
    // what reaches someone else or cannot be undone is denied outright
    for (const t of [
      "Gmail__send_message",
      "Gmail__reply",
      "Gmail__forward",
      "Gmail__trash_thread",
      "Google_Calendar__respond_to_event",
      "Google_Drive__share_file",
    ])
      expect(deny).toContain(`mcp__claude_ai_${t}`);
    expect(deny).toContain("Bash");
    // nothing is both allowed and denied
    expect(DESK_ALLOW.filter((a) => DESK_DENY.includes(a))).toEqual([]);
  });

  it("trusts the desk folder in Claude Code's state, touching nothing else", async () => {
    const { trustDesk } = await import("../src/desk.js");
    const file = path.join(HOME, ".claude.json");
    const before = { numStartups: 42, projects: { "C:/other": { allowedTools: ["x"] } } };
    writeFileSync(file, JSON.stringify(before));
    expect(trustDesk("C:\\Users\\U\\.kikoe\\desk", file)).toBe("trusted");
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.projects["C:/Users/U/.kikoe/desk"].hasTrustDialogAccepted).toBe(true);
    expect(after.projects["C:/other"]).toEqual({ allowedTools: ["x"] });
    expect(after.numStartups).toBe(42);
    expect(JSON.parse(readFileSync(`${file}.kikoe-backup`, "utf8"))).toEqual(before);
    // a second start leaves the file alone
    expect(trustDesk("C:\\Users\\U\\.kikoe\\desk", file)).toBe("already");
    expect(trustDesk("C:\\x", path.join(HOME, "nope.json"))).toBe("no file");
  });

  it("rewrites its permissions on every start, and keeps the user's notes", () => {
    const dir = ensureDesk(HOME);
    const settings = path.join(dir, ".claude", "settings.json");
    writeFileSync(
      settings,
      JSON.stringify({ permissions: { allow: ["mcp__claude_ai_Gmail__send_message"] } }),
    );
    writeFileSync(path.join(dir, "CLAUDE.md"), "my own notes");
    ensureDesk(HOME);
    const s = JSON.parse(readFileSync(settings, "utf8"));
    expect(s.permissions.allow).not.toContain("mcp__claude_ai_Gmail__send_message");
    expect(s.permissions.deny).toContain("mcp__claude_ai_Gmail__send_message");
    expect(readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toBe("my own notes");
  });
});
