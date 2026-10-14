/**
 * The IDE's files (the IDE plan, step 3): list, read, write, create, rename,
 * delete, find files and search their text, all inside the open project's
 * folder and nowhere else. A write carries the mtime the editor read, and is
 * refused when the file changed since (an agent wrote it), so neither side
 * silently loses the other's work.
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** folders that are never walked for quick open or search, and are shown last */
export const HEAVY = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "target",
]);
const MAX_READ = 4 * 1024 * 1024;

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
}

export class FsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export class Fsx {
  constructor(private readonly root: () => string | null) {}

  /** The project's folder, or an error: the default project has none. */
  base(): string {
    const r = this.root();
    if (!r || !existsSync(r)) throw new FsError("this project has no folder", 404);
    return path.resolve(r);
  }

  /** A path inside the folder, from one relative to it; anything outside is refused. */
  resolve(rel: string): string {
    const base = this.base();
    const full = path.resolve(base, String(rel || ".").replace(/^[/\\]+/, ""));
    const inside = path.relative(base, full);
    if (inside.startsWith("..") || path.isAbsolute(inside))
      throw new FsError("outside the project", 403);
    return full;
  }

  rel(full: string): string {
    return path.relative(this.base(), full).split(path.sep).join("/");
  }

  list(rel = ""): Entry[] {
    const dir = this.resolve(rel);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      throw new FsError("no such folder", 404);
    }
    const out: Entry[] = [];
    for (const name of names) {
      const full = path.join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      out.push({
        name,
        path: this.rel(full),
        dir: st.isDirectory(),
        size: st.isDirectory() ? 0 : st.size,
      });
    }
    // folders first, heavy ones last, then by name
    return out.sort(
      (a, b) =>
        Number(b.dir) - Number(a.dir) ||
        Number(HEAVY.has(a.name)) - Number(HEAVY.has(b.name)) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  }

  read(rel: string): { path: string; text: string; mtime: number; size: number } {
    const full = this.resolve(rel);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      throw new FsError("no such file", 404);
    }
    if (st.isDirectory()) throw new FsError("a folder, not a file");
    if (st.size > MAX_READ) throw new FsError("too large to open here (over 4 MB)", 413);
    const buf = readFileSync(full);
    if (buf.subarray(0, 8000).includes(0)) throw new FsError("a binary file", 415);
    return { path: this.rel(full), text: buf.toString("utf8"), mtime: st.mtimeMs, size: st.size };
  }

  /**
   * Write a file. With `mtime`, the write only lands if the file on disk is
   * still the one that was read; otherwise a 409 says who changed it.
   */
  write(rel: string, text: string, mtime?: number): { path: string; mtime: number } {
    const full = this.resolve(rel);
    if (mtime && existsSync(full)) {
      const now = statSync(full).mtimeMs;
      if (Math.abs(now - mtime) > 1) throw new FsError("changed on disk since it was opened", 409);
    }
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
    return { path: this.rel(full), mtime: statSync(full).mtimeMs };
  }

  create(rel: string, dir: boolean): { path: string } {
    const full = this.resolve(rel);
    if (existsSync(full)) throw new FsError("already exists", 409);
    if (dir) mkdirSync(full, { recursive: true });
    else {
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, "");
    }
    return { path: this.rel(full) };
  }

  rename(from: string, to: string): { path: string } {
    const a = this.resolve(from);
    const b = this.resolve(to);
    if (!existsSync(a)) throw new FsError("no such file", 404);
    if (existsSync(b)) throw new FsError("already exists", 409);
    mkdirSync(path.dirname(b), { recursive: true });
    renameSync(a, b);
    return { path: this.rel(b) };
  }

  remove(rel: string): { path: string } {
    const full = this.resolve(rel);
    if (full === this.base()) throw new FsError("not the project itself", 403);
    if (!existsSync(full)) throw new FsError("no such file", 404);
    rmSync(full, { recursive: true, force: true });
    return { path: rel };
  }

  /** Every file, for quick open: heavy folders skipped, at most `cap`. */
  files(cap = 20000): string[] {
    const base = this.base();
    const out: string[] = [];
    const walk = (dir: string) => {
      if (out.length >= cap) return;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (out.length >= cap) return;
        if (HEAVY.has(name)) continue;
        const full = path.join(dir, name);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(full);
        else out.push(path.relative(base, full).split(path.sep).join("/"));
      }
    };
    walk(base);
    return out;
  }

  /** Search the files' text: ripgrep when it is installed, a plain walk when not. */
  async search(q: string, cap = 200): Promise<{ path: string; line: number; text: string }[]> {
    const query = String(q || "").trim();
    if (!query) return [];
    const base = this.base();
    const viaRg = await new Promise<{ path: string; line: number; text: string }[] | null>(
      (resolve) => {
        execFile(
          "rg",
          [
            "--json",
            "-i",
            "-F",
            "--max-count",
            "20",
            "-g",
            "!node_modules",
            "-g",
            "!.git",
            "-g",
            "!dist",
            query,
            ".",
          ],
          { cwd: base, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
          (err, out) => {
            // rg exits 1 when nothing matched; that is an answer, not a failure
            if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resolve(null);
            const hits: { path: string; line: number; text: string }[] = [];
            for (const l of String(out ?? "").split("\n")) {
              if (hits.length >= cap) break;
              try {
                const m = JSON.parse(l);
                if (m.type !== "match") continue;
                hits.push({
                  path: String(m.data.path.text)
                    .replace(/^\.[/\\]/, "")
                    .split(path.sep)
                    .join("/"),
                  line: m.data.line_number,
                  text: String(m.data.lines.text ?? "")
                    .replace(/\s+$/, "")
                    .slice(0, 240),
                });
              } catch {
                /* not a line of json */
              }
            }
            resolve(hits);
          },
        );
      },
    );
    if (viaRg) return viaRg;
    const lower = query.toLowerCase();
    const hits: { path: string; line: number; text: string }[] = [];
    for (const f of this.files(5000)) {
      if (hits.length >= cap) break;
      let text: string;
      try {
        const full = path.join(base, f);
        if (statSync(full).size > 1024 * 1024) continue;
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (!text.toLowerCase().includes(lower)) continue;
      text.split(/\r?\n/).forEach((t, i) => {
        if (hits.length < cap && t.toLowerCase().includes(lower))
          hits.push({ path: f, line: i + 1, text: t.trim().slice(0, 240) });
      });
    }
    return hits;
  }
}
