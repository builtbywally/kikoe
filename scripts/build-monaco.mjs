// Bundles Monaco (the editor of VS Code, MIT) for the desk's editor cards,
// as plain scripts the Room loads with no bundler of its own:
//   vendor/monaco/editor.js       window.KikMonaco (all languages and features)
//   vendor/monaco/editor.css      its styles, with the codicon font beside it
//   vendor/monaco/*.worker.js     the editor, TypeScript, JSON, CSS, HTML workers
// The Room finds the workers through self.MonacoEnvironment (editor.js in
// renderer/room/ide.js). Built from a scratch folder, so no package.json
// changes:
//
//   npm i monaco-editor@0.57.0 --prefix <dir>
//   node scripts/build-monaco.mjs <dir>
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.argv[2];
if (!home) {
  console.error("usage: node scripts/build-monaco.mjs <dir holding node_modules/monaco-editor>");
  process.exit(1);
}
const pkgDir = path.join(home, "node_modules", "monaco-editor");
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const out = path.resolve(here, "..", "packages", "app", "renderer", "room", "vendor", "monaco");
mkdirSync(out, { recursive: true });
const banner = {
  js: `/*! monaco-editor ${pkg.version} (MIT) — https://github.com/microsoft/monaco-editor */`,
};

await build({
  stdin: {
    // by its file: the package's exports map does not list the ESM entry
    contents: `export * from ${JSON.stringify(path.join(pkgDir, "esm/vs/editor/editor.main.js").split(path.sep).join("/"))};`,
    resolveDir: home,
  },
  bundle: true,
  format: "iife",
  globalName: "KikMonaco",
  target: "es2020",
  minify: true,
  outfile: path.join(out, "editor.js"),
  loader: { ".ttf": "file" },
  assetNames: "[name]",
  banner,
  logLevel: "warning",
});

const workers = {
  "editor.worker": "esm/vs/editor/editor.worker.js",
  "ts.worker": "esm/vs/language/typescript/ts.worker.js",
  "json.worker": "esm/vs/language/json/json.worker.js",
  "css.worker": "esm/vs/language/css/css.worker.js",
  "html.worker": "esm/vs/language/html/html.worker.js",
};
for (const [name, entry] of Object.entries(workers)) {
  await build({
    entryPoints: [path.join(pkgDir, entry)],
    bundle: true,
    format: "iife",
    target: "es2020",
    minify: true,
    outfile: path.join(out, `${name}.js`),
    banner,
    logLevel: "warning",
  });
}
console.log("monaco built from", pkg.version, "into", out);
