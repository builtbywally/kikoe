import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-tailnet-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let t: typeof import("../src/tailnet.js");
let dmod: typeof import("../src/daemon.js");
let cfg: typeof import("../src/config.js");
beforeAll(async () => {
  t = await import("../src/tailnet.js");
  dmod = await import("../src/daemon.js");
  cfg = await import("../src/config.js");
});

const STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "wm.tail1234.ts.net.", TailscaleIPs: ["100.64.1.2", "fd7a::1"] },
  CertDomains: ["wm.tail1234.ts.net"],
});

/** A fake tailscale CLI: answers status, records every serve call. */
function fakeCli(opts: { serving?: boolean; https?: boolean; refuse?: string } = {}) {
  const calls: string[][] = [];
  let serving = opts.serving ?? false;
  const exec: import("../src/tailnet.js").Run = async (_bin, args) => {
    calls.push(args);
    if (args[0] === "status")
      return {
        code: 0,
        out:
          opts.https === false
            ? STATUS.replace(/"CertDomains":\[[^\]]*\]/, '"CertDomains":null')
            : STATUS,
      };
    if (args[0] === "serve" && args[1] === "status")
      return {
        code: 0,
        out: serving
          ? '{"Web":{"x":{"Handlers":{"/":{"Proxy":"https+insecure://127.0.0.1:4571"}}}}}'
          : "{}",
      };
    if (args[0] === "serve") {
      if (opts.refuse) return { code: 1, out: opts.refuse };
      serving = !args.includes("off");
      return { code: 0, out: "" };
    }
    return { code: 1, out: "" };
  };
  return { exec, calls };
}

describe("reading the tailnet", () => {
  it("finds the machine's name, address and whether HTTPS is on", async () => {
    const { exec } = fakeCli();
    const s = await t.tailnetStatus(4571, exec, "tailscale");
    expect(s).toMatchObject({
      running: true,
      dns: "wm.tail1234.ts.net",
      ip: "100.64.1.2",
      https: true,
      serving: false,
    });
  });

  it("says HTTPS is off when the tailnet has no certificate domains", async () => {
    const { exec } = fakeCli({ https: false });
    expect((await t.tailnetStatus(4571, exec, "tailscale")).https).toBe(false);
  });

  it("is nothing at all without the CLI", async () => {
    const { exec, calls } = fakeCli();
    expect(await t.tailnetStatus(4571, exec, "")).toEqual(t.NO_TAILNET);
    expect(calls).toHaveLength(0);
  });

  it("serves the walkie itself, never another port, and takes it down by the same door", async () => {
    const { exec, calls } = fakeCli();
    expect((await t.setServe(true, 4571, exec, "tailscale")).ok).toBe(true);
    expect(calls.at(-1)).toEqual([
      "serve",
      "--bg",
      "--https=443",
      "https+insecure://127.0.0.1:4571",
    ]);
    expect((await t.setServe(false, 4571, exec, "tailscale")).ok).toBe(true);
    expect(calls.at(-1)).toEqual(["serve", "--https=443", "off"]);
  });

  it("hands over the approval link when Serve was never enabled for the tailnet", async () => {
    const { exec } = fakeCli({
      refuse: [
        "Serve is not enabled on your tailnet.",
        "To enable, visit:",
        "",
        "         https://login.tailscale.com/f/serve?node=abc123",
        "",
      ].join("\n"),
    });
    const r = await t.setServe(true, 4571, exec, "tailscale");
    expect(r.ok).toBe(false);
    expect(r.said).toContain("https://login.tailscale.com/f/serve?node=abc123");
  });

  it("tells the user what to switch on when the tailnet refuses", async () => {
    const { exec } = fakeCli({ refuse: "error: HTTPS is not enabled for this tailnet" });
    const r = await t.setServe(true, 4571, exec, "tailscale");
    expect(r.ok).toBe(false);
    expect(r.said).toMatch(/admin\/dns/);
  });
});

describe("the walkie on the tailnet", () => {
  function daemon(serving = false, walkieTailscale = true) {
    const { exec, calls } = fakeCli({ serving });
    const d = new dmod.Daemon({
      settings: {
        ...cfg.DEFAULTS,
        tts: "none",
        port: 0,
        walkie: true,
        walkie_tailscale: walkieTailscale,
      },
      audio: false,
      persistBoard: false,
      tailnetImpl: {
        status: (port) => t.tailnetStatus(port, exec, "tailscale"),
        serve: (on, port) => t.setServe(on, port, exec, "tailscale"),
      },
    });
    return { d, calls };
  }
  const served = (calls: string[][]) => calls.filter((c) => c[0] === "serve" && c[1] !== "status");

  it("puts the rule up while the walkie is on, and gives the no-warning link", async () => {
    const { d, calls } = daemon();
    // a walkie that is "on" without binding a real port
    (d as unknown as { walkie: object }).walkie = { urls: () => [], stop: async () => {} };
    await d.syncTailnet();
    expect(served(calls)).toHaveLength(1);
    const url = (d.state() as { walkie: { tailnet: { url: string } } }).walkie.tailnet.url;
    expect(url.startsWith("https://wm.tail1234.ts.net/?t=")).toBe(true);
    await d.close();
  });

  it("takes the rule down with the walkie, as off closes the socket", async () => {
    const { d, calls } = daemon(true);
    await d.syncTailnet(); // the walkie is not running
    expect(served(calls).at(-1)).toEqual(["serve", "--https=443", "off"]);
    await d.close();
  });

  it("leaves the tailnet alone when it was never asked", async () => {
    const { d, calls } = daemon(false, false);
    (d as unknown as { walkie: object }).walkie = { urls: () => [], stop: async () => {} };
    await d.syncTailnet();
    expect(served(calls)).toHaveLength(0);
    await d.close();
  });
});
