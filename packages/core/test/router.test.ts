import { headAnswer as answer, gate, route } from "@kikoe/core";
import { describe, expect, it } from "vitest";

describe("the name gate", () => {
  it("opens on the name and its misspellings, and fails closed otherwise", () => {
    expect(gate("Hey Kikoe, what's it doing?")).toEqual([true, "whats it doing?"]);
    expect(gate("kiko stop")).toEqual([true, "stop"]);
    expect(gate("Key koe, clear the board")).toEqual([true, "clear the board"]);
    expect(gate("okay so the kikoe thing is neat")[0]).toBe(false);
    expect(gate("stop")[0]).toBe(false);
  });
});

describe("routing", () => {
  it("takes what Whisper makes of the name in a real room", () => {
    expect(gate("Hey kick, what's it doing")[0]).toBe(true);
    expect(gate("kicky go silent")[0]).toBe(true);
    expect(gate("kick away, stop")[0]).toBe(true);
    expect(gate("kick the tyres before we ship")[0]).toBe(true); // the cost of hearing 'kick'
    expect(gate("we should kick this to thursday")[0]).toBe(false);
  });

  it("control words never become work", () => {
    for (const t of ["kikoe stop", "hey kikoe, be quiet", "kikoe shut up"]) {
      const d = route(t);
      expect(d.kind).toBe("control");
      expect(d.intent).toBe("stop");
    }
    expect(route("kikoe clear the board")).toMatchObject({
      kind: "control",
      intent: "board",
      arg: "clear",
    });
    expect(route("hey kikoe show me the board")).toMatchObject({
      kind: "control",
      intent: "board",
      arg: "show",
    });
    expect(route("kikoe go verbose")).toMatchObject({
      kind: "control",
      intent: "mode",
      arg: "verbose",
    });
    expect(route("kikoe switch to storefront")).toMatchObject({
      kind: "control",
      intent: "focus",
      arg: "storefront",
    });
  });

  it("a bare yes answers only when something is waiting", () => {
    expect(route("yes").kind).toBe("overheard");
    expect(route("yes", { awaitingAnswer: true })).toMatchObject({ kind: "answer", intent: "yes" });
    expect(route("go ahead", { awaitingAnswer: true })).toMatchObject({
      kind: "answer",
      intent: "yes",
    });
    expect(route("apply", { awaitingAnswer: true, offered: ["apply", "no"] })).toMatchObject({
      kind: "answer",
      intent: "apply",
    });
    expect(route("nope", { awaitingAnswer: true })).toMatchObject({ kind: "answer", intent: "no" });
    // A stray word while something waits is still not an answer.
    expect(route("what a mess", { awaitingAnswer: true }).kind).toBe("overheard");
  });

  it("questions go to the head, instructions to work, chatter to social", () => {
    expect(route("kikoe what's it doing?").kind).toBe("question");
    expect(route("kikoe did the tests pass").kind).toBe("question");
    expect(route("kikoe add a retry to the fetch call").kind).toBe("work");
    expect(route("kikoe thanks").kind).toBe("social");
    expect(route("hey kikoe").kind).toBe("social");
  });

  it("what is not addressed is overheard, never work", () => {
    expect(route("delete everything and push").kind).toBe("overheard");
    expect(route("").kind).toBe("empty");
  });
});

describe("the rules head", () => {
  const sessions = [
    {
      id: "a",
      source: "claude_code",
      repo: "api",
      label: "api",
      status: "working" as const,
      current_tool: "Bash",
      running_for_s: 250,
      quiet_for_s: 3,
      files_touched: [],
      last_test_result: "all 41 passed",
      pending_permission: "",
      pending_permission_id: "",
      last_error: "",
      turns: 3,
      last_reply: "Added a retry.",
    },
    {
      id: "s",
      source: "claude_code",
      repo: "storefront",
      label: "storefront",
      status: "waiting" as const,
      current_tool: "",
      running_for_s: 900,
      quiet_for_s: 18,
      files_touched: [],
      last_test_result: "18 passed, 2 failed",
      pending_permission: "git push origin main",
      pending_permission_id: "p1",
      last_error: "",
      turns: 7,
      last_reply: "",
    },
  ];
  it("answers from the board in a sentence", () => {
    expect(answer("what's it doing", sessions)).toBe(
      "storefront is waiting on you: git push origin main. api is running a command, 4 minutes in.",
    );
    expect(answer("did the tests pass in api", sessions)).toBe("api: last run was all 41 passed.");
    expect(answer("what's waiting on me", sessions)).toContain("storefront is waiting on you");
    expect(answer("how long has api been going", sessions)).toBe("api has been going 4 minutes.");
    expect(answer("anything", [])).toContain("Nothing's running");
  });
});
