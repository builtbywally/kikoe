// Bundles MediaPipe's tasks-vision API (Apache-2.0) into one browser script
// for the Room's Holo-Explorer (body.js), as window.KikVision. Only the API:
// the WebAssembly and the hand model (21 MB) are fetched by the app the first
// time hands are turned on (models.ts, HANDS_FILES), at the same version.
//
//   npm i @mediapipe/tasks-vision@1.1.0 --prefix <dir>
//   node scripts/build-hands.mjs <dir>
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.argv[2];
if (!home) {
  console.error(
    "usage: node scripts/build-hands.mjs <dir holding node_modules/@mediapipe/tasks-vision>",
  );
  process.exit(1);
}
const pkg = JSON.parse(
  readFileSync(
    path.join(home, "node_modules", "@mediapipe", "tasks-vision", "package.json"),
    "utf8",
  ),
);
await build({
  stdin: { contents: 'export * from "@mediapipe/tasks-vision";', resolveDir: home },
  bundle: true,
  format: "iife",
  globalName: "KikVision",
  target: "es2020",
  minify: true,
  outfile: path.resolve(
    here,
    "..",
    "packages",
    "app",
    "renderer",
    "room",
    "vendor",
    "mediapipe-vision.js",
  ),
  banner: {
    js: `/*! @mediapipe/tasks-vision ${pkg.version} (Apache-2.0) — https://github.com/google-ai-edge/mediapipe */`,
  },
  logLevel: "warning",
});
console.log("mediapipe-vision.js built from tasks-vision", pkg.version);
