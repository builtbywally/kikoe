/**
 * "Kik, run Marine": look at a project, start it, and hand back its address.
 *
 * The server is Kikoe's own child, not the agent's. `claude -p` ends its
 * turn and exits, and a dev server it started goes with it or is orphaned
 * where nothing can stop it; a process Kikoe holds can be stopped by voice
 * ("stop Marine") and is stopped when Kikoe quits.
 *
 * How to run it is read from the folder first — package.json's scripts and
 * the lockfile, Django's manage.py, a bare index.html — because that is
 * instant and right for most of the user's projects. When the folder does
 * not say, the daemon asks the project's agent (daemon.ts, `runProject`),
 * and whatever command comes back is run here the same way.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";

export interface Recipe {
  /** the shell command, run from the project folder */
  command: string;
  /** run first when the dependencies are not there yet */
  install?: string;
  /** what it is, to say out loud: "a Next.js app" */
  what: string;
  /** a known address, when the command does not print one (a static server) */
  url?: string;
}

const RUN =
  /\b(?:run|start|launch|boot|spin\s+up|fire\s+up|serve)\s+(?:up\s+)?(?:(?:the|my|a|an|this|that)\s+)?(?:project\s+(?:called\s+|named\s+)?)?(.+?)(?:\s+project)?(?=\s+(?:and|then|so|for|with|in|on|at|please|now|locally|again|up)\b|[.!?,]|$)/i;
/** What follows "run" or "start" without being a project. */
const NOT_A_PROJECT =
  /^(?:it|this|that|them|agent|agents|an agent|session|a session|new session|a new session|test|tests|the tests|build|script|command|timer|a timer|reminder|over|again|working|thinking|planning|recording|music|video|playing)$/i;

/**
 * The project in "run Marine", "start the Billiar app", "I need you to run
 * a project marine and open it in a frame", or null. The daemon still has
 * to find it among the projects before it counts.
 */
export function runAsk(text: string): string | null {
  const m = RUN.exec(text);
  const name = m?.[1]?.trim() ?? "";
  if (!name || NOT_A_PROJECT.test(name) || name.split(/\s+/).length > 4) return null;
  return name;
}

/** The frameworks worth naming, in the order they are looked for. */
const FRAMEWORKS: Array<[string, string]> = [
  ["next", "a Next.js app"],
  ["nuxt", "a Nuxt app"],
  ["@remix-run/dev", "a Remix app"],
  ["astro", "an Astro site"],
  ["@sveltejs/kit", "a SvelteKit app"],
  ["expo", "an Expo app"],
  ["electron", "an Electron app"],
  ["vite", "a Vite app"],
  ["react-scripts", "a React app"],
  ["@angular/core", "an Angular app"],
  ["remotion", "a Remotion project"],
  ["express", "an Express server"],
];

function manager(dir: string): "pnpm" | "yarn" | "bun" | "npm" {
  if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(dir, "bun.lockb")) || existsSync(path.join(dir, "bun.lock")))
    return "bun";
  return "npm";
}

/**
 * How this folder runs, from what is in it, or null when it does not say.
 * A free port is passed in for the one case that needs it (a static folder).
 */
export function howToRun(dir: string, freePort = 0): Recipe | null {
  const pkgFile = path.join(dir, "package.json");
  if (existsSync(pkgFile)) {
    let pkg: {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    } = {};
    try {
      pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    } catch {
      return null;
    }
    const scripts = pkg.scripts ?? {};
    const script = ["dev", "start", "serve", "preview"].find((s) => scripts[s]);
    if (!script) return null;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const what = FRAMEWORKS.find(([d]) => d in deps)?.[1] ?? "a Node project";
    const pm = manager(dir);
    const command = pm === "npm" ? `npm run ${script}` : `${pm} ${script}`;
    const installed = existsSync(path.join(dir, "node_modules"));
    return installed ? { command, what } : { command, what, install: `${pm} install` };
  }
  if (existsSync(path.join(dir, "manage.py"))) {
    return { command: "python manage.py runserver", what: "a Django app" };
  }
  if (existsSync(path.join(dir, "index.html")) && freePort) {
    return {
      command: `python -m http.server ${freePort} --bind 127.0.0.1`,
      what: "a static site",
      url: `http://localhost:${freePort}/`,
    };
  }
  return null;
}

/**
 * The repo's other working trees, most recently touched first. Orca keeps a
 * project's work in worktrees under `~/orca/workspaces`, and the main
 * checkout can be an empty `master` (Marine's is): the app is on a branch
 * next door.
 */
export function worktreesOf(dir: string): Array<{ dir: string; branch: string }> {
  const r = spawnSync("git", ["-C", dir, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (r.status !== 0 || !r.stdout) return [];
  const out: Array<{ dir: string; branch: string; at: number }> = [];
  for (const block of r.stdout.split(/\r?\n\r?\n/)) {
    const wt = /^worktree (.+)$/m.exec(block)?.[1]?.trim();
    if (!wt || path.resolve(wt).toLowerCase() === path.resolve(dir).toLowerCase()) continue;
    if (!existsSync(wt)) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim() ?? "";
    let at = 0;
    try {
      at = statSync(wt).mtimeMs;
    } catch {
      /* unreadable: last */
    }
    out.push({ dir: path.resolve(wt), branch, at });
  }
  return out.sort((a, b) => b.at - a.at).map(({ dir: d, branch }) => ({ dir: d, branch }));
}

/** The agent's answer to "how does this run?": a RUN: line, maybe an INSTALL: line. */
export function recipeFromAgent(text: string): Recipe | null {
  const run = /^\s*RUN:\s*(.+?)\s*$/im.exec(text)?.[1];
  if (!run || /^none$/i.test(run)) return null;
  const install = /^\s*INSTALL:\s*(.+?)\s*$/im.exec(text)?.[1];
  const what = /^\s*WHAT:\s*(.+?)\s*$/im.exec(text)?.[1];
  const url = /^\s*URL:\s*(https?:\/\/\S+)\s*$/im.exec(text)?.[1];
  return {
    command: run.replace(/^`+|`+$/g, ""),
    what: what ?? "the project",
    ...(install && !/^none$/i.test(install) ? { install: install.replace(/^`+|`+$/g, "") } : {}),
    ...(url ? { url } : {}),
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes are control characters
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * The address a dev server printed, or "". Loopback is preferred over the
 * network address both Next and Vite also print, and 0.0.0.0 is made into
 * something a browser can open.
 */
export function addressIn(out: string): string {
  const text = out.replace(ANSI, "");
  const all = [
    ...text.matchAll(
      /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\d.]+):\d{2,5}[^\s'"<>)]*/g,
    ),
  ].map((m) => m[0].replace(/[.,;]+$/, ""));
  const local = all.find((u) => /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])/.test(u));
  return (local ?? all[0] ?? "").replace("0.0.0.0", "localhost").replace(/\[::1?\]/, "localhost");
}

/** A port nothing is listening on. */
export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
    s.on("error", () => resolve(0));
  });
}

export interface Running {
  project: string;
  dir: string;
  recipe: Recipe;
  url: string;
  started: number;
  child: ChildProcess;
  /** the last lines it printed, for "why did it not start" */
  tail: string[];
}

export interface RunEvents {
  /** what it is doing now, to say: "installing first" */
  onStep?: (line: string) => void;
  /** it printed an address */
  onUrl: (url: string) => void;
  /** it exited before it was up, or never printed an address */
  onFail: (why: string, tail: string[]) => void;
}

export class Runner {
  private runs = new Map<string, Running>();

  constructor(
    private log: (line: string) => void = () => {},
    /** how long to wait for an address once the server command is running */
    private waitMs = 120_000,
  ) {}

  get(project: string): Running | undefined {
    return this.runs.get(project);
  }

  list(): Running[] {
    return [...this.runs.values()];
  }

  /** Install if it needs it, then start the server and watch for its address. */
  start(project: string, dir: string, recipe: Recipe, ev: RunEvents): void {
    this.stop(project);
    const tail: string[] = [];
    const keep = (d: Buffer) => {
      for (const line of String(d).replace(ANSI, "").split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line.slice(0, 300));
        if (tail.length > 40) tail.shift();
      }
    };
    const shell = (command: string) =>
      spawn(command, {
        cwd: dir,
        shell: true,
        windowsHide: true,
        // its own group elsewhere, so the whole tree stops together
        detached: process.platform !== "win32",
        // a dev server that opens a browser tab on its own would put the app
        // on the desktop as well as the canvas
        env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0", CI: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });

    const serve = () => {
      const child = shell(recipe.command);
      const run: Running = { project, dir, recipe, url: "", started: Date.now(), child, tail };
      this.runs.set(project, run);
      this.log(`run ${project}: ${recipe.command} in ${dir} (pid ${child.pid})`);
      let out = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ev.onFail("it never said where it was listening", tail);
      }, this.waitMs);
      timer.unref?.();
      const seen = (d: Buffer) => {
        keep(d);
        if (settled) return;
        out = (out + String(d)).slice(-8000);
        const url = recipe.url ?? addressIn(out);
        if (url) {
          settled = true;
          clearTimeout(timer);
          run.url = url;
          this.log(`run ${project}: up at ${url}`);
          ev.onUrl(url);
        }
      };
      child.stdout?.on("data", seen);
      child.stderr?.on("data", seen);
      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.runs.delete(project);
        ev.onFail(e.message, tail);
      });
      child.on("exit", (code) => {
        this.log(`run ${project}: exited (${code})`);
        if (this.runs.get(project)?.child === child) this.runs.delete(project);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ev.onFail(`it stopped with code ${code}`, tail);
      });
      // a static server prints nothing useful; its address is known
      if (recipe.url) setTimeout(() => seen(Buffer.from("")), 800).unref?.();
    };

    if (!recipe.install) {
      serve();
      return;
    }
    ev.onStep?.(`installing first, with ${recipe.install}`);
    const inst = shell(recipe.install);
    inst.stdout?.on("data", keep);
    inst.stderr?.on("data", keep);
    inst.on("error", (e) => ev.onFail(`the install could not start: ${e.message}`, tail));
    inst.on("exit", (code) => {
      if (code === 0) serve();
      else ev.onFail(`the install failed with code ${code}`, tail);
    });
  }

  /** Stop one project's server, the whole tree. */
  stop(project: string): boolean {
    const r = this.runs.get(project);
    if (!r) return false;
    this.runs.delete(project);
    kill(r.child);
    this.log(`run ${project}: stopped`);
    return true;
  }

  stopAll(): number {
    const n = this.runs.size;
    for (const p of [...this.runs.keys()]) this.stop(p);
    return n;
  }
}

/** A shell's whole tree: `npm run dev` is a shell, npm, and node under it. */
function kill(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}
