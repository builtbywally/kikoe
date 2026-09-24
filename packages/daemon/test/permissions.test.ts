import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-perm-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let mod: typeof import("../src/daemon.js");
let cap: typeof import("../src/capability.js");
let cfg: typeof import("../src/config.js");
let d: InstanceType<typeof import("../src/daemon.js").Daemon>;
let port = 0;

function post(p: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method: "POST",
        headers: {
          authorization: `Bearer ${d.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (c) => {
          out += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/** a PermissionRequest hook, held open by the daemon until it is answered */
const ask = (session: string, command: string) =>
  post("/hook/claude?timeout=10", {
    hook_event_name: "PermissionRequest",
    session_id: session,
    cwd: HOME,
    tool_name: "Bash",
    tool_input: { command },
  });
const current = () => d.state().pending_permission as { id: string; text: string } | null;

beforeAll(async () => {
  mod = await import("../src/daemon.js");
  cap = await import("../src/capability.js");
  cfg = await import("../src/config.js");
  d = new mod.Daemon({ audio: false, settings: { ...cfg.DEFAULTS, tts: "none", port: 0 } });
  port = 4900 + Math.floor(Math.random() * 90);
  await d.listen(port);
});
afterAll(async () => {
  await d.close();
});

describe("grading what Kik may do", () => {
  it("lets it look freely, asks before it acts, and says so when it cannot be undone", () => {
    expect(cap.gradeOf("read", "the screen")).toBe("read");
    expect(cap.gradeOf("write", "type hello into Notepad")).toBe("write");
    for (const t of [
      "delete the downloads folder",
      "press send on the email",
      "publish the post",
      "buy the ticket",
      "shut down the computer",
    ])
      expect(cap.gradeOf("write", t)).toBe("irreversible");
    expect(cap.mustAsk("read")).toBe(false);
    expect(cap.mustAsk("write")).toBe(true);
    expect(cap.askLine("delete the downloads folder", "irreversible")).toMatch(/can't be undone/);
  });
});

describe("one question at a time, and none lost", () => {
  it("keeps a second question waiting instead of denying the first", async () => {
    const first = ask("a", "git push");
    await tick();
    const firstId = current()?.id;
    const second = ask("b", "rm -rf build");
    await tick();
    // the first is still the one being asked
    expect(current()?.id).toBe(firstId);
    await post("/permission", { allow: true, id: firstId });
    expect((await first).body).toContain('"allow"');
    await tick();
    // and now the second is
    const secondId = current()?.id;
    expect(secondId).not.toBe(firstId);
    await post("/permission", { allow: false, id: secondId });
    expect((await second).body).toBe("");
    expect(current()).toBeNull();
  });
});

describe("Kik asking before it acts", () => {
  it("does nothing until the user says yes, through the same question", async () => {
    const answer = d.askPermission("type hello into Notepad", "write");
    await tick();
    const id = current()?.id ?? "";
    expect(id).toMatch(/^kik-/);
    expect(d.answerPermission(true, id)).toBe(true);
    expect(await answer).toBe(true);
  });

  it("takes silence as no", async () => {
    const answer = d.askPermission("open the settings", "write", 0.05);
    expect(await answer).toBe(false);
    expect(current()).toBeNull();
  });

  it("does not ask to look", async () => {
    expect(await d.askPermission("read the screen", "read")).toBe(true);
    expect(current()).toBeNull();
  });

  it("waits behind an agent's question, and can time out in line", async () => {
    const agent = ask("c", "git push");
    await tick();
    const agentId = current()?.id;
    const kik = d.askPermission("close the browser", "write", 0.05);
    expect(await kik).toBe(false);
    // the agent's question was never touched
    expect(current()?.id).toBe(agentId);
    await post("/permission", { allow: false, id: agentId });
    await agent;
  });
});
