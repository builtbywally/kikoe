/**
 * Projects: a name, some folders, and a board of its own.
 *
 * The Room shows one project at a time. "Kik, open Marine" swaps the whole
 * board; everything else keeps running behind it. This is the shape the user
 * asked for on 2026-09-05 — *"a project is a name, a set of repos, a voice, a
 * board"* — and the reason it is not a settings screen is that there are
 * thirteen folders under `~/orca/projects` and nobody is going to register
 * them by hand. A project appears the first time a hook arrives from it.
 *
 * Resolving a spoken name is the interesting part. The ear turns "Marine"
 * into "marina", "murray", "the marine" and worse, so matching is by shape
 * rather than by string: exact, then alias, then prefix, then the closest
 * name within one edit. A wrong guess costs one "I don't know that one";
 * refusing a right one costs trust, so this leans towards answering.
 */

export interface Project {
  /** a slug: lower case, no spaces */
  id: string;
  /** what it is called out loud */
  name: string;
  /** what the ear makes of the name, learned or configured */
  aliases: string[];
  /** absolute folder paths that belong to it */
  roots: string[];
  created: number;
  /** when it was last looked at */
  opened: number;
  /**
   * The one conversation this project has with its agent.
   *
   * Not a process — `claude -p --resume` starts and exits per turn, so the
   * session is a file on disk and an id we chose. That is what makes "a
   * session is already there when you open Kikoe" free: there is nothing to
   * keep running, only something to remember.
   */
  session: string;
}

/** A v4 UUID, which is the only shape `--session-id` accepts. */
export function newSessionId(): string {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface ProjectsFile {
  current: string;
  projects: Project[];
}

export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** A folder path, normalised for comparison. */
function norm(p: string): string {
  return p
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

/** Is `child` inside `root`, or the same place? */
function within(child: string, root: string): boolean {
  const c = norm(child);
  const r = norm(root);
  return c === r || c.startsWith(`${r}/`);
}

/** Levenshtein, capped: we only ever care whether it is 0, 1 or more. */
export function editDistance(a: string, b: string, cap = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length]!;
}

/** Words that ride along with a project name and mean nothing. */
const FILLER = /^(the|my|project|repo|repository|folder|board)$/;

function bare(spoken: string): string {
  return spoken
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && !FILLER.test(w))
    .join(" ")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim();
}

export class Projects {
  private items = new Map<string, Project>();
  private currentId = "";

  constructor(private now: () => number = () => Date.now() / 1000) {}

  get current(): Project {
    const p = this.items.get(this.currentId);
    if (p) return p;
    // Never return nothing: a board always belongs to something.
    return this.ensure("kik", "");
  }

  all(): Project[] {
    return [...this.items.values()].sort((a, b) => b.opened - a.opened);
  }

  get(id: string): Project | undefined {
    return this.items.get(id);
  }

  /**
   * The project a working directory belongs to, made if it is new.
   * The longest matching root wins, so a repo inside a registered folder
   * stays with that folder rather than starting a project of its own.
   */
  of(cwd: string, fallbackName = ""): Project {
    if (cwd) {
      let best: Project | undefined;
      let bestLen = -1;
      for (const p of this.items.values()) {
        for (const r of p.roots) {
          if (within(cwd, r) && r.length > bestLen) {
            best = p;
            bestLen = r.length;
          }
        }
      }
      if (best) return best;
    }
    const name = fallbackName || basename(cwd) || "kik";
    return this.ensure(name, cwd);
  }

  /** Make a project if it does not exist; add the root if it is new. */
  ensure(name: string, root: string): Project {
    const id = slug(name) || "kik";
    let p = this.items.get(id);
    if (!p) {
      p = { id, name, aliases: [], roots: [], created: this.now(), opened: 0, session: "" };
      this.items.set(id, p);
    }
    if (root && !p.roots.some((r) => norm(r) === norm(root))) p.roots.push(root);
    if (!this.currentId) this.currentId = id;
    return p;
  }

  /**
   * A folder the scan found (scan.ts), made a project unless it already
   * belongs to one. Returns the new project, or undefined if it was known.
   *
   * Names collide across a whole disk — two `walnut_print`s, a Dolmapp in
   * two places — and `ensure` would quietly fold the second into the first
   * as an extra root. So a name already taken by a folder somewhere else
   * becomes "<parent> <name>"; the folder a lone repo sits in ("Printly v3"
   * around `walnut_print`) is its name, and the repo's own is an alias.
   */
  adopt(dir: string, name: string, wrapper = ""): Project | undefined {
    for (const p of this.items.values()) if (p.roots.some((r) => within(dir, r))) return undefined;
    const free = (n: string) => {
      const p = this.items.get(slug(n));
      return !!slug(n) && (!p || p.roots.length === 0);
    };
    const parent = basename(dir.slice(0, dir.length - basename(dir).length));
    const tries = wrapper ? [wrapper, name, `${wrapper} ${name}`] : [name, `${parent} ${name}`];
    const pick = tries.find(free);
    if (!pick) return undefined;
    const current = this.currentId;
    const p = this.ensure(pick, dir);
    // a scan should never change what the Room is looking at
    this.currentId = current || this.currentId;
    if (pick !== name) this.learn(p.id, name.replace(/[_-]+/g, " "));
    return p;
  }

  /**
   * A spoken name to a project. Exact, then alias, then prefix, then within
   * one edit — because the ear will not spell it the way the folder does.
   */
  resolve(spoken: string): Project | undefined {
    const said = bare(spoken);
    if (!said) return undefined;
    const asSlug = slug(said);
    const list = this.all();

    const exact = list.find((p) => p.id === asSlug || bare(p.name) === said);
    if (exact) return exact;

    const alias = list.find((p) => p.aliases.some((a) => bare(a) === said || slug(a) === asSlug));
    if (alias) return alias;

    const prefix = list.find((p) => p.id.startsWith(asSlug) || asSlug.startsWith(p.id));
    if (prefix && asSlug.length >= 3) return prefix;

    let near: Project | undefined;
    let bestD = 2;
    for (const p of list) {
      const d = editDistance(asSlug, p.id);
      if (d < bestD) {
        bestD = d;
        near = p;
      }
    }
    return near;
  }

  /** Look at a project. Returns it, so the caller can say its name. */
  open(id: string): Project | undefined {
    const p = this.items.get(id);
    if (!p) return undefined;
    this.currentId = p.id;
    p.opened = this.now();
    return p;
  }

  /**
   * The id of this project's conversation, made the first time it is needed.
   *
   * Kept for good: the point of it is that tomorrow's first sentence lands
   * in the same conversation as today's last one.
   */
  sessionFor(id: string): string {
    const p = this.items.get(id);
    if (!p) return "";
    if (!p.session) p.session = newSessionId();
    return p.session;
  }

  /** Start this project's conversation over. */
  forget(id: string): void {
    const p = this.items.get(id);
    if (p) p.session = "";
  }

  /** Teach it what the ear called this project, so next time is direct. */
  learn(id: string, heard: string): void {
    const p = this.items.get(id);
    const a = bare(heard);
    if (!p || !a || p.aliases.length >= 8) return;
    if (bare(p.name) === a || p.aliases.some((x) => bare(x) === a)) return;
    p.aliases.push(a);
  }

  toJSON(): ProjectsFile {
    return { current: this.currentId, projects: this.all() };
  }

  load(raw: unknown): number {
    const f = (raw ?? {}) as Partial<ProjectsFile>;
    if (!Array.isArray(f.projects)) return 0;
    let n = 0;
    for (const item of f.projects) {
      if (!item || typeof item !== "object") continue;
      const p = item as Partial<Project>;
      const id = typeof p.id === "string" ? slug(p.id) : "";
      if (!id || this.items.has(id)) continue;
      this.items.set(id, {
        id,
        name: String(p.name ?? id),
        aliases: Array.isArray(p.aliases) ? p.aliases.map(String).slice(0, 8) : [],
        roots: Array.isArray(p.roots) ? p.roots.map(String).slice(0, 12) : [],
        created: Number(p.created ?? this.now()) || this.now(),
        opened: Number(p.opened ?? 0) || 0,
        session: typeof p.session === "string" ? p.session : "",
      });
      n++;
    }
    const c = typeof f.current === "string" ? slug(f.current) : "";
    if (c && this.items.has(c)) this.currentId = c;
    else if (!this.currentId) this.currentId = this.all()[0]?.id ?? "";
    return n;
  }
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}
