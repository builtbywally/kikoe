/**
 * Projects: one board each, found by folder, opened by voice.
 *
 * The resolver is the part that matters. The ear does not spell project
 * names the way the folders do, so matching leans towards answering: a wrong
 * guess costs one correction, a refused right one costs trust.
 */

import { describe, expect, it } from "vitest";
import { Board, MAX_PINS } from "../src/pins.js";
import { Projects, editDistance, slug } from "../src/projects.js";

describe("slug", () => {
  it("makes a name into an id", () => {
    expect(slug("Marine")).toBe("marine");
    expect(slug("Walnut Website")).toBe("walnut-website");
    expect(slug("Stores Images Creator")).toBe("stores-images-creator");
    expect(slug("  KCC UIUX  ")).toBe("kcc-uiux");
  });
});

describe("editDistance", () => {
  it("counts edits and gives up past the cap", () => {
    expect(editDistance("marine", "marine")).toBe(0);
    expect(editDistance("marine", "marina")).toBe(1);
    expect(editDistance("marine", "supercalifragilistic")).toBeGreaterThan(2);
  });
});

describe("Projects", () => {
  function withThirteen() {
    const p = new Projects(() => 1000);
    for (const name of ["Marine", "Billiar", "kikoe", "Walnut Website", "ARCHAI"]) {
      p.ensure(name, `C:/Users/USER/orca/projects/${name}`);
    }
    return p;
  }

  it("makes a project the first time it sees a folder", () => {
    // The daemon always passes the repo name, which `repoOf` has already
    // resolved by walking up to the nearest .git — so a subfolder never
    // becomes a project of its own.
    const p = new Projects();
    const a = p.of("C:/Users/USER/orca/projects/Marine/src", "Marine");
    expect(a.id).toBe("marine");
    expect(p.of("C:/Users/USER/orca/projects/Marine/src/deep", "Marine").id).toBe("marine");
    expect(p.all()).toHaveLength(1);
  });

  it("falls back to the folder name when nobody says what the repo is", () => {
    const p = new Projects();
    expect(p.of("C:/Users/USER/orca/projects/Marine").id).toBe("marine");
    expect(p.of("").id).toBe("kik");
  });

  it("keeps a repo inside a registered folder with that folder", () => {
    const p = new Projects();
    p.ensure("Marine", "C:/Users/USER/orca/projects/Marine");
    const inner = p.of("C:/Users/USER/orca/projects/Marine/packages/api");
    expect(inner.id).toBe("marine");
  });

  it("prefers the longest matching root", () => {
    const p = new Projects();
    p.ensure("Orca", "C:/Users/USER/orca");
    p.ensure("Marine", "C:/Users/USER/orca/projects/Marine");
    expect(p.of("C:/Users/USER/orca/projects/Marine/src").id).toBe("marine");
    expect(p.of("C:/Users/USER/orca/other").id).toBe("orca");
  });

  it("does not care about slashes or case", () => {
    const p = new Projects();
    p.ensure("Marine", "C:\\Users\\USER\\orca\\projects\\Marine");
    expect(p.of("c:/users/user/orca/projects/marine/src").id).toBe("marine");
  });

  it("finds a project by what the ear made of its name", () => {
    const p = withThirteen();
    expect(p.resolve("Marine")?.id).toBe("marine");
    expect(p.resolve("marine")?.id).toBe("marine");
    expect(p.resolve("the marine project")?.id).toBe("marine");
    expect(p.resolve("marina")?.id).toBe("marine"); // one edit
    expect(p.resolve("walnut")?.id).toBe("walnut-website"); // a prefix
    expect(p.resolve("archai")?.id).toBe("archai");
  });

  it("says nothing rather than guess wildly", () => {
    const p = withThirteen();
    expect(p.resolve("something else entirely")).toBeUndefined();
    expect(p.resolve("")).toBeUndefined();
  });

  it("learns what the ear called it, so the next time is direct", () => {
    const p = withThirteen();
    p.learn("marine", "murray");
    expect(p.resolve("murray")?.id).toBe("marine");
    expect(p.get("marine")?.aliases).toContain("murray");
    // and does not collect the same one twice, or the real name
    p.learn("marine", "murray");
    p.learn("marine", "Marine");
    expect(p.get("marine")?.aliases).toEqual(["murray"]);
  });

  it("opens one and remembers which", () => {
    const p = withThirteen();
    expect(p.open("billiar")?.name).toBe("Billiar");
    expect(p.current.id).toBe("billiar");
    expect(p.open("nope")).toBeUndefined();
    expect(p.current.id).toBe("billiar");
  });

  it("always has a current project, even empty", () => {
    expect(new Projects().current.id).toBe("kik");
  });

  it("goes to disk and comes back, current included", () => {
    const p = withThirteen();
    p.open("marine");
    p.learn("marine", "murray");
    const back = new Projects();
    back.load(JSON.parse(JSON.stringify(p.toJSON())));
    expect(back.current.id).toBe("marine");
    expect(back.resolve("murray")?.id).toBe("marine");
    expect(back.all()).toHaveLength(5);
  });

  it("survives a broken file", () => {
    const p = new Projects();
    expect(p.load(null)).toBe(0);
    expect(p.load({ projects: "nonsense" })).toBe(0);
    expect(p.load({ projects: [null, {}, { id: "ok" }] })).toBe(1);
  });
});

describe("boards are per project", () => {
  it("keeps each project's pins apart", () => {
    const b = new Board(() => {});
    b.add({ kind: "note", body: "a", project: "marine", repo: "marine" });
    b.add({ kind: "note", body: "b", project: "billiar", repo: "billiar" });
    expect(b.list("marine")).toHaveLength(1);
    expect(b.list("billiar")).toHaveLength(1);
    expect(b.list()).toHaveLength(2);
    expect(b.projects().sort()).toEqual(["billiar", "marine"]);
  });

  it("gives each project its own twenty-four, so opening one does not empty another", () => {
    const b = new Board(() => {});
    const keep = b.add({ kind: "note", body: "keep me", project: "marine", repo: "marine" });
    for (let i = 0; i < MAX_PINS * 2; i++) {
      b.add({ kind: "note", body: `n${i}`, project: "billiar", repo: "billiar" });
    }
    expect(b.get(keep.id)).toBeDefined();
    expect(b.list("marine")).toHaveLength(1);
    expect(b.list("billiar").length).toBeLessThanOrEqual(MAX_PINS);
  });

  it("saves one project at a time", () => {
    const b = new Board(() => {});
    b.add({ kind: "note", body: "a", project: "marine", sticky: true });
    b.add({ kind: "note", body: "b", project: "billiar", sticky: true });
    expect(b.toJSON("marine")).toHaveLength(1);
    expect(b.toJSON("marine")[0]?.body).toBe("a");
    expect(b.toJSON()).toHaveLength(2);
  });

  it("remembers where a card was put, across a save and a load", () => {
    const b = new Board(() => {});
    const pin = b.add({ kind: "note", body: "a", project: "marine", sticky: true });
    b.update(pin.id, { x: -420, y: 1337 });
    const back = new Board(() => {});
    back.load(JSON.parse(JSON.stringify(b.toJSON("marine"))));
    const got = back.get(pin.id);
    expect(got?.x).toBe(-420);
    expect(got?.y).toBe(1337);
    expect(got?.project).toBe("marine");
  });

  it("takes a negative position and refuses nonsense", () => {
    const b = new Board(() => {});
    const pin = b.add({ kind: "note", body: "a" });
    b.update(pin.id, { x: -50, y: -50 });
    expect(b.get(pin.id)?.x).toBe(-50);
    b.update(pin.id, { x: Number.NaN, y: Number.POSITIVE_INFINITY });
    expect(b.get(pin.id)?.x).toBe(0);
    expect(b.get(pin.id)?.y).toBe(0);
  });

  it("puts a pin with no project on the board you are looking at", () => {
    // Found by a screenshot: a pin added without a project landed on no
    // board at all and was simply invisible. Silence means "here".
    let here = "marine";
    const b = new Board(
      () => {},
      () => 1000,
      () => here,
    );
    const a = b.add({ kind: "note", body: "a" });
    expect(a.project).toBe("marine");
    here = "billiar";
    expect(b.add({ kind: "note", body: "b" }).project).toBe("billiar");
    // and an explicit project still wins
    expect(b.add({ kind: "note", body: "c", project: "kik" }).project).toBe("kik");
  });

  it("defaults to no position, so the board still lays a new card out", () => {
    const b = new Board(() => {});
    const pin = b.add({ kind: "note", body: "a" });
    expect(pin.x).toBe(0);
    expect(pin.y).toBe(0);
  });
});
