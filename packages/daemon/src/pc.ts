/**
 * Opening things on the PC: the editor, a folder, a terminal, a browser.
 *
 * A fixed menu, not a command line. Jev picks one of these and code fills
 * in the rest from what it already knows (a project's folder) or found in
 * the sentence (an http address), so a misheard sentence can at worst open
 * the wrong window. Nothing here runs a command the user said, and nothing
 * goes through a shell except the one shim that needs it (`code.cmd`), with
 * a folder path Kikoe itself registered.
 */

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { Opener } from "./jev.js";

export interface Launch {
  bin: string;
  args: string[];
  /** only for a Windows .cmd shim */
  shell?: boolean;
  /** what Kik says when it has gone */
  said: string;
}

const HOME_PAGE = "https://www.google.com";

/** The folders people name by name: "open my downloads". */
const KNOWN_FOLDERS: [string, string, string][] = [
  ["downloads?", "Downloads", "your downloads"],
  ["documents?", "Documents", "your documents"],
  ["desktop", "Desktop", "your desktop"],
  ["pictures|photos", "Pictures", "your pictures"],
  ["music", "Music", "your music"],
  ["videos?", "Videos", "your videos"],
];

/**
 * A folder the sentence names ("open my downloads", "show me the desktop
 * folder"), as a path under home and a name to say, or null. Only these few,
 * and only the user's own: a sentence never becomes a path by itself.
 */
export function knownFolder(
  text: string,
  home: string = os.homedir(),
): { dir: string; name: string } | null {
  // "open Spotify on the desktop" means the screen, not the folder
  const t = text.replace(/\b(on|to)\s+(the|my)\s+desktop\b/gi, "");
  for (const [word, sub, name] of KNOWN_FOLDERS) {
    // "my downloads", "the downloads folder": never the bare word, since
    // "play music" is not a request for a folder
    const re = new RegExp(`\\b(my|the)\\s+(${word})\\b|\\b(${word})\\s+folder\\b`, "i");
    if (re.test(t)) return { dir: path.join(home, sub), name };
  }
  return null;
}

/** The program and arguments for one target, or a reason it cannot be opened. */
export function launchFor(
  what: Opener,
  target: { dir: string; url: string; name: string },
  platform: NodeJS.Platform = process.platform,
): Launch | string {
  const { dir, name } = target;
  const url = /^https?:\/\//i.test(target.url) ? target.url : "";
  const win = platform === "win32";
  const mac = platform === "darwin";
  switch (what) {
    case "website":
    case "browser": {
      if (what === "website" && !url) return "which address?";
      const to = url || HOME_PAGE;
      const said = url ? `opened ${url.replace(/^https?:\/\/(www\.)?/, "")}` : "opened the browser";
      // explorer.exe hands an address to the default browser without a shell
      if (win) return { bin: "explorer.exe", args: [to], said };
      return { bin: mac ? "open" : "xdg-open", args: [to], said };
    }
    case "explorer":
      if (!dir) return `I don't know where ${name} is on disk`;
      if (win) return { bin: "explorer.exe", args: [dir], said: `opened ${name}'s folder` };
      return { bin: mac ? "open" : "xdg-open", args: [dir], said: `opened ${name}'s folder` };
    case "vscode":
      if (!dir) return `I don't know where ${name} is on disk`;
      if (mac)
        return {
          bin: "open",
          args: ["-a", "Visual Studio Code", dir],
          said: `opened ${name} in the editor`,
        };
      // `code` is a .cmd shim on Windows, which spawn refuses without a shell
      return {
        bin: "code",
        args: [win ? `"${dir}"` : dir],
        shell: win,
        said: `opened ${name} in the editor`,
      };
    case "terminal":
      if (!dir) return `I don't know where ${name} is on disk`;
      if (win)
        return {
          bin: "cmd.exe",
          args: ["/c", "start", "", "/D", dir, "cmd.exe"],
          said: `opened a terminal in ${name}`,
        };
      if (mac)
        return { bin: "open", args: ["-a", "Terminal", dir], said: `opened a terminal in ${name}` };
      return { bin: "x-terminal-emulator", args: [], said: `opened a terminal in ${name}` };
  }
  return "I can't open that";
}

/** Start it and let go: the window is the user's, not ours. */
export function launch(l: Launch, cwd: string, log: (line: string) => void = () => {}): void {
  try {
    const child = spawn(l.bin, l.args, {
      cwd: cwd || undefined,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      shell: l.shell === true,
    });
    child.on("error", (e) => log(`pc: could not open ${l.bin}: ${e.message}`));
    child.unref();
  } catch (e) {
    log(`pc: could not open ${l.bin}: ${(e as Error).message}`);
  }
}
