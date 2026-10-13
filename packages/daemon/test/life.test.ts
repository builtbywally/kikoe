/**
 * The life behind Kik: the to-do list, GitHub, the inbox and its sources,
 * the ring. Every source is faked; nothing here touches the network or a
 * real account.
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Fetch,
  GitHubWatch,
  Inbox,
  TelegramSource,
  Todos,
  checkState,
  githubChanges,
  healthLine,
  parseMailLines,
  readSlack,
  todoAsk,
} from "../src/life.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "kikoe-life-"));
const json =
  (body: unknown): Fetch =>
  async () => ({ ok: true, json: async () => body });

describe("Todos", () => {
  it("adds, ticks off by the words said, and keeps the list on disk", () => {
    const file = path.join(tmp(), "todos.json");
    const t = new Todos(file);
    t.add("Call the printer about the box run.");
    t.add("buy oat milk");
    expect(t.open().map((x) => x.text)).toEqual([
      "Call the printer about the box run",
      "buy oat milk",
    ]);
    expect(t.done("the oat milk")?.text).toBe("buy oat milk");
    expect(t.done("something else entirely")).toBeNull();
    expect(new Todos(file).open().length).toBe(1);
    expect(t.line()).toMatch(/^To-do \(1\): Call the printer/);
  });

  it("hears the list asks", () => {
    expect(todoAsk("add buy milk to my list")).toEqual({ op: "add", text: "buy milk" });
    expect(todoAsk("Kik, put call mum on my to-do list")).toEqual({ op: "add", text: "call mum" });
    expect(todoAsk("what's on my list?")?.op).toBe("list");
    expect(todoAsk("cross off the milk")).toEqual({ op: "done", text: "the milk" });
    expect(todoAsk("I'm done with the invoice.")).toEqual({ op: "done", text: "the invoice" });
    expect(todoAsk("what's the weather")).toBeNull();
  });
});

describe("GitHub", () => {
  it("reads review requests and the CI of the user's own pull requests", async () => {
    const run = async (args: string[]) => {
      if (args.includes("--review-requested=@me"))
        return JSON.stringify([
          { repository: { nameWithOwner: "a/b" }, title: "Fix x", number: 3, url: "u3" },
        ]);
      if (args.includes("--author=@me"))
        return JSON.stringify([
          { repository: { nameWithOwner: "me/kikoe" }, title: "Desk", number: 9, url: "u9" },
        ]);
      return JSON.stringify({
        statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }],
      });
    };
    const g = new GitHubWatch(run);
    const r = await g.refresh();
    expect(r?.state.reviews[0]).toMatchObject({ repo: "a/b", number: 3 });
    expect(r?.state.mine[0]?.checks).toBe("fail");
    expect(g.line()).toBe(
      "GitHub: 1 pull request waiting on your review; CI is red on me/kikoe#9.",
    );
  });

  it("says what changed: a new request, CI going red and green", () => {
    const a = {
      at: 0,
      reviews: [],
      mine: [{ repo: "r", number: 1, title: "T", url: "u", checks: "pass" as const }],
    };
    const b = {
      at: 1,
      reviews: [{ repo: "r", number: 2, title: "N", url: "n" }],
      mine: [{ repo: "r", number: 1, title: "T", url: "u", checks: "fail" as const }],
    };
    expect(githubChanges(a, b)).toEqual(["New review request: N, in r.", "CI went red on T."]);
    expect(githubChanges(b, a)).toEqual(["CI is green again on T."]);
  });

  it("reads a check rollup", () => {
    expect(checkState([])).toBe("none");
    expect(checkState([{ conclusion: "SUCCESS" }])).toBe("pass");
    expect(checkState([{ status: "IN_PROGRESS" }])).toBe("pending");
  });

  it("gives nothing when gh is missing or signed out", async () => {
    const g = new GitHubWatch(async () => {
      throw new Error("gh: not found");
    });
    expect(await g.refresh()).toBeNull();
    expect(g.line()).toBe("");
  });
});

describe("Inbox", () => {
  it("keeps one copy of each message and says what is new", () => {
    const file = path.join(tmp(), "inbox.json");
    const box = new Inbox(file);
    const now = Date.now();
    const m = (id: string, source: "slack" | "mail", at = now) => ({
      id,
      source,
      from: "Sam",
      text: "hi",
      at,
    });
    expect(box.add([m("1", "slack"), m("2", "slack"), m("3", "mail")]).length).toBe(3);
    expect(box.add([m("1", "slack")]).length).toBe(0);
    expect(box.summary()).toBe("3 new: 2 from Slack, 1 from Mail.");
    expect(box.read()).toMatch(/^Slack, from Sam: hi/);
    box.seen();
    expect(box.summary()).toBe("Nothing new in the inbox.");
    expect(new Inbox(file).list().length).toBe(3);
  });
});

describe("the sources", () => {
  it("reads Slack messages sent to the user", async () => {
    const got = await readSlack(
      "xoxp-test",
      json({
        ok: true,
        messages: { matches: [{ ts: "1700000000.1", text: "ping", username: "ana", iid: "x" }] },
      }),
    );
    expect(got).toEqual([
      { id: "slack:x", source: "slack", from: "ana", text: "ping", at: 1700000000100 },
    ]);
    expect(await readSlack("", json({}))).toEqual([]);
  });

  it("reads Telegram updates once each", async () => {
    const urls: string[] = [];
    const fetchImpl: Fetch = async (url) => {
      urls.push(url);
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: [
            {
              update_id: 41,
              message: {
                message_id: 7,
                date: 1700000000,
                text: "hey",
                from: { first_name: "Mo" },
                chat: { id: 5 },
              },
            },
          ],
        }),
      };
    };
    const t = new TelegramSource(() => "123:abc", fetchImpl);
    expect((await t.read())[0]).toMatchObject({ id: "telegram:5:7", from: "Mo", text: "hey" });
    await t.read();
    expect(urls[1]).toContain("offset=42");
  });

  it("parses the desk's mail lines and drops the rest", () => {
    const text = [
      "Here you go:",
      '{"id":"m1","from":"Ana <ana@x.com>","subject":"Lunch?","snippet":"Friday at 1","at":"2026-10-13T09:00:00Z"}',
      "{not json}",
      '{"from":"no subject"}',
    ].join("\n");
    expect(parseMailLines(text)).toEqual([
      {
        id: "mail:m1",
        source: "mail",
        from: "Ana",
        text: "Lunch?: Friday at 1",
        at: Date.parse("2026-10-13T09:00:00Z"),
      },
    ]);
  });
});

describe("health", () => {
  it("says only what the ring read", () => {
    expect(healthLine(null)).toBe("");
    expect(
      healthLine({
        source: "oura",
        date: "",
        sleepScore: 82,
        sleepMinutes: 430,
        hrv: null,
        restingHr: null,
        steps: 1200,
        recovery: null,
      }),
    ).toBe("The ring: sleep score 82, 7h 10m asleep, 1200 steps so far.");
  });
});
