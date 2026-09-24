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

import https from "node:https";

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
export type Action = "kik" | "think" | "agent" | "new_session" | "open" | "canvas" | "stop_agent";
/** What can be opened on the PC. A fixed list: Jev picks, it never names a program. */
export type Opener = "vscode" | "explorer" | "terminal" | "browser" | "website" | "app";

/**
 * The app a sentence names: "open notepad", "switch to chrome", "launch
 * visual studio code". The words after the verb, up to where the sentence
 * says where or what next. "" when there is none.
 */
export function appName(text: string): string {
  const m =
    /\b(?:open|launch|start|run|pull up|bring up|switch to|go to|show me)\s+(?:the |my |up )*(.+)$/i.exec(
      text,
    );
  if (!m?.[1]) return "";
  const cut = m[1]
    .replace(/[.?!,].*$/, "")
    .replace(/\s+\b(on|in|at|for|and|then|so|please|now|here|with|to)\b.*$/i, "")
    .replace(/\b(app|application|program|window)\b/gi, "")
    .trim();
  return cut.split(/\s+/).slice(0, 4).join(" ");
}

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
  /** the app the sentence names, for `open: app` */
  app: string;
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

/** Words that are about where or how to show something, not what to look for. */
const NOT_A_QUERY = new Set(
  "put some me on the canvas board here youtube please play for a an and to in of it up now i want you open look search find".split(
    " ",
  ),
);

/**
 * What to look for, when a sentence asks for something to be looked up:
 * "open YouTube on the canvas and look up lofi, put some chill beats" is
 * "lofi chill beats". The words after the first look-up verb, less the ones
 * about the canvas; "" when nothing is being looked for.
 */
export function searchQuery(text: string): string {
  // "pull up YouTube and open lo-fi": after the site, "and open" is a look-up
  const m =
    /\b(?:look(?:ing)? up|search(?:ing)? for|search|find|play|put on|listen to|and open|then open)\s+(.+)$/i.exec(
      text,
    );
  if (!m?.[1]) return "";
  const words = m[1]
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    // "search for kikoe on github" is looking for kikoe, not "kikoe github"
    .filter((w) => w && !NOT_A_QUERY.has(w) && !(w in SITES));
  return words.slice(0, 8).join(" ");
}

/** A YouTube video id in an address, or "". */
export function youtubeId(url: string): string {
  const m =
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i.exec(
      url,
    );
  return m?.[1] ?? "";
}

/** Is this address YouTube at all? */
export function isYoutube(url: string): boolean {
  return /(^|\.|\/\/)(youtube\.com|youtu\.be)(\/|$)/i.test(url);
}

/**
 * The player for a video, which unlike youtube.com itself may be shown inside
 * another page — so it plays on the phone too, where a browser honours
 * YouTube's refusal to be framed.
 */
export function youtubeEmbed(id: string): string {
  return `https://www.youtube.com/embed/${id}?autoplay=1&rel=0`;
}

/**
 * Words after "open" that are never a site's name. The nouns matter as much
 * as the filler: "pull up a picture from unsplash" once opened picture.com,
 * because "picture" was the first word after the verb.
 */
const NOT_A_SITE = new Set(
  "a an the my it this that these those up canvas board here browser terminal folder editor vs code new session claude agent project localhost me something some one picture pictures photo photos image images pic pics video videos page site website web wallpaper chrome firefox edge safari brave computer pc desktop laptop screen monitor machine".split(
    " ",
  ),
);

/**
 * Sites people ask for by name, and how each searches (`%s` is the query).
 * A name on this list wins wherever it is in the sentence, so "a picture
 * from unsplash" is Unsplash and not the first noun after the verb.
 */
const SITES: Record<string, string> = {
  unsplash: "https://unsplash.com/s/photos/%s",
  pexels: "https://www.pexels.com/search/%s/",
  pinterest: "https://www.pinterest.com/search/pins/?q=%s",
  dribbble: "https://dribbble.com/search/%s",
  behance: "https://www.behance.net/search/projects?search=%s",
  google: "https://www.google.com/search?q=%s",
  wikipedia: "https://en.wikipedia.org/w/index.php?search=%s",
  github: "https://github.com/search?q=%s",
  reddit: "https://www.reddit.com/search/?q=%s",
  amazon: "https://www.amazon.com/s?k=%s",
  // on the canvas this becomes the player (showOnCanvas); on the PC, results
  youtube: "https://www.youtube.com/results?search_query=%s",
  figma: "",
  twitter: "",
  instagram: "",
  spotify: "",
  netflix: "",
};

/**
 * A site said by name: "open YouTube here" means youtube.com. Nobody says the
 * ".com", and asking "which address?" back was the answer three times running
 * on the phone. Used only when Jev has already decided a website is what was
 * asked for. In order: a site this file knows, anywhere in the sentence; the
 * word after "from", "on" or "at"; the first word after the verb that is
 * neither filler nor a noun like "picture".
 */
export function siteByName(text: string, exclude: string[] = []): string {
  const skip = new Set([...NOT_A_SITE, ...exclude.map((e) => e.toLowerCase())]);
  const word = (raw: string) => raw.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const known = text
    .split(/\s+/)
    .map(word)
    .find((w) => w in SITES && !skip.has(w));
  if (known) return `https://www.${known}.com`;
  const where = /\b(?:from|on|at)\s+([a-z0-9][\w-]*)/gi;
  for (const m of text.matchAll(where)) {
    const w = word(m[1] ?? "");
    if (w.length >= 4 && !skip.has(w) && !COMMON.has(w)) return `https://www.${w}.com`;
  }
  // Nothing more is guessed. "Open <word>" used to become <word>.com, and the
  // log has low-fi.com, file.com and picture.com to show for it (2026-09-24);
  // a sentence that names no site is searched instead (`searchFor`).
  return "";
}

/** Words after "on" or "at" that are places, not sites: "on the tv", "at the top". */
const COMMON = new Set(
  "the my your this that tv top bottom left right side front back phone laptop desk wall table home work".split(
    " ",
  ),
);

/**
 * What to search for when a sentence names no site: the words after the
 * verb, less those about where to show it. "Open lo-fi on the canvas" is
 * "lo-fi". "" when there is nothing but the verb.
 */
export function searchFor(text: string): string {
  const m =
    /\b(?:open|show( me)?|go to|bring up|pull up|load|put|launch|browse|find|look up|search( for)?)\s+(.+)$/i.exec(
      text,
    );
  if (!m?.[3]) return "";
  const words = m[3]
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !NOT_A_QUERY.has(w) && !NOT_A_SITE.has(w));
  return words.slice(0, 8).join(" ");
}

/**
 * Does the sentence say where: on the computer itself? "Pull up Chrome on my
 * computer and go to YouTube" was turned into a canvas card from the phone,
 * because a phone's "open" used to mean the canvas whatever was said.
 */
export function wantsThePc(text: string): boolean {
  return /\b(?:on|to|in)\s+(?:my|the)\s+(?:computer|pc|desktop|laptop|machine|monitor|screen|browser)\b|\b(?:chrome|firefox|edge|safari|brave)\b|\bdesktop\b/i.test(
    text,
  );
}

/**
 * What a picture is of: "give me a picture of a cupcake" is "cupcake". The
 * last such phrase wins, since the subject tends to come after the site.
 */
export function pictureOf(text: string): string {
  const re =
    /\b(?:pictures?|photos?|photographs?|images?|pics?|wallpapers?|shots?)\s+of\s+(?:(?:a|an|some|the)\s+)?([^.,!?]+)/gi;
  let subject = "";
  for (const m of text.matchAll(re)) {
    const words = (m[1] ?? "")
      .toLowerCase()
      .replace(/\b(from|on|in|into|onto)\b.*$/, "")
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !NOT_A_QUERY.has(w) && !(w in SITES));
    if (words.length) subject = words.slice(0, 6).join(" ");
  }
  return subject;
}

/**
 * A named site plus something to find becomes that site's search:
 * "a picture of a cupcake from unsplash" opens Unsplash's cupcake page, not
 * its front door. Anything else is returned as it was.
 */
export function siteSearch(named: string, text: string): string {
  // A picture asked for with no site named comes from Unsplash.
  const url = !named && pictureOf(text) ? "https://www.unsplash.com" : named;
  const name = /^https?:\/\/(?:www\.)?([a-z0-9-]+)\.com\/?$/i.exec(url)?.[1]?.toLowerCase() ?? "";
  const template = SITES[name];
  if (!template) return url;
  const q = searchQuery(text) || pictureOf(text);
  if (!q) return url;
  const pathy = !template.includes("?");
  return template.replace("%s", encodeURIComponent(pathy ? q.replace(/\s+/g, "-") : q));
}

export interface JevOptions {
  key: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  timeoutMs?: number;
}

/**
 * One connection to TypeSafe, kept open. Measured 2026-09-24: a request on a
 * fresh connection is ~760 ms and on an open one ~280 ms, and the server
 * keeps an idle connection for at least two minutes. `fetch` lets its own go
 * after about four seconds, and nobody speaks twice in four seconds, so
 * almost every sentence paid the handshake. This agent keeps it.
 */
const AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 4 });

/** POST over the kept connection; one retry when a reused socket turns out closed. */
function post(
  body: string,
  key: string,
  timeoutMs: number,
  retry = true,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let got = false;
    const req = https.request(
      JEV_URL,
      {
        method: "POST",
        agent: AGENT,
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        got = true;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("jev: timed out")));
    req.on("error", (e: NodeJS.ErrnoException) => {
      // The server closed a connection we thought was open: once more, on a new one.
      if (!got && retry && (e.code === "ECONNRESET" || e.code === "EPIPE"))
        post(body, key, timeoutMs, false).then(resolve, reject);
      else reject(e);
    });
    req.end(body);
  });
}

export class Jev {
  private readonly fetchImpl: typeof fetch | null;
  private readonly log: (line: string) => void;
  /** when the connection was last used; a warm-up is skipped if it is surely open */
  private lastUsed = 0;
  constructor(private readonly opts: JevOptions) {
    this.fetchImpl = opts.fetchImpl ?? null;
    this.log = opts.log ?? (() => {});
  }

  /** One request: every question over the same state, answered together. */
  async ask(state: unknown, questions: Record<string, unknown>): Promise<Record<string, Answer>> {
    const body = JSON.stringify({ model: "jev-latest", state, questions });
    const timeout = this.opts.timeoutMs ?? JEV_TIMEOUT_MS;
    let status: number;
    let text: string;
    if (this.fetchImpl) {
      const r = await this.fetchImpl(JEV_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.key}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeout),
      });
      status = r.status;
      text = await r.text();
    } else {
      ({ status, text } = await post(body, this.opts.key, timeout));
    }
    this.lastUsed = Date.now();
    if (status < 200 || status >= 300) throw new Error(`jev ${status}`);
    const j = JSON.parse(text) as { answers?: Record<string, Answer> };
    if (!j.answers) throw new Error("jev: no answers");
    return j.answers;
  }

  /**
   * Open the connection before it is needed: called when the user starts
   * speaking, so the handshake happens while they talk and Whisper listens,
   * not after. A no-op if the connection was used in the last minute.
   */
  warm(): void {
    if (Date.now() - this.lastUsed < 60_000) return;
    this.lastUsed = Date.now();
    this.ask("hello", { q: { type: "noul", instructions: "Is this a greeting?" } }).catch(() => {
      this.lastUsed = 0;
    });
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

  /**
   * Said while Kik was talking: is it an interruption — a question, a
   * correction, "stop", something new for Kik — rather than agreeing,
   * thinking aloud, or talking to someone else? The probability, or null if
   * Jev could not be asked.
   */
  async interrupting(kikSaying: string, text: string): Promise<number | null> {
    try {
      const a = await this.ask(
        { kik_is_saying: kikSaying.slice(0, 400), user_said: text },
        {
          interrupting: {
            type: "noul",
            instructions:
              "Kik, a voice assistant, was in the middle of saying `kik_is_saying` when the user said `user_said` (transcribed by speech recognition). Is the user interrupting Kik — cutting in with a question, a correction, an instruction, or telling it to stop — rather than agreeing, murmuring, thinking aloud, or talking to someone else in the room?",
          },
        },
      );
      const n = a.interrupting;
      return n?.type === "noul" ? n.noul : null;
    } catch (e) {
      this.log(`jev: interrupting failed: ${(e as Error).message}`);
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
          kik: "Kik answers or does it itself: the status of agents, whether tests passed, notes to remember, usage limits, opinions, small talk; and anything made to be shown on the canvas or the board — a page, an animation, a drawing, a diagram, a chart, a checklist, a mockup, a design — and clearing or arranging the canvas",
          think:
            "the user asks Kik to think something through: weigh options, reason about a decision, a design or architecture question, a trade-off, a plan — a question to answer with thought, not work to do",
          agent:
            "the coding agent should do it in a project's code: change files in the repo, fix a bug, refactor, add a feature to the app, run or check something in the repo, or answer what the agent itself was told earlier. Not something to show on the canvas",
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
          app: "an application on this computer by its name — Notepad, Spotify, Word, Excel, Calculator, Settings, Discord, Photoshop — or switching to one already open",
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
      // an app is not a website: "open spotify" as an app must not become spotify.com
      url: open?.choice === "app" ? findUrl(text) : findUrl(text) || siteByName(text, projects),
      app: appName(text),
    };
  }
}
