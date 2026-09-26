/**
 * "Run Marine" and "plan mode": the words, how a folder runs, and a real
 * server started, found and stopped.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planAsk, planSteps, planVerdict } from "../src/plan.js";
import { Runner, addressIn, howToRun, recipeFromAgent, runAsk } from "../src/runner.js";

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kikoe-run-"));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), body);
  }
  return dir;
}

describe("runAsk", () => {
  it("finds the project in the ways it is asked for", () => {
    expect(runAsk("run Marine")).toBe("Marine");
    expect(runAsk("start the Billiar app")).toBe("Billiar app");
    expect(runAsk("run the marine project")).toBe("marine");
    expect(runAsk("I need you to run a project marine and open it in a frame in the canvas.")).toBe(
      "marine",
    );
    expect(runAsk("can you spin up walnut website please")).toBe("walnut website");
    expect(runAsk("fire up Kronos")).toBe("Kronos");
  });

  it("leaves work that only uses the word alone", () => {
    expect(runAsk("run the tests in Marine")).toBeNull();
    expect(runAsk("start an agent in Marine")).toBeNull();
    expect(runAsk("start a new session")).toBeNull();
    expect(runAsk("run it again")).toBeNull();
    expect(runAsk("what's on my calendar")).toBeNull();
  });
});

describe("howToRun", () => {
  it("reads a Node project's scripts, framework and package manager", () => {
    const dir = folder({
      "package.json": JSON.stringify({
        scripts: { build: "x", dev: "next dev" },
        dependencies: { next: "16" },
      }),
      "pnpm-lock.yaml": "",
      "node_modules/.keep": "",
    });
    expect(howToRun(dir)).toEqual({ command: "pnpm dev", what: "a Next.js app" });
  });

  it("installs first when the packages are not there", () => {
    const dir = folder({
      "package.json": JSON.stringify({
        scripts: { start: "vite" },
        devDependencies: { vite: "7" },
      }),
    });
    expect(howToRun(dir)).toEqual({
      command: "npm run start",
      what: "a Vite app",
      install: "npm install",
    });
  });

  it("does not install what has no dependencies", () => {
    const dir = folder({ "package.json": JSON.stringify({ scripts: { dev: "node server.js" } }) });
    expect(howToRun(dir)).toEqual({ command: "npm run dev", what: "a Node project" });
  });

  it("serves a bare page, and says nothing it does not know", () => {
    expect(howToRun(folder({ "index.html": "<h1>hi</h1>" }), 5555)?.url).toBe(
      "http://localhost:5555/",
    );
    expect(howToRun(folder({ "README.md": "hi" }), 5555)).toBeNull();
    expect(
      howToRun(folder({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) })),
    ).toBeNull();
  });
});

describe("recipeFromAgent", () => {
  it("reads the agent's lines", () => {
    const r = recipeFromAgent(
      "WHAT: a Flask app\nINSTALL: pip install -r requirements.txt\nRUN: `flask run`\nURL: none",
    );
    expect(r).toEqual({
      command: "flask run",
      what: "a Flask app",
      install: "pip install -r requirements.txt",
    });
    expect(recipeFromAgent("RUN: none")).toBeNull();
    expect(recipeFromAgent("I could not tell.")).toBeNull();
  });
});

describe("addressIn", () => {
  it("prefers loopback, and makes 0.0.0.0 openable", () => {
    expect(
      addressIn(
        "  - Local:        http://localhost:3000\n  - Network:      http://192.168.1.5:3000",
      ),
    ).toBe("http://localhost:3000");
    expect(
      addressIn(
        "\x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m",
      ),
    ).toBe("http://localhost:5173/");
    expect(addressIn("Running on http://0.0.0.0:8000/ (Press CTRL+C to quit)")).toBe(
      "http://localhost:8000/",
    );
    expect(addressIn("compiling...")).toBe("");
  });
});

describe("Runner", () => {
  it("starts a server, hears its address, and stops it", async () => {
    const dir = folder({
      "server.js":
        "const s=require('http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log('ready on http://localhost:'+s.address().port));",
    });
    const runner = new Runner();
    const url = await new Promise<string>((resolve, reject) => {
      runner.start(
        "demo",
        dir,
        { command: "node server.js", what: "a test" },
        { onUrl: resolve, onFail: reject },
      );
    });
    expect(url).toMatch(/^http:\/\/localhost:\d+$/);
    expect((await fetch(url)).status).toBe(200);
    expect(runner.stop("demo")).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    await expect(fetch(url)).rejects.toThrow();
  });

  it("streams what it prints, and says when it stops by itself after it was up", async () => {
    const dir = folder({
      "brief.js":
        "const s=require('http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>{console.log('compiling');console.log('ready on http://localhost:'+s.address().port);setTimeout(()=>process.exit(3),400)});",
    });
    const runner = new Runner();
    const seen: string[][] = [];
    const exited = await new Promise<number | null>((resolve, reject) => {
      runner.start(
        "brief",
        dir,
        { command: "node brief.js", what: "a test" },
        { onUrl: () => {}, onFail: reject, onLine: (t) => seen.push([...t]), onExit: resolve },
      );
    });
    expect(exited).toBe(3);
    expect(seen.flat().join("\n")).toMatch(/compiling/);
    expect(runner.get("brief")).toBeUndefined();
  });

  it("does not call a stop Kik asked for a stop on its own", async () => {
    const dir = folder({
      "server.js":
        "const s=require('http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log('http://localhost:'+s.address().port));",
    });
    const runner = new Runner();
    let exits = 0;
    await new Promise<void>((resolve, reject) => {
      runner.start(
        "mine",
        dir,
        { command: "node server.js", what: "a test" },
        {
          onUrl: () => resolve(),
          onFail: reject,
          onExit: () => exits++,
        },
      );
    });
    runner.stop("mine");
    await new Promise((r) => setTimeout(r, 500));
    expect(exits).toBe(0);
  });

  it("says why when it dies before it is up", async () => {
    const dir = folder({
      "bad.js": "console.error('Error: cannot find module next'); process.exit(1)",
    });
    const runner = new Runner();
    const [why, tail] = await new Promise<[string, string[]]>((resolve) => {
      runner.start(
        "bad",
        dir,
        { command: "node bad.js", what: "a test" },
        {
          onUrl: () => resolve(["up", []]),
          onFail: (w, t) => resolve([w, t]),
        },
      );
    });
    expect(why).toMatch(/code 1/);
    expect(tail.join("\n")).toMatch(/cannot find module/);
  });
});

describe("plan mode words", () => {
  it("finds the job with the plan words taken out", () => {
    expect(planAsk("plan mode, add dark mode to Marine")).toBe("add dark mode to Marine");
    expect(planAsk("Kik, in plan mode add a login page")).toBe("add a login page");
    expect(planAsk("make a plan for moving the site to Next 16")).toBe(
      "moving the site to Next 16",
    );
    expect(planAsk("add a footer, but plan it first")).toBe("add a footer, but");
    expect(planAsk("plan mode")).toBe("");
    expect(planAsk("add dark mode to Marine")).toBeNull();
  });

  it("reads the decision", () => {
    expect(planVerdict("go ahead")).toBe("go");
    expect(planVerdict("yes, do it")).toBe("go");
    expect(planVerdict("okay")).toBe("go");
    expect(planVerdict("drop it")).toBe("drop");
    expect(planVerdict("no")).toBe("drop");
    expect(planVerdict("change step two to use Tailwind")).toBe("change");
    expect(planVerdict("but don't touch the header")).toBe("change");
    expect(planVerdict("what's the weather")).toBeNull();
  });

  it("counts the steps", () => {
    expect(planSteps("Plan\n1. Read\n2. Write\n3) Test\nnotes")).toBe(3);
  });
});
