// Every logo file, from one source: こえ (koe, "voice") as outlines from Noto
// Serif JP (SIL Open Font License), kept in koe-paths.json at three weights.
// Outlines rather than text, so the mark looks the same on every machine and
// needs no font. Run from the repo root:
//
//   node brand/make.mjs
//
// It writes the brand files here, the app's icons (build/icon.png, icon.ico,
// tray icons), and the website's favicon and mark component. Nothing else
// regenerates them; run it again after changing a colour or a weight.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const P = JSON.parse(await readFile(join(here, "koe-paths.json"), "utf8"));

const INK = "#14100E";
const PAPER = "#F5F1EC";
const EMBER = "#D2683F";

/** The glyphs alone, in a box with a little air round them. */
function wordmark(fill, weight = 500, title = "こえ") {
  const g = P[weight];
  const m = Math.round(g.h * 0.08);
  const w = Math.round(g.w + m * 2);
  const h = Math.round(g.h + m * 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${title}">
  <title>${title}</title>
  <path transform="translate(${m} ${m})" fill="${fill}" d="${g.d}"/>
</svg>
`;
}

/**
 * The app icon: こえ in paper on an ink tile, with the ember glow the orb
 * used to carry sitting behind the word. `small` is the heavier cut, set
 * larger, for 48px and under, where the thin strokes of the 500 disappear.
 */
function tile(size, small) {
  const g = P[small ? 900 : 500];
  const width = size * (small ? 0.86 : 0.7);
  const k = width / g.w;
  const x = (size - g.w * k) / 2;
  const y = (size - g.h * k) / 2 + size * (small ? 0 : 0.01);
  const r = size * (small ? 0.2 : 0.2237);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Kikoe">
  <title>Kikoe</title>
  <defs>
    <radialGradient id="glow" cx="50%" cy="56%" r="58%">
      <stop offset="0" stop-color="${EMBER}" stop-opacity="${small ? 0.5 : 0.42}"/>
      <stop offset=".55" stop-color="${EMBER}" stop-opacity=".1"/>
      <stop offset="1" stop-color="${EMBER}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${r.toFixed(1)}" fill="${INK}"/>
  <rect width="${size}" height="${size}" rx="${r.toFixed(1)}" fill="url(#glow)"/>
  <path transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${k.toFixed(5)})" fill="${PAPER}" d="${g.d}"/>
</svg>
`;
}

/** The glyphs alone on transparency, filling a square: tray icons. */
function glyphSquare(size, fill) {
  const g = P[900];
  const k = (size * 0.96) / g.w;
  const y = (size - g.h * k) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <path transform="translate(${(size * 0.02).toFixed(2)} ${y.toFixed(2)}) scale(${k.toFixed(5)})" fill="${fill}" d="${g.d}"/>
</svg>
`;
}

// Rasterised at twice the target and scaled down, for clean edges.
const png = (svg, size) =>
  sharp(Buffer.from(svg), {
    density: (72 * 2 * size) / Number(svg.match(/viewBox="0 0 (\d+)/)[1]),
  })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();

/** A Windows .ico holding PNG images, one per size. */
function ico(images) {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((x) => x.data)]);
}

const write = async (rel, body) => {
  await writeFile(join(repo, rel), body);
  console.log(rel);
};

// the brand files
await write("brand/koe.svg", wordmark(PAPER));
await write("brand/koe-ink.svg", wordmark(INK));
await write("brand/koe-mono.svg", wordmark("currentColor"));
await write("brand/koe-small.svg", wordmark("currentColor", 900));
await write("brand/app-icon.svg", tile(1024, false));
await write("brand/app-icon-small.svg", tile(64, true));
await write("brand/app-icon-1024.png", await png(tile(1024, false), 1024));
await write("brand/app-icon-512.png", await png(tile(1024, false), 512));

// the app
await write("packages/app/build/icon.png", await png(tile(1024, false), 1024));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = [];
for (const size of sizes) {
  const svg = size <= 48 ? tile(64, true) : tile(1024, false);
  images.push({ size, data: await png(svg, size) });
}
await write("packages/app/build/icon.ico", ico(images));
// Windows tray: the small tile, drawn at the size it is shown, twice over
await write("packages/app/build/tray.png", await png(tile(64, true), 32));
// macOS menu bar: black glyphs on nothing; the system tints a template image
await write("packages/app/build/trayTemplate.png", await png(glyphSquare(22, "#000"), 22));
await write("packages/app/build/trayTemplate@2x.png", await png(glyphSquare(44, "#000"), 44));

// the website, which lives in its own repo (builtbywally/kikoe-website):
// written into a checkout of it at ../kikoe-website, or wherever KIKOE_SITE
// points, when there is one
const site = process.env.KIKOE_SITE ?? join(repo, "../kikoe-website");
if (existsSync(join(site, "package.json"))) {
  await writeFile(join(site, "app/icon.svg"), tile(64, true));
  const paths = Object.fromEntries(
    Object.entries(P).map(([k, v]) => [k, { d: v.d, w: v.w, h: v.h }]),
  );
  await writeFile(
    join(site, "components/koe.ts"),
    `// Generated by brand/make.mjs (in the kikoe repo) from brand/koe-paths.json.
// Do not edit. こえ from Noto Serif JP (SIL Open Font License), as outlines.
export const KOE = ${JSON.stringify(paths)} as const;
`,
  );
  console.log(`${site}: app/icon.svg, components/koe.ts`);
} else {
  console.log(`no website checkout at ${site}; its icon and mark were not written`);
}
