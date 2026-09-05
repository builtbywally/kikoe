import { Arbiter, type SpeechSink, type Utterance, events as ev, utterance } from "@kikoe/core";
import { describe, expect, it } from "vitest";

/** A sink whose lines take a controllable amount of fake time. */
class SlowSink implements SpeechSink {
  spoken: string[] = [];
  cancelled: string[] = [];
  release: (() => void) | null = null;
  async speak(text: string, signal: AbortSignal): Promise<void> {
    this.spoken.push(text);
    await new Promise<void>((resolve, reject) => {
      this.release = resolve;
      signal.addEventListener("abort", () => {
        this.cancelled.push(text);
        reject(new Error("cancelled"));
      });
    });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function line(text: string, extra: Partial<Utterance> = {}): Utterance {
  return utterance(text, { session: "s1", label: "api", ...extra });
}

describe("arbiter", () => {
  it("speaks higher severity first", async () => {
    const sink = new SlowSink();
    const a = new Arbiter(sink, { labelSessions: false });
    a.submit(line("first progress", { priority: ev.SEV_PROGRESS }));
    await tick();
    a.submit(line("a milestone", { priority: ev.SEV_MILESTONE }));
    a.submit(line("an alert", { priority: ev.SEV_ATTENTION, preempt: false }));
    sink.release?.();
    await tick();
    sink.release?.();
    await tick();
    sink.release?.();
    await tick();
    expect(sink.spoken).toEqual(["first progress", "an alert", "a milestone"]);
  });

  it("an attention line cuts off lower-priority speech and flushes chatter", async () => {
    const sink = new SlowSink();
    const a = new Arbiter(sink, { labelSessions: false });
    a.submit(line("long progress", { priority: ev.SEV_PROGRESS }));
    await tick();
    a.submit(line("more chatter", { priority: ev.SEV_MILESTONE }));
    a.submit(line("It wants to push. Shall I?", { priority: ev.SEV_ATTENTION, preempt: true }));
    await tick();
    expect(sink.cancelled).toEqual(["long progress"]);
    sink.release?.();
    await tick();
    expect(sink.spoken).toContain("It wants to push. Shall I?");
    expect(sink.spoken).not.toContain("more chatter");
    expect(a.dropped).toBeGreaterThanOrEqual(1);
  });

  it("drops stale progress instead of speaking it late", async () => {
    let t = 1000;
    const sink = new SlowSink();
    const a = new Arbiter(sink, { now: () => t, labelSessions: false });
    a.submit(line("hold the mouth", { priority: ev.SEV_MILESTONE }));
    await tick();
    a.submit(line("old news", { priority: ev.SEV_PROGRESS, ttl: 5, created: t }));
    t += 60;
    sink.release?.();
    await tick();
    expect(sink.spoken).toEqual(["hold the mouth"]);
    expect(a.dropped).toBe(1);
  });

  it("names the repo when the talking session changes", async () => {
    const sink = new SlowSink();
    const a = new Arbiter(sink);
    a.submit(line("Done.", { session: "a", label: "api" }));
    a.submit(line("Tests pass.", { session: "b", label: "storefront" }));
    await tick();
    sink.release?.();
    await tick();
    sink.release?.();
    await tick();
    expect(sink.spoken[1]).toBe("In storefront, tests pass.");
  });

  it("a permission prompt always says whose it is", async () => {
    const sink = new SlowSink();
    const a = new Arbiter(sink, { labelSessions: false });
    a.submit(
      line("It wants to push. Shall I?", {
        priority: ev.SEV_ATTENTION,
        dedupe: "perm:p1",
        eventId: "p1",
      }),
    );
    await tick();
    expect(sink.spoken[0]).toBe("In api, it wants to push. Shall I?");
  });

  it("holds a second permission question until the first is answered", async () => {
    const sink = new SlowSink();
    let open: string | null = null;
    const a = new Arbiter(sink, {
      labelSessions: false,
      permissions: {
        blocks: (id) => open !== null && open !== id,
        bind: (id) => {
          open = id;
        },
      },
    });
    a.submit(line("first?", { priority: ev.SEV_ATTENTION, dedupe: "perm:p1", eventId: "p1" }));
    a.submit(line("second?", { priority: ev.SEV_ATTENTION, dedupe: "perm:p2", eventId: "p2" }));
    await tick();
    sink.release?.();
    await tick();
    expect(sink.spoken).toEqual(["In api, first?"]);
    expect(a.pending()).toBe(true); // second is held, not dropped
    open = null; // answered
    a.submit(line("nudge", { priority: ev.SEV_PROGRESS }));
    await tick();
    expect(sink.spoken).toContain("In api, second?");
  });

  it("chatter spends a session budget but a crash never does", async () => {
    const t = 0;
    const sink = new SlowSink();
    const a = new Arbiter(sink, { now: () => t, labelSessions: false });
    for (let i = 0; i < 6; i++) a.submit(line(`milestone ${i}`, { priority: ev.SEV_MILESTONE }));
    a.submit(line("It hit an error.", { priority: ev.SEV_CRITICAL, preempt: false }));
    for (let i = 0; i < 8; i++) {
      await tick();
      sink.release?.();
    }
    await tick();
    expect(sink.spoken).toContain("It hit an error.");
    expect(sink.spoken.filter((s) => s.startsWith("milestone")).length).toBeLessThanOrEqual(4);
    expect(a.dropped).toBeGreaterThan(0);
  });

  it("interrupt throws the queue away and stops the mouth", async () => {
    const sink = new SlowSink();
    const phases: string[] = [];
    const a = new Arbiter(sink, { labelSessions: false, onSpeech: (p) => phases.push(p) });
    a.submit(line("one"));
    a.submit(line("two"));
    await tick();
    a.interrupt();
    await tick();
    expect(sink.cancelled).toEqual(["one"]);
    expect(sink.spoken).toEqual(["one"]);
    expect(phases).toContain("interrupted");
    expect(a.pending()).toBe(false);
  });
});
