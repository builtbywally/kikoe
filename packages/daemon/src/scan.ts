/**
 * Every project on the machine, found by looking.
 *
 * Projects used to register themselves when a hook arrived, plus whatever
 * sat next door (`discoverSiblings`). That found the thirteen folders under
 * `~/orca/projects` and nothing else: the Trae projects in Documents, a repo
 * in `C:\Projects`, the ones on the desktop — "open Printly" failed because
 * no agent had ever run there. The user asked on 2026-09-26 for Kik to reach
 * all of them.
 *
 * So this walks the places people keep work: the home folder and the
 * top-level folders of the system drive that are not Windows' own. It reads
 * directory listings and nothing else — no file is opened — and stops at the
 * first folder that looks like a project, so a repo's insides are never
 * walked. A folder is a project when it holds a `.git` directory or a file
 * that only a project has (package.json, CLAUDE.md, pyproject.toml, …).
 * A `.git` *file* is a worktree of a repo found elsewhere (Orca's
 * workspaces, `WM Studio-connector`), and is left alone: its hooks still
 * land on the right board through `Projects.of`.
 *
 * Downloads is looked at one level deep only: a project put there on
 * purpose ("Commerce Project", 2026-09-26) is found, but the templates,
 * zips unpacked twice and "- Copy" folders further down are not.
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface Found {
  dir: string;
  name: string;
  /**
   * The folder around it, when that folder holds nothing else: "Printly v3"
   * around `walnut_print` is what the user calls it.
   */
  wrapper?: string;
}

/** Files and folders only a project has. */
const MARKERS = new Set([
  "package.json",
  "claude.md",
  "pyproject.toml",
  "requirements.txt",
  "cargo.toml",
  "go.mod",
  "pubspec.yaml",
  "composer.json",
  "gemfile",
  "pom.xml",
  "build.gradle",
  "deno.json",
]);

/** Walked into only this many levels, whatever the depth: where downloads land. */
const SHALLOW: Record<string, number> = { downloads: 1 };

/** Never walked into, at any depth. */
const SKIP = new Set([
  "node_modules",
  "appdata",
  "application data",
  "local settings",
  "venv",
  "__pycache__",
  "site-packages",
  // build output carries a copied package.json that is not a project
  "win-unpacked",
  "dist",
  "build",
  "out",
  "release",
  "target",
  "vendor",
  "library",
  "program files",
  "program files (x86)",
  "programdata",
  "windows",
  "users",
  "recovery",
  "system volume information",
  "documents and settings",
  "perflogs",
  "msocache",
  "intel",
  "amd",
  "nvidia",
  "xboxgames",
  "riot games",
  "games",
  "saved games",
  "music",
  "videos",
  "pictures",
  "3d objects",
  "contacts",
  "favorites",
  "links",
  "searches",
  "start menu",
  "templates",
  "sendto",
  "recent",
  "cookies",
  "nethood",
  "printhood",
]);

function skipped(name: string): boolean {
  if (name.startsWith(".") || name.startsWith("$") || name.startsWith("~")) return true;
  return SKIP.has(name.toLowerCase());
}

/**
 * Folders that hold projects and are never one, whatever lies loose in
 * them: a stray CLAUDE.md in Downloads made "Downloads" a project, and every
 * project inside it vanished into that one (2026-09-26).
 */
const CONTAINERS = new Set([
  "downloads",
  "documents",
  "my documents",
  "belgelerim",
  "desktop",
  "onedrive",
  "dropbox",
  "google drive",
  "icloud drive",
]);

export function isContainer(dir: string): boolean {
  const name = path.basename(dir.replace(/[\\/]+$/, "")).toLowerCase();
  return CONTAINERS.has(name) || name.startsWith("onedrive - ");
}

/** Where people keep work: home, and the system drive's own top level. */
export function defaultRoots(): string[] {
  const home = os.homedir();
  if (process.platform !== "win32") return [home];
  const drive = path.parse(home).root || "C:\\";
  return [home, drive];
}

export interface ScanOptions {
  /** how far below a root to look; ~/Documents/trae_projects/Printly v3/walnut_print is 4 */
  depth?: number;
  /** a ceiling on directories listed, so a huge tree cannot stall the daemon */
  budget?: number;
}

/** What makes a listing a project, or undefined. */
function isProject(entries: Dirent[]): boolean {
  for (const e of entries) {
    const n = e.name.toLowerCase();
    if (n === ".git" && e.isDirectory()) return true;
    if (e.isFile() && MARKERS.has(n)) return true;
  }
  return false;
}

/** A `.git` file: a worktree whose repo lives somewhere else. */
function isWorktree(entries: Dirent[]): boolean {
  return entries.some((e) => e.name.toLowerCase() === ".git" && e.isFile());
}

/**
 * Walk the roots, breadth first, and return every project under them.
 * The roots themselves are never projects (a home folder with a stray
 * package.json in it is not "a project called USER").
 */
export async function findProjects(roots: string[], opts: ScanOptions = {}): Promise<Found[]> {
  const depth = opts.depth ?? 4;
  let budget = opts.budget ?? 6000;
  const found: Found[] = [];
  const seen = new Set<string>();
  // a root nested in another (home is inside C:\) is walked once, from the top
  const queue: { dir: string; level: number; parent: string; only: boolean; limit: number }[] = [];
  for (const r of roots) queue.push({ dir: r, level: 0, parent: "", only: false, limit: depth });

  while (queue.length && budget > 0) {
    const { dir, level, parent, only, limit } = queue.shift()!;
    const key = dir.replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    budget--;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // no access, gone, or not a directory
    }
    if (level > 0 && !isContainer(dir)) {
      if (isWorktree(entries)) continue;
      if (isProject(entries)) {
        const name = path.basename(dir);
        found.push(only && parent ? { dir, name, wrapper: parent } : { dir, name });
        continue;
      }
    }
    if (level >= limit) continue;
    // Junctions and symlinks are not directories to a Dirent, which is what
    // keeps "My Documents" and "Application Data" from being walked twice.
    const subs = entries.filter((e) => e.isDirectory() && !skipped(e.name));
    for (const s of subs) {
      const shallow = SHALLOW[s.name.toLowerCase()];
      queue.push({
        dir: path.join(dir, s.name),
        level: level + 1,
        parent: level > 0 ? path.basename(dir) : "",
        only: subs.length === 1,
        limit: shallow === undefined ? limit : Math.min(limit, level + 1 + shallow),
      });
    }
  }
  return found;
}
