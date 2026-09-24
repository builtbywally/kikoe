import { describe, expect, it } from "vitest";
import { type Context, decide } from "../lib/router";

const ctx: Context = { jev: true, busy: true, permission: false };

describe("the site's switchboard", () => {
  it("takes the name as certain and answers as Kik", () => {
    const d = decide("Kik, what's it doing?", ctx);
    expect(d.named).toBe(true);
    expect(d.addr).toBe(1);
    expect(d.dest).toBe("kik");
  });

  it("answers a waiting permission with a bare yes, and only then", () => {
    expect(decide("Yes", { ...ctx, permission: true }).reflex).toBe("allow");
    expect(decide("no.", { ...ctx, permission: true }).reflex).toBe("deny");
    expect(decide("Yes", ctx).reflex).toBeNull();
  });

  it("stops before any model sees the sentence", () => {
    const d = decide("Stop", ctx);
    expect(d.dest).toBe("reflex");
    expect(d.reflex).toBe("quiet");
  });

  it("drops what was not for Kik and keeps only the word count", () => {
    const d = decide("Yeah mum, down in five", ctx, 0.04);
    expect(d.dest).toBe("drop");
    expect(d.words).toBe(5);
  });

  it("cuts the job from your own words for a new session, with the project", () => {
    const d = decide(
      "Open a new Claude session in storefront and tell it to do one, two, three, four",
      ctx,
    );
    expect(d.dest).toBe("new_session");
    expect(d.job).toBe("do one, two, three, four");
    expect(d.project).toBe("storefront");
  });

  it("hands an instruction to the agent", () => {
    const d = decide("Tell it to add a retry to the token refresh", ctx);
    expect(d.dest).toBe("agent");
    expect(d.job).toBe("add a retry to the token refresh");
  });

  it("puts a site asked for 'here' on the canvas and an editor on the PC", () => {
    expect(decide("Open YouTube here", ctx)).toMatchObject({ dest: "canvas", open: "web card" });
    expect(decide("Open marine in VS Code", ctx)).toMatchObject({ dest: "open", open: "editor" });
  });

  it("with no Jev key, lets the rules decide and gives no confidence", () => {
    const off = { ...ctx, jev: false };
    expect(decide("and did it work?", off).dest).toBe("drop");
    expect(decide("Tell it to run the tests", off).conf).toBeNull();
  });
});
