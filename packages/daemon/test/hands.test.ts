import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-hands-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let hands: typeof import("../src/hands.js");
let dmod: typeof import("../src/daemon.js");
let cfg: typeof import("../src/config.js");
beforeAll(async () => {
  hands = await import("../src/hands.js");
  dmod = await import("../src/daemon.js");
  cfg = await import("../src/config.js");
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("keys, as SendKeys wants them", () => {
  it("types text literally, even SendKeys' own syntax", () => {
    expect(hands.sendKeysText("50% off (today) {really} a+b")).toBe(
      "50{%} off {(}today{)} {{}really{}} a{+}b",
    );
    expect(hands.sendKeysText("line one\nline two")).toBe("line one{ENTER}line two");
  });
  it("names chords the way people say them, and refuses what it does not know", () => {
    expect(hands.sendKeysChord("ctrl+s")).toBe("^s");
    expect(hands.sendKeysChord("Ctrl + Shift + T")).toBe("^+t");
    expect(hands.sendKeysChord("alt+f4")).toBe("%{F4}");
    expect(hands.sendKeysChord("enter")).toBe("{ENTER}");
    expect(hands.sendKeysChord("hyper+q")).toBe("");
    expect(hands.sendKeysChord("ctrl+banana")).toBe("");
  });
});

/** A daemon with hands that record what they did instead of doing it. */
function rig(on = true) {
  const did: string[] = [];
  const fake = {
    windows: async () => [{ pid: 1, name: "notepad", title: "Untitled - Notepad" }],
    front: async () => ({ pid: 1, name: "notepad", title: "Untitled - Notepad" }),
    focus: async (m: string) => {
      did.push(`focus ${m}`);
      return { pid: 1, name: "notepad", title: "Untitled - Notepad" };
    },
    open: async (a: string) => {
      did.push(`open ${a}`);
      return "started";
    },
    type: async (t: string) => {
      did.push(`type ${t}`);
    },
    press: async (k: string) => {
      did.push(`press ${k}`);
    },
    controls: async () => [{ type: "button", name: "Send" }],
    pressControl: async (n: string) => {
      did.push(`button ${n}`);
      return "pressed";
    },
    close: () => {},
  };
  const d = new dmod.Daemon({
    settings: { ...cfg.DEFAULTS, tts: "none", port: 0, hands: on },
    audio: false,
    persistBoard: false,
    handsImpl: fake,
  });
  const tool = (name: string) => d.brainTools().find((t) => t.name === name);
  const pending = () => d.state().pending_permission as { id: string } | null;
  return { d, did, tool, pending };
}

describe("apps, and the keys SendKeys cannot press", () => {
  it("hears the app in the sentence", async () => {
    const jev = await import("../src/jev.js");
    expect(jev.appName("open notepad")).toBe("notepad");
    expect(jev.appName("Can you pull up Chrome on my computer and go to YouTube?")).toBe("Chrome");
    expect(jev.appName("launch visual studio code please")).toBe("visual studio code");
    expect(jev.appName("switch to spotify")).toBe("spotify");
    expect(jev.appName("what's on the board")).toBe("");
  });
  it("presses the Windows key and the media keys by code", () => {
    expect(hands.vkChord("win+d")).toEqual([0x5b, 0x44]);
    expect(hands.vkChord("windows")).toEqual([0x5b]);
    expect(hands.vkChord("volume up")).toEqual([0xaf]);
    expect(hands.vkChord("Play")).toEqual([0xb3]);
    expect(hands.vkChord("ctrl+s")).toBeNull();
    expect(hands.vkChord("win+banana")).toBeNull();
  });
});

describe("Kik's hands, behind the gate", () => {
  it("has no hands at all with the setting off", () => {
    const { d, tool } = rig(false);
    expect(tool("type_text")).toBeUndefined();
    expect(d.hands()).toBeNull();
  });

  it("looks without asking", async () => {
    const { tool, pending } = rig();
    const out = await tool("read_window")?.run({});
    expect(out).toContain("Send");
    expect(pending()).toBeNull();
  });

  it("types nothing until the user says yes, then does", async () => {
    const { d, did, tool, pending } = rig();
    const done = tool("type_text")?.run({ text: "hello" }) as Promise<string>;
    await tick();
    expect(did).toEqual([]);
    const id = pending()?.id ?? "";
    expect(id).toMatch(/^kik-/);
    d.answerPermission(true, id);
    expect(await done).toBe("typed");
    expect(did).toEqual(["type hello"]);
  });

  it("opens an app that is not open, and brings forward one that is", async () => {
    const { d, did, pending } = rig();
    const opening = d.openApp("calculator");
    await tick();
    d.answerPermission(true, pending()?.id ?? "");
    await opening;
    expect(did).toEqual(["open calculator"]);
    // notepad is already open (the fake lists it): it is switched to, not started again
    const switching = d.openApp("notepad");
    await tick();
    d.answerPermission(true, pending()?.id ?? "");
    await switching;
    expect(did).toEqual(["open calculator", "focus notepad"]);
  });

  it("says how to turn the hands on, rather than failing", async () => {
    const { d } = rig(false);
    expect(await d.openApp("notepad")).toMatch(/Let Kik use this PC/);
  });

  it("a no is a no", async () => {
    const { d, did, tool, pending } = rig();
    const done = tool("press_keys")?.run({ keys: "ctrl+s" }) as Promise<string>;
    await tick();
    d.answerPermission(false, pending()?.id ?? "");
    expect(await done).toMatch(/not done/);
    expect(did).toEqual([]);
  });

  it("a yes to working in an app stands for a moment, so a paragraph is one question", async () => {
    const { d, did, tool, pending } = rig();
    const first = tool("type_text")?.run({ text: "one" }) as Promise<string>;
    await tick();
    d.answerPermission(true, pending()?.id ?? "");
    await first;
    // the same app, straight after: no second question
    expect(await tool("type_text")?.run({ text: "two" })).toBe("typed");
    expect(pending()).toBeNull();
    expect(did).toEqual(["type one", "type two"]);
  });

  it("does nothing if another window came to the front while it asked", async () => {
    const { d, did, tool, pending } = rig();
    const done = tool("type_text")?.run({ text: "secret" }) as Promise<string>;
    await tick();
    // a dialog pops up before the yes arrives
    const h = d.hands() as unknown as { front: () => Promise<unknown> };
    h.front = async () => ({ pid: 2, name: "OpenWith", title: "Pick an app" });
    d.answerPermission(true, pending()?.id ?? "");
    expect(await done).toMatch(/window in front changed/);
    expect(did).toEqual([]);
  });

  it("says a window runs as administrator, instead of typing into nothing", async () => {
    const { d, did, tool, pending } = rig();
    const h = d.hands() as unknown as { front: () => Promise<unknown> };
    h.front = async () => ({ pid: 3, name: "cmd", title: "Administrator: cmd", admin: true });
    expect(await tool("type_text")?.run({ text: "dir" })).toMatch(/administrator/);
    expect(pending()).toBeNull();
    expect(did).toEqual([]);
  });

  it("knows the user's own folders by name, and not a bare word", async () => {
    const pc = await import("../src/pc.js");
    const home = path.join("C:", "Users", "me");
    expect(pc.knownFolder("open my downloads", home)?.dir).toBe(path.join(home, "Downloads"));
    expect(pc.knownFolder("show me the documents folder", home)?.dir).toBe(
      path.join(home, "Documents"),
    );
    expect(pc.knownFolder("open my desktop folder", home)?.dir).toBe(path.join(home, "Desktop"));
    expect(pc.knownFolder("open spotify on the desktop", home)).toBeNull();
    expect(pc.knownFolder("play music", home)).toBeNull();
  });

  it("asks every time for what cannot be undone, yes or no before", async () => {
    const { d, did, tool, pending } = rig();
    const typed = tool("type_text")?.run({ text: "hi" }) as Promise<string>;
    await tick();
    d.answerPermission(true, pending()?.id ?? "");
    await typed;
    // pressing Send in the same app is still asked
    const send = tool("press_button")?.run({ name: "Send" }) as Promise<string>;
    await tick();
    expect(pending()).not.toBeNull();
    expect(did).toEqual(["type hi"]);
    d.answerPermission(true, pending()?.id ?? "");
    expect(await send).toBe("pressed");
  });
});
