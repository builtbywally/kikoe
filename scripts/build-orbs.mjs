// Bundles the Thinking Orbs engine (github.com/Jakubantalik/thinking-orbs,
// MIT) into one browser script for the Room, the phone and the island,
// which load plain scripts with no bundler of their own.
//
// Only the engine — pure geometry and 2D-canvas painting — is taken; the
// React component is replaced by renderer/orbs.js. Rebuild with:
//
//   git clone https://github.com/Jakubantalik/thinking-orbs ../thinking-orbs
//   node scripts/build-orbs.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "..", "thinking-orbs");
const out = path.resolve(
  here,
  "..",
  "packages",
  "app",
  "renderer",
  "room",
  "vendor",
  "thinking-orbs.js",
);
const license = readFileSync(path.join(src, "LICENSE"), "utf8").trim();
const version = JSON.parse(readFileSync(path.join(src, "package.json"), "utf8")).version;

await build({
  entryPoints: [path.join(src, "src", "engine", "index.ts")],
  bundle: true,
  format: "iife",
  globalName: "ThinkingOrbsEngine",
  target: "es2020",
  minify: true,
  outfile: out,
  banner: {
    js: `/*! thinking-orbs ${version} engine — https://github.com/Jakubantalik/thinking-orbs\n${license}\n*/`,
  },
});
console.log(`wrote ${path.relative(process.cwd(), out)}`);
