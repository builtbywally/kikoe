import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-usage-"));
process.env.KIKOE_HOME = path.join(HOME, "kikoe");
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

const {
  ClaudeUsageProvider,
  OpenCodeUsageProvider,
  UsageStore,
  ageCopy,
  backoff,
  band,
  claudeLabel,
  claudeProfiles,
  claudeWindows,
  openCodeWindows,
  resetCopy,
} = await import("../src/usage.js");

/** The live shape, recorded from the endpoint with the numbers left as they were. */
const CLAUDE_PAYLOAD = {
  five_hour: { utilization: 36.0, resets_at: "2026-09-07T15:40:00.214159+00:00" },
  seven_day: { utilization: 45.0, resets_at: "2026-09-10T10:00:00.214182+00:00" },
  seven_day_opus: null,
  limits: [
    { kind: "session", percent: 36, resets_at: "2026-09-07T15:40:00.214159+00:00", scope: null },
    { kind: "weekly_all", percent: 45, resets_at: "2026-09-10T10:00:00.214182+00:00", scope: null },
    {
      kind: "weekly_scoped",
      percent: 74,
      resets_at: "2026-09-10T10:00:00.214438+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
    },
  ],
};

function claudeDirWith(oauth: Record<string, unknown>, dir = process.env.KIKOE_CLAUDE_DIR!) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }));
  return dir;
}

const goodToken = {
  accessToken: "sk-not-a-real-token",
  expiresAt: Date.now() + 3600_000,
  subscriptionType: "max",
};

function answering(status: number, body: unknown, headers: Record<string, string> = {}) {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers,
    })) as unknown as typeof fetch;
}

describe("bands", () => {
  it("uses codenotch's thresholds", () => {
    expect(band(0.21)).toBe("ample");
    expect(band(0.49)).toBe("ample");
    expect(band(0.52)).toBe("watch");
    // The frame shows 73% orange, so 0.7 is where critical starts — not 0.8,
    // which is what the prose table in the spec would have implied.
    expect(band(0.73)).toBe("critical");
    expect(band(1)).toBe("spent");
  });
});

describe("claude's usage endpoint", () => {
  it("reads the limits array, session first", () => {
    const windows = claudeWindows(CLAUDE_PAYLOAD);
    expect(windows.map((w) => w.id)).toEqual(["session", "weekly_all", "weekly_scoped:fable"]);
    expect(windows[0]!.used).toBeCloseTo(0.36);
  });

  it("names a scoped weekly limit after its model", () => {
    expect(claudeWindows(CLAUDE_PAYLOAD)[2]!.label).toBe("fable");
    expect(claudeLabel("weekly_scoped", { model: { display_name: "Opus" } })).toBe("opus");
    expect(claudeLabel("session")).toBe("current session");
    expect(claudeLabel("weekly_haiku")).toBe("haiku");
  });

  it("keeps two scoped limits apart", () => {
    const windows = claudeWindows({
      limits: [
        {
          kind: "weekly_scoped",
          percent: 74,
          resets_at: "2026-09-10T10:00:00Z",
          scope: { model: { display_name: "Fable" } },
        },
        {
          kind: "weekly_scoped",
          percent: 12,
          resets_at: "2026-09-10T10:00:00Z",
          scope: { model: { display_name: "Opus" } },
        },
      ],
    });
    expect(windows).toHaveLength(2);
  });

  it("keeps the session when it has just rolled out of limits", () => {
    // Claude Code's own schema drops an entry once its reset has passed, so the
    // array loses the session exactly at the reset — which is when someone is
    // most likely looking at it. The named window still carries it.
    const windows = claudeWindows({
      five_hour: { utilization: 3, resets_at: "2026-09-07T20:40:00Z" },
      limits: [{ kind: "weekly_all", percent: 45, resets_at: "2026-09-10T10:00:00Z" }],
    });
    expect(windows.map((w) => w.id)).toEqual(["session", "weekly_all"]);
    expect(windows[0]!.used).toBeCloseTo(0.03);
  });

  it("does not duplicate a window the array already carried", () => {
    expect(claudeWindows(CLAUDE_PAYLOAD).filter((w) => w.id === "session")).toHaveLength(1);
  });

  it("drops a window with no reset time rather than inventing one", () => {
    expect(claudeWindows({ limits: [{ kind: "session", percent: 9, resets_at: null }] })).toEqual(
      [],
    );
  });
});

describe("the claude provider", () => {
  beforeEach(() => claudeDirWith(goodToken));

  it("reads the endpoint with the borrowed token", async () => {
    let seen: Record<string, string> = {};
    const provider = new ClaudeUsageProvider({ slug: null, dir: process.env.KIKOE_CLAUDE_DIR! });
    const snapshot = await provider.read((async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return new Response(JSON.stringify(CLAUDE_PAYLOAD));
    }) as unknown as typeof fetch);
    expect(seen.authorization).toBe("Bearer sk-not-a-real-token");
    expect(seen["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.plan).toBe("max");
    expect(snapshot.windows).toHaveLength(3);
  });

  it("says sign in when there is no credential at all", async () => {
    const provider = new ClaudeUsageProvider({ slug: null, dir: path.join(HOME, "nothing-here") });
    await expect(provider.read(answering(200, {}))).rejects.toMatchObject({ status: "absent" });
  });

  it("treats an expired token as a stale reading, not a sign-out", async () => {
    claudeDirWith({ ...goodToken, expiresAt: Date.now() - 1000 });
    const provider = new ClaudeUsageProvider({ slug: null, dir: process.env.KIKOE_CLAUDE_DIR! });
    // Claude Code rotates this token whenever it runs and Kikoe deliberately
    // does not, so after a restart it is often stale until Claude Code is next
    // used. The message says what fixes it.
    await expect(provider.read(answering(200, {}))).rejects.toMatchObject({
      status: "needs_auth",
    });
  });

  it("backs off on a 429 without touching the network again", async () => {
    const provider = new ClaudeUsageProvider({ slug: null, dir: process.env.KIKOE_CLAUDE_DIR! });
    let calls = 0;
    const counting = (async () => {
      calls++;
      // The endpoint's own hint is useless; the doubling wait is what saves it.
      return new Response("", { status: 429, headers: { "retry-after": "0" } });
    }) as unknown as typeof fetch;
    await expect(provider.read(counting)).rejects.toMatchObject({ status: "rate_limited" });
    await expect(provider.read(counting)).rejects.toMatchObject({ status: "rate_limited" });
    expect(calls).toBe(1);
    expect(provider.retryAfter).toBeGreaterThan(Date.now());
  });

  it("never lets Retry-After: 0 mean retry now", () => {
    expect(backoff(0, 0)).toBe(60);
    expect(backoff(1, 0)).toBe(120);
    expect(backoff(9, 0)).toBe(15 * 60);
    // A server asking for longer than the doubling still wins.
    expect(backoff(0, 300)).toBe(300);
  });
});

describe("claude profiles", () => {
  it("puts the default first and the rest in a stable order", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "kikoe-profiles-"));
    for (const name of [".claude-work", ".claude-client"]) {
      mkdirSync(path.join(home, name, "sessions"), { recursive: true });
    }
    // An empty directory is not an account: a stray one made by hand would
    // otherwise put a permanent "sign in" ring on the island for ever.
    mkdirSync(path.join(home, ".claude-empty"), { recursive: true });
    expect(claudeProfiles(home).map((p) => p.slug)).toEqual([null, "client", "work"]);
  });
});

describe("opencode", () => {
  it("reads percent as used, not remaining", () => {
    const windows = openCodeWindows({
      usage: {
        rolling: { status: "ok", percent: 12, resetsAt: "2026-09-06T12:31:06.611Z" },
        weekly: { status: "ok", percent: 4, resetsAt: "2026-09-07T00:00:00.611Z" },
      },
    });
    expect(windows.map((w) => w.id)).toEqual(["rolling", "weekly"]);
    expect(windows[0]!.used).toBeCloseTo(0.12);
  });

  it("is absent rather than broken when opencode is not installed", async () => {
    const provider = new OpenCodeUsageProvider(path.join(HOME, "no-opencode.json"));
    await expect(provider.read(answering(200, {}))).rejects.toMatchObject({ status: "absent" });
  });
});

describe("the copy", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");

  it("rounds minutes up rather than truncating", () => {
    expect(resetCopy(now + 50.7 * 60_000, now)).toBe("resets in 51 min");
  });

  it("never says 60 min", () => {
    expect(resetCopy(now + 59.8 * 60_000, now)).not.toContain("60 min");
  });

  it("uses a date past the week, so a weekday cannot mean the wrong one", () => {
    // Codenotch's bug: a window 26 days out written as "resets Mon" reads as
    // *this* Monday, six days away.
    expect(resetCopy(now + 26 * 86_400_000, now)).toMatch(/^resets [A-Z][a-z]{2} \d+$/);
  });

  it("says when a reading was taken", () => {
    expect(ageCopy(0)).toBe("never read");
    expect(ageCopy(Date.now() - 4 * 60_000)).toBe("read 4 min ago");
  });
});

describe("the store", () => {
  it("keeps the last good reading when a poll fails", async () => {
    claudeDirWith(goodToken);
    const provider = new ClaudeUsageProvider({ slug: null, dir: process.env.KIKOE_CLAUDE_DIR! });
    let ok = true;
    const store = new UsageStore({
      providers: [provider],
      archive: "",
      fetchImpl: (async () =>
        ok
          ? new Response(JSON.stringify(CLAUDE_PAYLOAD))
          : new Response("", { status: 500 })) as unknown as typeof fetch,
    });
    await store.poll();
    expect(store.list()[0]!.status).toBe("ok");

    ok = false;
    provider.forget();
    await store.poll();
    const after = store.list()[0]!;
    // The number survives; what changes is that it is now labelled old, with
    // the reason beside it. A failure must never blank a reading.
    expect(after.status).toBe("stale");
    expect(after.windows).toHaveLength(3);
    expect(after.message).toContain("500");
  });

  it("shows a provider with nothing to read as absent, not as zero", async () => {
    const store = new UsageStore({
      providers: [new OpenCodeUsageProvider(path.join(HOME, "nope.json"))],
      archive: "",
      fetchImpl: answering(200, {}),
    });
    await store.poll();
    expect(store.list()[0]).toMatchObject({ status: "absent", windows: [] });
  });

  it("writes a brief the model can read out", async () => {
    claudeDirWith(goodToken);
    const store = new UsageStore({
      providers: [new ClaudeUsageProvider({ slug: null, dir: process.env.KIKOE_CLAUDE_DIR! })],
      archive: "",
      fetchImpl: answering(200, CLAUDE_PAYLOAD),
    });
    await store.poll();
    expect(store.brief()).toContain("current session 36%");
    expect(store.brief()).toContain("fable 74%");
  });

  it("carries the last reading across a restart", async () => {
    claudeDirWith(goodToken);
    const archive = path.join(HOME, "usage.json");
    const make = (fetchImpl: typeof fetch) =>
      new UsageStore({
        providers: [new ClaudeUsageProvider({ slug: null, dir: process.env.KIKOE_CLAUDE_DIR! })],
        archive,
        fetchImpl,
      });
    await make(answering(200, CLAUDE_PAYLOAD)).poll();
    // A fresh start draws the numbers it had rather than empty rings while the
    // first poll is still in flight — but says they are old.
    expect(make(answering(200, {})).list()[0]).toMatchObject({ status: "stale" });
  });
});
