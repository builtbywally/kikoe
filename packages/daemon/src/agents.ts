/**
 * Starting a coding agent, so the first move of the day is not a terminal.
 *
 * Kikoe has always been able to *steer* an agent — an instruction rides back
 * on the Stop hook and becomes the user's next message. But it could only
 * ever talk to a session that was already running, which meant every day
 * began outside the room, and once a terminal is open the pull to keep using
 * it is strong. This closes that.
 *
 * It is deliberately not a wrapper. Claude Code is started headless with
 * `-p`, its hooks are already installed, and everything it then does comes
 * back the way it always has: narration, the tracker, work cards on the
 * canvas. There is no terminal to inject into and nothing is parsed from its
 * output — "no PTY wrapper, ever; hooks in, hooks out" holds.
 *
 * Two rules worth keeping:
 *
 *  - **Permissions are never skipped.** Answering them by voice is the
 *    product; an agent that cannot ask is not faster, it is unsupervised.
 *  - **The session id is ours, chosen before anything runs.** `--session-id`
 *    opens a conversation the first time and `--resume` continues it after,
 *    so there is nothing to match afterwards and nothing to parse from the
 *    output. It also means "a session is already there when you open Kikoe"
 *    costs an id and no process: `-p` starts and exits every turn.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOGS } from "./config.js";

/** Where a Claude Code install tends to be, when it is not on the PATH. */
function candidates(): string[] {
  const home = os.homedir();
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  return [
    path.join(home, ".local", "bin", "claude.exe"),
    path.join(home, ".local", "bin", "claude"),
    path.join(appData, "npm", "claude.cmd"),
    path.join(appData, "npm", "claude"),
    path.join(local, "Programs", "claude", "claude.exe"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
}

/**
 * The Claude Code binary, or nothing.
 *
 * Worth being careful about: on Windows an npm-installed `claude` is a
 * `.cmd` shim, which `spawn` refuses without a shell, and the failure looks
 * exactly like Kikoe ignoring the request. So the path is resolved up front
 * and the Doctor can say which one was found.
 */
export function findClaude(configured = "", pathEnv = process.env.PATH ?? ""): string {
  if (configured && existsSync(configured)) return configured;
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, `claude${ext}`);
      try {
        if (existsSync(p)) return p;
      } catch {
        /* an unreadable PATH entry is not our problem */
      }
    }
  }
  for (const p of candidates()) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* keep looking */
    }
  }
  return "";
}

export interface Run {
  id: string;
  project: string;
  cwd: string;
  prompt: string;
  started: number;
  /** the conversation this turn belongs to; chosen by us, not discovered */
  session: string;
  pid: number;
  child: ChildProcess;
}

export interface AgentsOptions {
  /** an explicit path to the binary; empty means look for it */
  bin?: string;
  log?: (line: string) => void;
}

let counter = 0;

export class Agents {
  private runs = new Map<string, Run>();
  private readonly log: (line: string) => void;
  constructor(private opts: AgentsOptions = {}) {
    this.log = opts.log ?? (() => {});
  }

  /** Where Claude Code is, or "" if it could not be found. */
  bin(): string {
    return findClaude(this.opts.bin ?? "");
  }

  get running(): Run[] {
    return [...this.runs.values()];
  }

  /**
   * Start a session in a folder with something to do.
   *
   * Returns a line to say. The work itself appears the usual way: the hooks
   * fire, the tracker sees a session, and the canvas fills with what it does.
   */
  start(
    project: string,
    cwd: string,
    prompt: string,
    session: string,
    fresh: boolean,
  ): { ok: boolean; said: string } {
    const bin = this.bin();
    if (!bin) {
      return {
        ok: false,
        said: "I can't find Claude Code on this machine; set its path in Settings",
      };
    }
    if (!cwd || !existsSync(cwd)) {
      return { ok: false, said: `I don't know where ${project} is on disk` };
    }
    const already = this.running.find((r) => r.project === project);
    if (already) {
      return { ok: false, said: `${project} already has an agent running` };
    }

    counter = (counter + 1) % 0xffff;
    const id = `r${Date.now().toString(36)}${counter.toString(36)}`;
    let out: ReturnType<typeof createWriteStream> | null = null;
    try {
      mkdirSync(path.join(LOGS, "agents"), { recursive: true });
      out = createWriteStream(path.join(LOGS, "agents", `${project}-${id}.log`), { flags: "a" });
    } catch {
      /* a missing log is not a reason not to start */
    }

    // Never --dangerously-skip-permissions: being asked, and answering by
    // voice, is the whole point.
    //
    // The session id is ours, chosen before anything runs, so there is
    // nothing to match afterwards: --session-id opens it the first time and
    // --resume continues it every time after. That is what makes yesterday's
    // conversation still be there this morning.
    const args = session
      ? fresh
        ? ["-p", "--session-id", session, prompt]
        : ["-p", "--resume", session, prompt]
      : ["-p", prompt];
    const child = spawn(bin, args, {
      cwd,
      windowsHide: true,
      // A .cmd shim needs a shell; a real executable does not want one.
      shell: /\.(cmd|bat)$/i.test(bin),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d: Buffer) => out?.write(d));
    child.stderr?.on("data", (d: Buffer) => out?.write(d));
    child.on("error", (e) => {
      this.log(`agent ${project}: could not start: ${e.message}`);
      this.runs.delete(id);
      out?.end();
    });
    child.on("exit", (code) => {
      this.log(`agent ${project}: finished (${code})`);
      this.runs.delete(id);
      out?.end();
    });

    this.runs.set(id, {
      id,
      project,
      cwd,
      prompt,
      started: Date.now(),
      session,
      pid: child.pid ?? 0,
      child,
    });
    this.log(
      `agent ${project}: ${fresh ? "started" : "continued"} ${session.slice(0, 8)} in ${cwd} (pid ${child.pid})`,
    );
    return { ok: true, said: fresh ? `started an agent in ${project}` : `passed it to ${project}` };
  }

  /** Stop one run, or every run. Returns how many were stopped. */
  stop(project?: string): number {
    let n = 0;
    for (const r of this.running) {
      if (project && r.project !== project) continue;
      try {
        r.child.kill();
        n++;
      } catch {
        /* it was already gone */
      }
    }
    return n;
  }
}
