import { events as ev, scrub, spokenIdentifier, summarizeTestOutput } from "@kikoe/core";
import { describe, expect, it } from "vitest";

describe("events", () => {
  it("derives severity, repo and session when the adapter gives nothing", () => {
    const e = ev.make({ kind: ev.PERMISSION, source: "claude_code", cwd: "/repo/storefront" });
    expect(e.severity).toBe(ev.SEV_ATTENTION);
    expect(e.repo).toBe("storefront");
    expect(e.session).toBe("claude_code:storefront");
    expect(e.id).toHaveLength(12);
    expect(e.ts).toBeGreaterThan(0);
  });

  it("rejects an unknown kind", () => {
    expect(() => ev.make({ kind: "banana" as ev.Kind })).toThrow(/unknown event kind/);
  });

  it("round-trips through JSON and drops the schema field", () => {
    const e = ev.make({ kind: ev.TURN_END, text: "Done.", cwd: "C:\\repos\\api" });
    const back = ev.fromJSON(ev.toJSON(e));
    expect(back).toEqual(e);
    expect(back.repo).toBe("api");
  });

  it("uses the injected clock", () => {
    const e = ev.make({ kind: ev.IDLE }, () => 1234.5);
    expect(e.ts).toBe(1234.5);
  });
});

describe("the register helpers", () => {
  it("says identifiers the way a person would", () => {
    expect(spokenIdentifier("getUserById")).toBe("get user by id");
    expect(spokenIdentifier("lock.acquire()")).toBe("lock acquire");
    expect(spokenIdentifier("`token_refresh`")).toBe("token refresh");
    expect(spokenIdentifier("src/auth/token_refresh.ts")).toBe("token refresh");
    expect(spokenIdentifier("API")).toBe("API");
  });

  it("strips fences, paths and markdown, keeps the sentence", () => {
    const out = scrub(
      "Fixed it in `src/auth/token_refresh.ts`:\n\n```ts\nconst x = 1;\n```\n\n- done",
    );
    expect(out).not.toMatch(/`|\/|```/);
    expect(out.toLowerCase()).toContain("token refresh");
  });

  it("never reads a red run as green", () => {
    expect(summarizeTestOutput("Tests: 18 passed, 2 failed, 20 total")).toBe("18 passed, 2 failed");
    expect(summarizeTestOutput("3 failed, 41 passed")).toBe("41 passed, 3 failed");
    expect(summarizeTestOutput("41 passed, 0 failed")).toBe("all 41 passed");
    expect(summarizeTestOutput("nothing here")).toBe("");
  });
});
