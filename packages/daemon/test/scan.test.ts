/**
 * The scan: every project on the machine, from directory listings alone.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Projects } from "../src/projects.js";
import { findProjects } from "../src/scan.js";

function tree(files: string[]): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "kikoe-scan-"));
  for (const f of files) {
    const full = path.join(root, f);
    if (f.endsWith("/")) mkdirSync(full, { recursive: true });
    else {
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, "");
    }
  }
  return root;
}

describe("findProjects", () => {
  it("finds repos and marked folders, and stops inside them", async () => {
    const root = tree([
      "orca/projects/Marine/.git/",
      "orca/projects/Marine/packages/api/package.json",
      "Documents/trae/Printly/CLAUDE.md",
      "Documents/trae/Printly/walnut_print/.git/",
      "Documents/trae/Printly v3/walnut_print/.git/",
      "Documents/trae/Askio/Prompt.md",
      "Documents/trae/MyCV/package.json",
    ]);
    const found = await findProjects([root]);
    const names = found.map((f) => f.name).sort();
    expect(names).toEqual(["Marine", "MyCV", "Printly", "walnut_print"]);
    expect(found.find((f) => f.name === "walnut_print")?.wrapper).toBe("Printly v3");
  });

  it("leaves worktrees, deep Downloads, node_modules and hidden folders alone", async () => {
    const root = tree([
      "orca/workspaces/Marine/drum/.git",
      "Downloads/OLD/Dolmapp/.git/",
      "Downloads/template - Copy/site/package.json",
      "code/node_modules/left-pad/package.json",
      ".claude/plugins/thing/.git/",
      "code/app/.git/",
    ]);
    const found = await findProjects([root]);
    expect(found.map((f) => f.name)).toEqual(["app"]);
  });

  it("finds a project put straight into Downloads, even with a stray CLAUDE.md there", async () => {
    const root = tree([
      "Downloads/CLAUDE.md",
      "Downloads/Commerce Project/package.json",
      "Downloads/OLD/Dolmapp/.git/",
    ]);
    expect((await findProjects([root])).map((f) => f.name)).toEqual(["Commerce Project"]);
  });

  it("does not call a root a project, and stops at the depth it is given", async () => {
    const root = tree(["package.json", "a/b/c/d/e/.git/"]);
    expect(await findProjects([root], { depth: 4 })).toEqual([]);
    expect((await findProjects([root], { depth: 5 })).map((f) => f.name)).toEqual(["e"]);
  });

  it("survives a root that is not there", async () => {
    expect(await findProjects([path.join(os.tmpdir(), "kikoe-no-such-folder")])).toEqual([]);
  });
});

describe("Projects.adopt", () => {
  it("leaves a folder already on a board alone", () => {
    const p = new Projects(() => 1);
    p.ensure("Marine", "C:/orca/projects/Marine");
    expect(p.adopt("C:/orca/projects/Marine", "Marine")).toBeUndefined();
    expect(p.adopt("C:/orca/projects/Marine/sub", "sub")).toBeUndefined();
    expect(p.all()).toHaveLength(1);
  });

  it("names a clash after its parent rather than folding it into the first", () => {
    const p = new Projects(() => 1);
    p.ensure("Dolmapp", "C:/orca/Dolmapp");
    const b = p.adopt("C:/Documents/Startup/Dolmapp", "Dolmapp");
    expect(b?.id).toBe("startup-dolmapp");
    expect(p.get("dolmapp")?.roots).toEqual(["C:/orca/Dolmapp"]);
    expect(p.resolve("startup dolmapp")?.id).toBe("startup-dolmapp");
  });

  it("calls a lone repo by the folder around it, and still answers to its own name", () => {
    const p = new Projects(() => 1);
    const a = p.adopt("C:/trae/Printly v3/walnut_print", "walnut_print", "Printly v3");
    expect(a?.name).toBe("Printly v3");
    expect(p.resolve("walnut print")?.id).toBe("printly-v3");
  });

  it("gives a board that had no folder the one it was missing", () => {
    const p = new Projects(() => 1);
    p.ensure("inhale", "");
    expect(p.adopt("C:/orca/projects/inhale", "inhale")?.id).toBe("inhale");
    expect(p.get("inhale")?.roots).toEqual(["C:/orca/projects/inhale"]);
  });

  it("never moves what the Room is looking at", () => {
    const p = new Projects(() => 1);
    p.ensure("Marine", "C:/orca/Marine");
    p.open("marine");
    p.adopt("C:/orca/Billiar", "Billiar");
    expect(p.current.id).toBe("marine");
  });
});
