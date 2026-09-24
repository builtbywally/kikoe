/**
 * Quick look-ups, with the network faked.
 *
 * Worth pinning: a page is handed to Kik as quoted data, a public page
 * cannot redirect the fetch onto this machine, and the weather reads as a
 * sentence rather than a table of numbers.
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-lookup-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let mod: typeof import("../src/lookup.js");
let dmod: typeof import("../src/daemon.js");
let cfg: typeof import("../src/config.js");
beforeAll(async () => {
  mod = await import("../src/lookup.js");
  dmod = await import("../src/daemon.js");
  cfg = await import("../src/config.js");
});

const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });

describe("the weather", () => {
  it("reads as a sentence", async () => {
    const fake = (async (u: string) =>
      String(u).includes("geocoding")
        ? json({
            results: [{ name: "Beirut", country: "Lebanon", latitude: 33.9, longitude: 35.5 }],
          })
        : json({
            current: { temperature_2m: 27.4, weather_code: 1, wind_speed_10m: 11 },
            daily: {
              weather_code: [0, 61],
              temperature_2m_max: [29, 26],
              temperature_2m_min: [21, 20],
              precipitation_probability_max: [5, 70],
            },
          })) as typeof fetch;
    const said = await mod.weather("Beirut", fake);
    expect(said).toContain("Beirut, Lebanon: now 27°C and partly cloudy");
    expect(said).toContain("Tomorrow rain, 20 to 26°C, 70% chance of rain");
  });
  it("asks where, rather than guessing", async () => {
    expect(await mod.weather("  ")).toMatch(/which place/);
  });
});

describe("a page", () => {
  it("is text, marked as data and not instructions", async () => {
    const fake = (async () =>
      new Response(
        "<html><title>Hi</title><script>evil()</script><p>Hello &amp; welcome</p></html>",
        { status: 200, headers: { "content-type": "text/html" } },
      )) as typeof fetch;
    const out = await mod.pageText("https://example.com", fake);
    expect(out).toContain("not instructions");
    expect(out).toContain("Hello & welcome");
    expect(out).not.toContain("evil");
  });
  it("never reaches this machine, even through a redirect", async () => {
    expect(await mod.pageText("http://localhost:4570/state")).toMatch(/public pages/);
    expect(await mod.pageText("http://192.168.1.4/")).toMatch(/public pages/);
    const bounce = (async () =>
      new Response("", {
        status: 302,
        headers: { location: "http://127.0.0.1:4570/state" },
      })) as typeof fetch;
    expect(await mod.pageText("https://example.com", bounce)).toMatch(/public pages/);
  });
});

describe("a work card by voice", () => {
  it("reads the latest diff back, and sends revert to the agent", async () => {
    const d = new dmod.Daemon({
      settings: { ...cfg.DEFAULTS, tts: "none", port: 0 },
      audio: false,
      persistBoard: false,
    });
    d.board.add({
      kind: "diff",
      title: "tracker.ts +1 -1",
      body: "--- a/src/tracker.ts\n@@ -1,1 +1,1 @@\n-a\n+b",
      repo: "kikoe",
      stream: "work",
    });
    const tool = d.brainTools().find((t) => t.name === "work_card");
    expect(await tool?.run({ action: "read" })).toContain("+b");
    await tool?.run({ action: "revert" });
    expect(d.instructions.map((i) => i.text).join(" ")).toContain("src/tracker.ts");
    expect(await tool?.run({ action: "again" })).toMatch(/no work card/);
    await d.close();
  });
});

describe("the day, in brief", () => {
  const rig = (extra: Record<string, unknown> = {}) => {
    const posts: { url: string; body: string; title: string }[] = [];
    const f = (async (u: string, init?: RequestInit) => {
      posts.push({
        url: String(u),
        body: String(init?.body ?? ""),
        title: String((init?.headers as Record<string, string>)?.Title ?? ""),
      });
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const d = new dmod.Daemon({
      settings: { ...cfg.DEFAULTS, tts: "none", port: 0, ...extra },
      audio: false,
      persistBoard: false,
      fetchImpl: f,
    });
    return { d, posts };
  };

  it("answers what's on today from the calendar it holds, and asks the desk for the rest", async () => {
    const { d } = rig();
    expect(d.agendaAnswers("what's on today")).toBe(false);
    d.agenda = { text: "Today: 10:00 Standup. Tomorrow: nothing.", at: Date.now() };
    expect(d.agendaAnswers("what's on my calendar today")).toBe(true);
    expect(d.agendaAnswers("am I free this afternoon")).toBe(true);
    expect(d.agendaAnswers("move my standup to 11")).toBe(false);
    expect(d.agendaAnswers("what's on next week")).toBe(false);
    d.agenda.at = Date.now() - 3 * 3600_000;
    expect(d.agendaAnswers("what's on today")).toBe(false);
    await d.close();
  });

  it("gives only the facts it has", async () => {
    const { d } = rig();
    d.agenda = { text: "Today: 10:00 Standup. Tomorrow: 9:00 Dentist.", at: Date.now() };
    const morning = d.dayFacts("morning");
    expect(morning).toContain("10:00 Standup");
    d.board.add({ kind: "diff", title: "api.ts +4 -1", body: "x", repo: "kikoe", stream: "work" });
    const wrap = d.dayFacts("wrap");
    expect(wrap).toContain("1 changes");
    expect(wrap).toContain("Tomorrow: 9:00 Dentist");
    await d.close();
  });

  it("pushes to a locked phone only when a topic is set", async () => {
    const off = rig();
    off.d.notify("Reminder", "call the printer");
    expect(off.posts).toHaveLength(0);
    await off.d.close();
    const on = rig({ push_topic: "kik-7f3a9c2e1b" });
    on.d.notify("Reminder", "call the printer");
    expect(on.posts[0]?.url).toBe("https://ntfy.sh/kik-7f3a9c2e1b");
    expect(on.posts[0]?.body).toBe("call the printer");
    // a topic that could be a path is not a topic
    const bad = rig({ push_topic: "../../etc" });
    bad.d.notify("x", "y");
    expect(bad.posts).toHaveLength(0);
    await on.d.close();
    await bad.d.close();
  });
});
