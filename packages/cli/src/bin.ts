#!/usr/bin/env node
/**
 * The `kikoe` command. `speak` sends a line to the running app; the other
 * subcommands the cold-install job calls are named here so a missing one
 * fails with a sentence, not a stack trace.
 */

import { readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const HOME = process.env.KIKOE_HOME || path.join(os.homedir(), ".kikoe");
const PLANNED = ["install", "uninstall", "demo", "doctor", "bench", "up", "down", "status", "logs"];

function token(): string {
  if (process.env.KIKOE_TOKEN) return process.env.KIKOE_TOKEN.trim();
  try {
    return readFileSync(path.join(HOME, "daemon_token.txt"), "utf8").trim();
  } catch {
    return "";
  }
}

function port(): number {
  if (process.env.KIKOE_PORT) return Number(process.env.KIKOE_PORT) || 4570;
  try {
    const cfg = JSON.parse(readFileSync(path.join(HOME, "config.local.json"), "utf8"));
    return Number(cfg.port) || 4570;
  } catch {
    return 4570;
  }
}

/** POST a line to /speak as text/plain, as the agent's own line. Exit 1 if nobody answers. */
function speak(text: string, priority?: number): Promise<number> {
  return new Promise((resolve) => {
    const body = priority === undefined ? text : JSON.stringify({ text, priority });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: port(),
        path: "/speak",
        method: "POST",
        timeout: 3000,
        headers: {
          authorization: `Bearer ${token()}`,
          "content-type": priority === undefined ? "text/plain" : "application/json",
          "content-length": Buffer.byteLength(body),
          "x-kikoe-source": "agent",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode === 200 ? 0 : 1));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(1);
    });
    req.on("error", () => {
      process.stderr.write("kikoe isn't running: start the app.\n");
      resolve(1);
    });
    req.end(body);
  });
}

/**
 * Put something on the board. Reads a file or stdin. With --ask, blocks until
 * the user answers and prints the answer, so a script can act on it.
 */
function show(args: string[]): Promise<number> {
  const opts: Record<string, string> = {};
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = args[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        opts[key] = val;
        i++;
      } else opts[key] = "true";
    } else files.push(a);
  }
  const body =
    files.length && files[0] !== "-" ? readFileSync(files[0]!, "utf8") : readFileSync(0, "utf8");
  const headers: Record<string, string> = {
    authorization: `Bearer ${token()}`,
    "content-type": "text/plain",
    "content-length": String(Buffer.byteLength(body)),
    "x-kikoe-source": "agent",
    "x-kikoe-kind": opts.kind ?? guessKind(files[0] ?? ""),
  };
  if (opts.title) headers["x-kikoe-title"] = opts.title;
  if (opts.repo) headers["x-kikoe-repo"] = opts.repo;
  if (opts.ttl) headers["x-kikoe-ttl"] = opts.ttl;
  if (opts.ask) headers["x-kikoe-ask"] = opts.ask;
  if (opts.wait) headers["x-kikoe-wait"] = opts.wait;
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: port(), path: "/show", method: "POST", timeout: 130000, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            process.stderr.write(`kikoe show: ${data || res.statusCode}\n`);
            return resolve(1);
          }
          if (opts.ask) process.stdout.write(`${data}\n`);
          resolve(0);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(1);
    });
    req.on("error", () => {
      process.stderr.write("kikoe isn't running: start the app.\n");
      resolve(1);
    });
    req.end(body);
  });
}

function guessKind(file: string): string {
  if (/\.(diff|patch)$/i.test(file)) return "diff";
  if (/\.(md|markdown)$/i.test(file)) return "markdown";
  if (/\.svg$/i.test(file)) return "svg";
  if (/\.(png|jpe?g|gif|webp)$/i.test(file)) return "image";
  if (/\.(dia|flow)$/i.test(file)) return "diagram";
  if (/\.html?$/i.test(file)) return "html";
  if (/\.(csv|tsv)$/i.test(file)) return "table";
  return "text";
}

export async function main(argv: string[]): Promise<number> {
  const [cmd = "", ...rest] = argv;
  if (cmd === "show") return show(rest);
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    process.stdout.write(`kikoe ${version}\n`);
    return 0;
  }
  if (cmd === "speak") {
    const text = rest.join(" ").trim();
    if (!text) {
      process.stderr.write('usage: kikoe speak "one good line"\n');
      return 2;
    }
    return speak(text);
  }
  if (cmd === "" || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(
      [
        `kikoe ${version}: hear your coding agents from across the room.`,
        "",
        '  kikoe speak "Tests pass. Two still failing."   say a line through the app',
        '  kikoe show [file|-] --kind diff --title "…" [--ask apply,no]   put it on the board',
        "",
        "Planned (Phase 1 of docs/PLAN.md):",
        ...PLANNED.map((c) => `  kikoe ${c}`),
        "",
      ].join("\n"),
    );
    return 0;
  }
  if (PLANNED.includes(cmd)) {
    process.stderr.write(`kikoe ${cmd}: not built yet (Phase 1). Args: ${rest.join(" ")}\n`);
    return 1;
  }
  process.stderr.write(`kikoe: unknown command "${cmd}"\n`);
  return 2;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
