import { describe, expect, it } from "vitest";
import { Supervisor, crashSource } from "../src/supervisor.js";

describe("whose crash it was", () => {
  const at = (frames: string[]) => {
    const e = new Error("boom");
    e.stack = ["Error: boom", ...frames.map((f) => `    at x (${f}:1:1)`)].join("\n");
    return e;
  };
  it("names the daemon when its code threw, from source or installed", () => {
    expect(crashSource(at(["C:\\k\\packages\\daemon\\dist\\daemon.js"]))).toBe("daemon");
    expect(
      crashSource(
        at(["C:\\P\\kikoe\\resources\\app\\node_modules\\@kikoe\\core\\dist\\arbiter.js"]),
      ),
    ).toBe("daemon");
  });
  it("names the app when its own code threw", () => {
    expect(crashSource(at(["node:internal/x", "C:\\k\\packages\\app\\dist\\main.js"]))).toBe("app");
  });
  it("blames the daemon when it cannot tell, since restarting it is the safe answer", () => {
    expect(crashSource("a string")).toBe("daemon");
  });
});

/** A supervisor on a hand-turned clock, with every start and every line recorded. */
function rig() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const said: string[] = [];
  let starts = 0;
  const s = new Supervisor({
    name: "mic",
    start: () => {
      starts++;
    },
    say: (l) => said.push(l),
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  /** move the clock on, firing whatever falls due */
  const pass = (ms: number) => {
    now += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (t.at > now) continue;
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  return { s, said, pass, starts: () => starts, pending: () => timers.length };
}

describe("keeping the ear up", () => {
  it("starts it again after a crash, backing off, and says so once", async () => {
    const { s, said, pass, starts } = rig();
    await s.want();
    expect(starts()).toBe(1);
    s.exited(1);
    expect(said).toEqual(["I lost the mic. Back in a second."]);
    pass(999);
    expect(starts()).toBe(1);
    pass(1);
    expect(starts()).toBe(2);
    // the second failure waits twice as long, and says nothing new
    s.exited(1);
    pass(1999);
    expect(starts()).toBe(2);
    pass(1);
    expect(starts()).toBe(3);
    expect(said).toHaveLength(1);
  });

  it("says it cannot get it back after three, and that it is back when it is", async () => {
    const { s, said, pass } = rig();
    await s.want();
    for (const wait of [1000, 2000, 4000]) {
      s.exited(1);
      pass(wait);
    }
    expect(said[1]).toMatch(/can't get the mic back/);
    s.ready();
    expect(said[2]).toBe("The mic is back.");
    // and a clean start afterwards is silent
    s.ready();
    expect(said).toHaveLength(3);
  });

  it("keeps trying every 30 s for as long as it is wanted", async () => {
    const { s, pass, starts } = rig();
    await s.want();
    for (let i = 0; i < 10; i++) {
      s.exited(1);
      pass(30_000);
    }
    expect(starts()).toBe(11);
  });

  it("starts the backoff over after a run that lasted", async () => {
    const { s, pass, starts } = rig();
    await s.want();
    s.exited(1);
    pass(1000);
    s.exited(1);
    pass(2000);
    // up for two minutes, then a crash: back to the one-second wait
    pass(120_000);
    s.exited(1);
    pass(1000);
    expect(starts()).toBe(4);
  });

  it("is not a crash when it was turned off, and nothing restarts it", async () => {
    const { s, said, pass, starts, pending } = rig();
    await s.want();
    s.release();
    s.exited(0);
    pass(60_000);
    expect(starts()).toBe(1);
    expect(said).toHaveLength(0);
    expect(pending()).toBe(0);
  });

  it("treats a start that throws as a failure, not as silence", async () => {
    let n = 0;
    const said: string[] = [];
    const s = new Supervisor({
      name: "mic",
      start: () => {
        n++;
        if (n === 1) throw new Error("no device");
      },
      say: (l) => said.push(l),
      setTimer: (fn) => {
        fn();
        return 0;
      },
      clearTimer: () => {},
    });
    await s.want();
    expect(n).toBe(2);
    expect(said[0]).toMatch(/lost the mic/);
  });
});
