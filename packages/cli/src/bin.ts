#!/usr/bin/env node
/**
 * The `earshot` command. Phase 0: it knows its version and it knows what it
 * cannot do yet. Every subcommand the cold-install job calls is listed here
 * so a missing one fails with a sentence, not a stack trace.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const PLANNED = ["install", "uninstall", "demo", "doctor", "bench", "up", "down", "status", "logs"];

export function main(argv: string[]): number {
  const [cmd = "", ...rest] = argv;
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    process.stdout.write(`earshot ${version}\n`);
    return 0;
  }
  if (cmd === "" || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(
      [
        `earshot ${version}: hear your coding agents from across the room.`,
        "",
        "Nothing works yet. Phase 1 of docs/PLAN.md delivers:",
        ...PLANNED.map((c) => `  earshot ${c}`),
        "",
      ].join("\n"),
    );
    return 0;
  }
  if (PLANNED.includes(cmd)) {
    process.stderr.write(`earshot ${cmd}: not built yet (Phase 1). Args: ${rest.join(" ")}\n`);
    return 1;
  }
  process.stderr.write(`earshot: unknown command "${cmd}"\n`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
