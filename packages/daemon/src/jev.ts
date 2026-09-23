/**
 * Jev: the switchboard between what the user says and what Kikoe does.
 *
 * Jev (TypeSafe's System One model) does not talk. It answers typed
 * questions — pick one of these, yes or no — with probabilities, in about
 * three hundred milliseconds, for a fraction of a cent per thousand
 * sentences. That is the right shape for the decisions Kikoe used to make
 * with regexes or with a whole Haiku call: was that said to me, is it for me
 * or for the agent, which project, which part of the sentence is the task.
 * (Whether the user is correcting Kik was tried and left to the regex: Jev
 * called "stop the agent" a correction and missed "no, I said storefront".)
 *
 * Two rules worth keeping:
 *
 *  - **Jev chooses; code acts.** Every action is a handler written here or
 *    in the daemon, and Jev only picks one and picks its arguments from
 *    candidates code has already found. It never writes a command, and the
 *    task an agent receives is the user's own words, cut, not paraphrased.
 *  - **It is never the floor.** No key, no network, a slow answer: the
 *    caller gets null and carries on the way it did before Jev existed.
 *
 * Measured 2026-09-23 on Kikoe's own cases (`~/orca/projects/laya-vs-jev`):
 * 10/10 on "was that said to Kik", 9/10 on Kik-or-agent, where a prompted
 * Haiku is the configuration the research calls the worst (docs/HEARING.md).
 */

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
/** A decision later than this is worse than the old path taken now. */
export const JEV_TIMEOUT_MS = 2500;

export interface Noul {
  type: "noul";
  noul: number;
}
export interface Choice {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
type Answer = Noul | Choice;

/** What to do with an addressed sentence. */
export type Action = "kik" | "agent" | "new_session" | "open" | "canvas" | "stop_agent";
/** What can be opened on the PC. A fixed list: Jev picks, it never names a program. */
export type Opener = "vscode" | "explorer" | "terminal" | "browser" | "website";

export interface Command {
  action: Action;
  /** how sure Jev was of the action, 0..1 */
  sure: number;
  /** a project name from the list given, or "" when none was named */
  project: string;
  projectSure: number;
  /** the part of the sentence that is the job, in the user's words */
  task: string;
  open: Opener;
  /** a web address found in the sentence, for `open: website` */
  url: string;
}

export interface CommandContext {
  /** project names, the current one first */
  projects: string[];
  current: string;
  /** a line on what is running now, or "" */
  running: string;
  /** the last exchange, or "" */
  last: string;
}

/**
 * The ways a sentence can hold its job. "open a new session in storefront
 * and tell it to add a retry" holds it after "tell it to"; "add a retry" is
 * all job. Jev picks one of these, so what reaches the agent is always a
 * piece of what was said.
 */
export function taskCandidates(text: string): string[] {
  const t = text.trim().replace(/[.?!]+$/, "");
  const out = [t];
  const cuts = [
    /\b(?:tell|ask|get|have|make)\s+(?:it|him|her|them|claude|the agent|claude code)\s+(?:to\s+)?/gi,
    /\b(?:and|then|and then)\s+/gi,
    /\b(?:to|that)\s+/gi,
    /[:,]\s*/g,
  ];
  for (const re of cuts) {
    for (const m of t.matchAll(re)) {
      const rest = t.slice((m.index ?? 0) + m[0].length).trim();
      if (rest.split(/\s+/).length >= 2 && !out.includes(rest)) out.push(rest);
    }
  }
  return out.slice(0, 12);
}

const CODE_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|md|json|css|html|yml|yaml|toml|sh|txt|lock|java|kt|swift|c|h|cpp)$/i;

/** A web address in what was said: "open github.com", "go to localhost 3000". */
export function findUrl(text: string): string {
  const local = /\blocalhost\s*(?::|port\s*)?\s*(\d{2,5})\b/i.exec(text);
  if (local) return `http://localhost:${local[1]}`;
  const m = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?)/i.exec(text);
  if (!m?.[1]) return "";
  // "the fetch in api.ts" names a file, not a site
  if (!/^https?:/i.test(m[1]) && CODE_FILE.test(m[1])) return "";
  // Whisper, hearing "youtube dot com" said twice over, wrote "youtube.com.com"
  const found = m[1].replace(/(\.[a-z]{2,})\1+(?=\/|$)/i, "$1");
  return /^https?:/i.test(found) ? found : `https://${found}`;
}

/** Words after "open" that are never a site's name. */
const NOT_A_SITE = new Set(
  "a an the my it this that these those up canvas board here browser terminal folder editor vs code new session claude agent project localhost me something".split(
    " ",
  ),
);

/**
 * A site said by name: "open YouTube here" means youtube.com. Nobody says the
 * ".com", and asking "which address?" back was the answer three times running
 * on the phone. The first word after the verb that is not filler, with .com —
 * used only when Jev has already decided a website is what was asked for.
 */
export function siteByName(text: string, exclude: string[] = []): string {
  const skip = new Set([...NOT_A_SITE, ...exclude.map((e) => e.toLowerCase())]);
  const m =
    /\b(?:open|show|go to|bring up|pull up|load|put|launch|browse)\s+((?:[a-z0-9][\w-]*\s*){1,4})/i.exec(
      text,
    );
  if (!m?.[1]) return "";
  for (const raw of m[1].trim().split(/\s+/)) {
    const w = raw.toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!w || skip.has(w) || /^(on|in|at|for|to)$/.test(w)) continue;
    return `https://www.${w}.com`;
  }
  return "";
}

export interface JevOptions {
  key: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  timeoutMs?: number;
}

export class Jev {
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  constructor(private readonly opts: JevOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? (() => {});
  }

  /** One request: every question over the same state, answered together. */
  async ask(state: unknown, questions: Record<string, unknown>): Promise<Record<string, Answer>> {
    const r = await this.fetchImpl(JEV_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state, questions }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? JEV_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`jev ${r.status}`);
    const j = (await r.json()) as { answers?: Record<string, Answer> };
    if (!j.answers) throw new Error("jev: no answers");
    return j.answers;
  }

  /**
   * Was a nameless sentence said to Kik? The probability, or null if Jev
   * could not be asked.
   */
  async directed(text: string, lastExchange: string): Promise<number | null> {
    try {
      const a = await this.ask(
        { last_exchange: lastExchange || "(none)", sentence: text },
        {
          directed: {
            type: "noul",
            instructions:
              "The user is alone at a desk with a headset; the `sentence` was transcribed by speech recognition and may have errors. Is the `sentence` a question or request directed at Kik, their voice assistant for coding agents, rather than said to another person, to themselves, or coming from a video?",
          },
        },
      );
      const n = a.directed;
      return n?.type === "noul" ? n.noul : null;
    } catch (e) {
      this.log(`jev: directed failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** What to do with an addressed sentence, or null if Jev could not be asked. */
  async command(text: string, ctx: CommandContext): Promise<Command | null> {
    const tasks = taskCandidates(text);
    const projects = [...new Set(ctx.projects.filter(Boolean))].slice(0, 200);
    const questions: Record<string, unknown> = {
      action: {
        type: "choice",
        instructions:
          "Kik is a voice assistant that sits beside Claude Code, the user's coding agent. What should happen with the user's `sentence`?",
        criteria: {
          kik: "Kik answers or does it itself: the status of agents, whether tests passed, the canvas and whiteboard, notes to remember, usage limits, opinions, small talk",
          agent:
            "the coding agent should do or answer it: anything about the code, files, commits, bugs, refactors, or what the agent itself was told earlier",
          new_session:
            "the user explicitly asks to open, start or spin up a new Claude or agent session, usually with a job for it",
          open: "the user asks to open an application, a folder, a terminal, or a website in the computer's own browser",
          canvas:
            "the user asks to show or open a website or web app on the canvas, the board, or 'here' in the Room where they are looking",
          stop_agent: "the user asks to stop, kill or cancel the running agent",
        },
      },
      task: {
        type: "choice",
        instructions:
          "Which option is exactly the job the user wants the coding agent to do, without the words about opening a session, choosing a project or talking to Kik?",
        criteria: Object.fromEntries(tasks.map((t, i) => [`t${i}`, t])),
      },
      open: {
        type: "choice",
        instructions: "If the user wants something opened on their computer, what?",
        criteria: {
          vscode: "the code editor, VS Code, or a project in the editor",
          explorer: "a folder in the file explorer",
          terminal: "a terminal or command prompt",
          browser: "a web browser, with nothing more specific",
          website: "a particular website or web address",
        },
      },
    };
    // The project is its own request, over the sentence alone: given the
    // current project and the last exchange as well, Jev names one the
    // sentence never mentioned. The two run side by side, so it costs no time.
    const none = {} as Record<string, Answer>;
    const named =
      projects.length > 1
        ? this.ask(
            { sentence: text },
            {
              project: {
                type: "choice",
                instructions:
                  "Which of the user's projects does the `sentence` name? Speech recognition may misspell the name. If no project name appears in the sentence, choose none.",
                criteria: {
                  none: "the sentence names no project",
                  ...Object.fromEntries(projects.map((p) => [p, `the project called ${p}`])),
                },
              },
            },
          ).catch(() => none)
        : Promise.resolve(none);
    let a: Record<string, Answer>;
    try {
      const [main, proj] = await Promise.all([
        this.ask(
          {
            sentence: text,
            last_exchange: ctx.last || "(none)",
            running: ctx.running || "nothing is running",
            current_project: ctx.current,
          },
          questions,
        ),
        named,
      ]);
      a = { ...main, ...proj };
    } catch (e) {
      this.log(`jev: command failed: ${(e as Error).message}`);
      return null;
    }
    const pick = (id: string): Choice | null => {
      const x = a[id];
      return x?.type === "choice" ? x : null;
    };
    const action = pick("action");
    if (!action) return null;
    const task = pick("task");
    const open = pick("open");
    const project = pick("project");
    const taskIdx = Number((task?.choice ?? "t0").slice(1));
    const projectName = project && project.choice !== "none" ? project.choice : "";
    return {
      action: action.choice as Action,
      sure: action.probabilities[action.choice] ?? 0,
      project: projectName,
      projectSure: project ? (project.probabilities[project.choice] ?? 0) : 0,
      task: tasks[taskIdx] ?? tasks[0] ?? text,
      open: (open?.choice ?? "browser") as Opener,
      url: findUrl(text) || siteByName(text, projects),
    };
  }
}
