import { describe, expect, it } from "vitest";
import { Board, DEFAULT_TTL_S, MAX_PINS, type PinEvent } from "../src/pins.js";

function board(now: () => number) {
  const events: PinEvent[] = [];
  const b = new Board((e) => events.push(e), now);
  return { b, events };
}

describe("the board", () => {
  it("pins, fades, and evicts the oldest of the busiest repo", () => {
    let t = 1000;
    const { b, events } = board(() => t);
    const p = b.add({ kind: "diff", title: "token refresh", body: "+a\n-b", repo: "api" });
    expect(p.ttl_s).toBe(DEFAULT_TTL_S);
    expect(events[0]?.op).toBe("add");
    t += DEFAULT_TTL_S + 1;
    expect(b.list()).toEqual([]);
    expect(events.at(-1)?.op).toBe("remove");

    for (let i = 0; i < MAX_PINS + 3; i++) b.add({ body: `n${i}`, repo: i % 2 ? "api" : "web" });
    expect(b.list().length).toBe(MAX_PINS);
    expect(b.list().some((x) => x.body === "n0")).toBe(false);
  });

  it("holds an asked pin open until an answer, and a bare yes answers it", async () => {
    const { b } = board(() => 1);
    const p = b.add({ body: "diff", ask: ["apply", "no"] });
    const waited = b.wait(p.id, 5);
    expect(b.asking()?.id).toBe(p.id);
    expect(b.answerCurrent("yes")).toBe(true);
    expect(await waited).toBe("apply");
    expect(b.asking()).toBeUndefined();
    expect(b.get(p.id)?.answer).toBe("apply");
  });

  it("refuses an answer that was not offered, and denies on timeout", async () => {
    const { b } = board(() => 1);
    const p = b.add({ body: "x", ask: ["apply", "no"] });
    expect(b.answer(p.id, "maybe")).toBe(false);
    const waited = b.wait(p.id, 0.05);
    expect(await waited).toBe("");
  });

  it("clear empties everything and releases any held ask", async () => {
    const { b, events } = board(() => 1);
    const p = b.add({ body: "x", ask: ["ok"] });
    const waited = b.wait(p.id, 5);
    expect(b.clear()).toBe(1);
    expect(await waited).toBe("");
    expect(events.at(-1)?.op).toBe("clear");
  });

  it("caps the body and the ask list, and coerces an unknown kind to text", () => {
    const { b } = board(() => 1);
    const p = b.add({ kind: "video", body: "y".repeat(300_000), ask: ["a", "b", "c", "d", "e"] });
    expect(p.kind).toBe("text");
    expect(p.body.length).toBe(200_000);
    expect(p.ask.length).toBe(4);
  });
});
