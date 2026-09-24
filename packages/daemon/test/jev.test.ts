import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-jev-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let jev: typeof import("../src/jev.js");
let pc: typeof import("../src/pc.js");
let dmod: typeof import("../src/daemon.js");
let cfg: typeof import("../src/config.js");
beforeAll(async () => {
  jev = await import("../src/jev.js");
  pc = await import("../src/pc.js");
  dmod = await import("../src/daemon.js");
  cfg = await import("../src/config.js");
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** What the fake Jev answers, per question id. */
interface Script {
  action?: string;
  sure?: number;
  task?: number;
  open?: string;
  project?: string;
  projectSure?: number;
  directed?: number;
}

/** A fetch that answers like Jev, from a script, and counts what it was asked. */
function fakeJev(script: Script, seen: Array<Record<string, unknown>> = []) {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push(body);
    const answers: Record<string, unknown> = {};
    const choice = (c: string, p: number) => ({
      type: "choice",
      choice: c,
      probabilities: { [c]: p },
      confidence: p,
    });
    for (const id of Object.keys(body.questions)) {
      if (id === "action") answers.action = choice(script.action ?? "kik", script.sure ?? 0.95);
      if (id === "task") answers.task = choice(`t${script.task ?? 0}`, 0.9);
      if (id === "open") answers.open = choice(script.open ?? "browser", 0.9);
      if (id === "project")
        answers.project = choice(script.project ?? "none", script.projectSure ?? 0.9);
      if (id === "directed") answers.directed = { type: "noul", noul: script.directed ?? 0.9 };
    }
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers }), { status: 200 });
  }) as typeof fetch;
}

function daemon(
  script: Script,
  extra: { brainKey?: string; seen?: Array<Record<string, unknown>> } = {},
) {
  const launched: Array<{ bin: string; args: string[] }> = [];
  const started: Array<{ project: string; prompt: string; fresh: boolean }> = [];
  const d = new dmod.Daemon({
    settings: { ...cfg.DEFAULTS, tts: "none", port: 0 },
    audio: false,
    persistBoard: false,
    jevKey: "test-key",
    fetchImpl: fakeJev(script, extra.seen),
    launchImpl: (l) => {
      launched.push({ bin: l.bin, args: l.args });
    },
  });
  for (const name of ["kikoe", "storefront", "billiar"]) {
    const dir = path.join(HOME, name);
    mkdirSync(dir, { recursive: true });
    d.projects.ensure(name, dir);
  }
  // never a real Claude Code from a test
  d.agents.start = (project, _cwd, prompt, _session, fresh) => {
    started.push({ project, prompt, fresh });
    return { ok: true, said: fresh ? `started an agent in ${project}` : `passed it to ${project}` };
  };
  return { d, launched, started };
}

describe("the pieces Jev chooses between", () => {
  it("offers the job inside the sentence as a piece of what was said", () => {
    const c = jev.taskCandidates(
      "open a new claude session in storefront and tell it to do one, two, three, four",
    );
    expect(c[0]).toContain("open a new claude session");
    expect(c).toContain("do one, two, three, four");
    // every candidate is a cut of the sentence, never a rewording
    for (const t of c)
      expect(
        "open a new claude session in storefront and tell it to do one, two, three, four",
      ).toContain(t);
  });

  it("finds a web address, and does not take a file name for one", () => {
    expect(jev.findUrl("open github.com")).toBe("https://github.com");
    expect(jev.findUrl("open localhost 3000 in the browser")).toBe("http://localhost:3000");
    expect(jev.findUrl("go to https://example.org/docs")).toBe("https://example.org/docs");
    expect(jev.findUrl("add a retry to the fetch in api.ts")).toBe("");
    expect(jev.findUrl("open the browser")).toBe("");
  });

  it("knows a site by its name, and mends a doubled ending", () => {
    expect(jev.siteByName("Can you open YouTube here?")).toBe("https://www.youtube.com");
    expect(jev.siteByName("open github in my browser")).toBe("https://www.github.com");
    expect(jev.siteByName("open marine in vs code", ["Marine"])).toBe("");
    expect(jev.siteByName("open the canvas")).toBe("");
    expect(jev.findUrl("open youtube.com.com")).toBe("https://youtube.com");
  });

  it("takes the site that was named, not the first noun after the verb", () => {
    // Heard from the phone on 2026-09-24; it opened picture.com.
    const said =
      "I need you to pull up a picture from unsplash into the canvas. Give me a picture of a cupcake.";
    expect(jev.siteByName(said)).toBe("https://www.unsplash.com");
    expect(jev.pictureOf(said)).toBe("cupcake");
    expect(jev.siteSearch(jev.siteByName(said), said)).toBe(
      "https://unsplash.com/s/photos/cupcake",
    );
    // the correction that followed still works
    expect(jev.siteByName("No, I need to go to unsplash.")).toBe("https://www.unsplash.com");
    // a site the list does not know, named after "from"
    expect(jev.siteByName("pull up a photo from flickr")).toBe("https://www.flickr.com");
    // no site named: the subject is never taken for one, and a picture comes from Unsplash
    expect(jev.siteByName("put a picture of a cupcake on the canvas")).toBe("");
    expect(jev.siteSearch("", "put a picture of red velvet cupcakes on the canvas")).toBe(
      "https://unsplash.com/s/photos/red-velvet-cupcakes",
    );
    // a query-string search keeps its spaces encoded
    expect(jev.siteSearch("https://www.google.com", "search for best pizza dough")).toBe(
      "https://www.google.com/search?q=best%20pizza%20dough",
    );
    // a site with nothing to find opens as it was
    expect(jev.siteSearch("https://www.unsplash.com", "open unsplash")).toBe(
      "https://www.unsplash.com",
    );
  });

  it("hears what to look up, and knows a video when it sees one", () => {
    expect(
      jev.searchQuery(
        "Now I want you to open YouTube on the canvas and look up for low-fi. Put some chill beats.",
      ),
    ).toBe("low-fi chill beats");
    expect(jev.searchQuery("play some jazz on the canvas")).toBe("jazz");
    expect(jev.searchQuery("open youtube")).toBe("");
    expect(jev.youtubeId("https://www.youtube.com/watch?v=CLeZyIID9Bo&t=4")).toBe("CLeZyIID9Bo");
    expect(jev.youtubeId("https://youtu.be/CLeZyIID9Bo")).toBe("CLeZyIID9Bo");
    expect(jev.isYoutube("https://www.youtube.com")).toBe(true);
    expect(jev.isYoutube("https://notyoutube.com")).toBe(false);
  });

  it("passes on the user's spelling with only the name cut off", () => {
    expect(dmod.spokenRest("Kikoe, open github.com please", "open github com please")).toBe(
      "open github.com please",
    );
    expect(dmod.spokenRest("hey kick, do one, two, three", "do one two three")).toBe(
      "do one, two, three",
    );
    expect(dmod.spokenRest("what's it doing?", "whats it doing?")).toBe("what's it doing?");
  });

  it("opens from a fixed menu, with no shell except the editor's shim", () => {
    const where = { dir: "C:\\p\\store", url: "", name: "storefront" };
    const code = pc.launchFor("vscode", where, "win32");
    expect(typeof code).toBe("object");
    if (typeof code === "object") expect(code.shell).toBe(true);
    const site = pc.launchFor("website", { ...where, url: "https://github.com" }, "win32");
    expect(site).toMatchObject({ bin: "explorer.exe", args: ["https://github.com"] });
    // an address that is not http is not opened, whatever it was
    expect(pc.launchFor("website", { ...where, url: "file:///c:/windows" }, "win32")).toBe(
      "which address?",
    );
    expect(pc.launchFor("terminal", { ...where, dir: "" }, "linux")).toMatch(/on disk/);
  });
});

describe("the switchboard in the daemon", () => {
  it("starts a new session in the named project with only the job", async () => {
    const rest = "open a new claude session in storefront and tell it to do one, two, three, four";
    const task = jev.taskCandidates(rest).indexOf("do one, two, three, four");
    const { d, started } = daemon({ action: "new_session", project: "storefront", task });
    expect(d.hear(`Kikoe, ${rest}.`).kind).toBe("deciding");
    await tick();
    expect(started).toHaveLength(1);
    expect(started[0]?.project).toBe("storefront");
    expect(started[0]?.fresh).toBe(true);
    // the user's own words, commas and all
    expect(started[0]?.prompt).toBe("do one, two, three, four");
    await d.close();
  });

  it("a new session is a new conversation, not the standing one", async () => {
    const { d, started } = daemon({ action: "new_session", project: "storefront" });
    const p = d.projects.resolve("storefront");
    if (!p) throw new Error("fixture");
    const before = d.projects.sessionFor(p.id);
    d.hear("kikoe start a new session in storefront and fix the checkout test");
    await tick();
    expect(started[0]?.fresh).toBe(true);
    expect(d.projects.resolve("storefront")?.session).not.toBe(before);
    await d.close();
  });

  it("sends work to the agent without asking the voice model", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { d, started } = daemon({ action: "agent" }, { seen });
    d.hear("kikoe add a retry to the fetch in the api client");
    await tick();
    // with nothing running it starts one, with the user's words
    expect(started[0]?.prompt).toContain("add a retry to the fetch");
    expect(seen.every((b) => !JSON.stringify(b).includes("anthropic"))).toBe(true);
    await d.close();
  });

  it("opens things on the PC from the menu", async () => {
    const { d, launched } = daemon({ action: "open", open: "website" });
    d.hear("kikoe open github.com");
    await tick();
    expect(launched[0]?.args).toContain("https://github.com");
    await d.close();
  });

  it("will not open anything with the setting off", async () => {
    const { d, launched } = daemon({ action: "open", open: "website" });
    d.settings.pc = false;
    d.hear("kikoe open github.com");
    await tick();
    expect(launched).toHaveLength(0);
    await d.close();
  });

  it("asks which project when the name was only half heard, and takes the answer", async () => {
    const { d, started } = daemon({
      action: "new_session",
      project: "storefront",
      projectSure: 0.35,
    });
    d.hear("kikoe start a session in store front and run the tests");
    await tick();
    expect(started).toHaveLength(0);
    expect(d.heardLog.at(-1)?.said).toMatch(/which project/i);
    // the window is open, so the bare name is for us, and it answers the question
    d.hear("storefront");
    await tick();
    expect(started[0]?.project).toBe("storefront");
    await d.close();
  });

  it("an unsure Jev changes nothing: the old path answers", async () => {
    const { d, started } = daemon({ action: "agent", sure: 0.4 });
    d.hear("kikoe what's it doing");
    await tick();
    expect(started).toHaveLength(0);
    expect(d.heardLog.at(-1)?.kind).toBe("question");
    await d.close();
  });

  it("with Jev unreachable, the rules still answer", async () => {
    const d = new dmod.Daemon({
      settings: { ...cfg.DEFAULTS, tts: "none", port: 0 },
      audio: false,
      persistBoard: false,
      jevKey: "k",
      fetchImpl: (async () => new Response("down", { status: 529 })) as typeof fetch,
    });
    d.hear("kikoe what's it doing");
    await tick();
    expect(d.heardLog.at(-1)?.kind).toBe("question");
    await d.close();
  });

  it("without a key it never asks: everything is synchronous, as before", async () => {
    const d = new dmod.Daemon({
      settings: { ...cfg.DEFAULTS, tts: "none", port: 0 },
      audio: false,
      persistBoard: false,
      jevKey: "",
    });
    expect(d.jev()).toBeNull();
    expect(d.hear("kikoe what's it doing").kind).toBe("question");
    await d.close();
  });

  it("judges a nameless sentence with Jev, not the voice model", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { d } = daemon({ directed: 0.1 }, { seen });
    expect(d.hear("yeah mum I'll be down in five minutes").kind).toBe("deciding");
    await tick();
    expect(d.heardLog.at(-1)?.kind).toBe("overheard");
    expect(seen.some((b) => "directed" in (b.questions as object))).toBe(true);
    await d.close();
  });

  it("stop the agent is a reflex, and stops only what Kik started", async () => {
    const { d } = daemon({});
    const r = d.hear("kikoe stop the agent");
    expect(r).toMatchObject({ kind: "control", intent: "agent" });
    expect(r.said).toMatch(/nothing i started/i);
    await d.close();
  });

  it("puts a site on the canvas when asked to show it here", async () => {
    const { d, launched } = daemon({ action: "canvas" });
    d.hear("kikoe can you open YouTube here");
    await tick();
    const card = d.board.list().find((p) => p.kind === "web");
    expect(card?.body).toBe("https://www.youtube.com");
    expect(launched).toHaveLength(0);
    await d.close();
  });

  it("from the phone, opening a site means the canvas, not the desk's browser", async () => {
    const { d, launched } = daemon({ action: "open", open: "website" });
    d.typed("open youtube", "phone");
    await tick();
    expect(d.board.list().some((p) => p.kind === "web")).toBe(true);
    expect(launched).toHaveLength(0);
    // at the desk the same words open the browser
    d.hear("kikoe open youtube");
    await tick();
    expect(launched[0]?.args.join(" ")).toContain("youtube.com");
    await d.close();
  });

  it("from the phone, a site asked for on the computer opens on the computer", async () => {
    // Heard from the phone on 2026-09-24; it made a canvas card instead.
    const { d, launched } = daemon({ action: "open", open: "website" });
    d.typed("Can you pull up Chrome on my computer and go to YouTube?", "phone");
    await tick();
    expect(launched[0]?.args.join(" ")).toContain("youtube.com");
    expect(d.board.list().some((p) => p.kind === "web")).toBe(false);
    await d.close();
  });

  it("'on the desktop, please' moves the last canvas site to the PC", async () => {
    const { d, launched } = daemon({ action: "open", open: "website" });
    d.typed("open youtube", "phone");
    await tick();
    expect(launched).toHaveLength(0);
    d.typed("On the desktop please.", "phone");
    await tick();
    expect(launched[0]?.args.join(" ")).toContain("youtube.com");
    await d.close();
  });

  it("knows when a sentence names the computer", () => {
    for (const t of [
      "pull up Chrome on my computer",
      "open youtube on the desktop",
      "show it in my browser",
      "open it in firefox",
    ])
      expect(jev.wantsThePc(t)).toBe(true);
    for (const t of ["open youtube here", "put it on the canvas", "open youtube"])
      expect(jev.wantsThePc(t)).toBe(false);
    expect(jev.siteByName("pull up Chrome on my computer")).toBe("");
  });

  it("looks YouTube up and shows the player, which a phone will frame", async () => {
    const asked: string[] = [];
    const d = new dmod.Daemon({
      settings: { ...cfg.DEFAULTS, tts: "none", port: 0 },
      audio: false,
      persistBoard: false,
      jevKey: "",
      fetchImpl: (async (url: string) => {
        asked.push(String(url));
        return new Response('..."videoId":"CLeZyIID9Bo","thumbnail"...', { status: 200 });
      }) as unknown as typeof fetch,
    });
    const said = await d.showOnCanvas("https://www.youtube.com", "lofi chill beats");
    expect(said).toMatch(/on the canvas/);
    expect(asked[0]).toContain("search_query=lofi%20chill%20beats");
    const card = d.board.list().find((p) => p.kind === "web");
    expect(card?.body).toBe("https://www.youtube.com/embed/CLeZyIID9Bo?autoplay=1&rel=0");
    // a video link needs no search: it becomes its own player
    await d.showOnCanvas("https://youtu.be/dQw4w9WgXcQ");
    expect(d.board.list().some((p) => p.body.includes("/embed/dQw4w9WgXcQ"))).toBe(true);
    await d.close();
  });

  it("the key never reaches the log", () => {
    expect(cfg.redact("authorization: Bearer ts_live_abcdef123456")).not.toContain("abcdef");
  });
});
