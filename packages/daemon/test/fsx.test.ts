/**
 * The IDE's files: everything inside the project's folder, nothing outside
 * it, and a write that refuses to clobber a file someone else changed.
 */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Fsx } from "../src/fsx.js";

function project() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kikoe-fsx-"));
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
  writeFileSync(path.join(root, "src", "a.ts"), "export const answer = 42;\n");
  writeFileSync(path.join(root, "README.md"), "# Hello\nThe answer is here.\n");
  writeFileSync(path.join(root, "node_modules", "x", "i.js"), "answer");
  return { root, fs: new Fsx(() => root) };
}

describe("Fsx", () => {
  it("lists folders first, heavy ones last", () => {
    const { fs } = project();
    expect(fs.list("").map((e) => e.name)).toEqual(["src", "node_modules", "README.md"]);
  });

  it("refuses anything outside the project", () => {
    const { fs } = project();
    expect(() => fs.read("../../etc/passwd")).toThrow(/outside/);
    expect(() => fs.write("..\\evil.txt", "x")).toThrow(/outside/);
    expect(() => fs.remove("")).toThrow(/project itself/);
  });

  it("reads and writes, and will not clobber a file changed since it was read", () => {
    const { root, fs } = project();
    const r = fs.read("src/a.ts");
    expect(r.text).toContain("42");
    const w = fs.write("src/a.ts", "export const answer = 43;\n", r.mtime);
    expect(fs.read("src/a.ts").text).toContain("43");
    // someone else writes after
    writeFileSync(path.join(root, "src", "a.ts"), "changed by an agent\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(path.join(root, "src", "a.ts"), later, later);
    expect(() => fs.write("src/a.ts", "mine", w.mtime)).toThrow(/changed on disk/);
  });

  it("creates, renames and removes inside the folder", () => {
    const { fs } = project();
    fs.create("docs/new.md", false);
    fs.rename("docs/new.md", "docs/renamed.md");
    expect(fs.list("docs").map((e) => e.name)).toEqual(["renamed.md"]);
    fs.remove("docs");
    expect(() => fs.list("docs")).toThrow(/no such folder/);
  });

  it("finds files and text, skipping node_modules", async () => {
    const { fs } = project();
    expect(fs.files().sort()).toEqual(["README.md", "src/a.ts"]);
    const hits = await fs.search("answer");
    expect(hits.map((h) => h.path).sort()).toEqual(["README.md", "src/a.ts"]);
    expect(hits.find((h) => h.path === "src/a.ts")?.line).toBe(1);
  });

  it("says when a project has no folder", () => {
    const fs = new Fsx(() => null);
    expect(() => fs.list("")).toThrow(/no folder/);
  });
});
