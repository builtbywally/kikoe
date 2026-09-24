// The README's pictures, made from the site itself so they never go stale.
//
//   pnpm --filter @kikoe/site build
//   pnpm --filter @kikoe/site readme-images
//
// Two kinds, into docs/images/readme/:
// - hero.svg and pipeline.svg: drawn here, animated with SMIL (GitHub plays
//   it inside an <img>), with the app's own fonts embedded so they render the
//   same everywhere.
// - room, phones, island, switchboard, board: the site's components, served
//   from out/ and captured by headless Chrome at twice the pixel density.
import { readFile, stat } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { openBrowser } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, "..");
const repo = join(site, "../..");
const dest = join(repo, "docs/images/readme");
const fonts = join(repo, "packages/app/renderer/fonts");
// the logo, こえ, from the brand's own outlines (brand/make.mjs)
const KOE = JSON.parse(await readFile(join(repo, "brand/koe-paths.json"), "utf8"))[500];
await mkdir(dest, { recursive: true });

const font = async (file) => (await readFile(join(fonts, file))).toString("base64");
const face = (family, b64, style = "normal", weight = 400) =>
  `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${b64}) format("woff2");font-style:${style};font-weight:${weight}}`;

const INK = "#14100e";
const PAPER = "#f5f1ec";
const EMBER = "#d2683f";
const EMBER_LT = "#edb893";
const DIM = "#9a948a";
const DIMMER = "#6a645c";

/** A ring of dots that breathes in a wave, like the app's idle orb. */
function dotRing(cx, cy, r, n, dot, dur = 3.2) {
  let s = "";
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = (cx + r * Math.cos(a)).toFixed(1);
    const y = (cy + r * Math.sin(a)).toFixed(1);
    const begin = ((i / n) * dur).toFixed(2);
    s += `<circle cx="${x}" cy="${y}" r="${dot}" fill="${PAPER}" opacity=".35"><animate attributeName="opacity" values=".25;1;.25" dur="${dur}s" begin="-${begin}s" repeatCount="indefinite"/><animate attributeName="r" values="${dot * 0.7};${dot * 1.25};${dot * 0.7}" dur="${dur}s" begin="-${begin}s" repeatCount="indefinite"/></circle>`;
  }
  return s;
}

async function heroSvg() {
  const [serif, serifIt, sans, mono] = await Promise.all([
    font("InstrumentSerif-400-normal.woff2"),
    font("InstrumentSerif-400-italic.woff2"),
    font("InstrumentSans-normal.woff2"),
    font("IBMPlexMono-400-normal.woff2"),
  ]);
  const W = 1280;
  const H = 560;
  const ox = 1000;
  const oy = 270;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Kikoe. Talk to Kik. The agents do the work.">
<style>${face("S", serif)}${face("S", serifIt, "italic")}${face("A", sans)}${face("M", mono)}
.h{font:400 104px S,Georgia,serif;letter-spacing:-2px}.l{font:400 22px A,system-ui,sans-serif;fill:${DIM}}.m{font:400 14px M,monospace;fill:${DIMMER};letter-spacing:.5px}.e{font:400 14px M,monospace;fill:${EMBER};letter-spacing:2px}</style>
<defs>
<radialGradient id="g" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${EMBER}" stop-opacity=".34"/><stop offset=".55" stop-color="${EMBER}" stop-opacity=".08"/><stop offset="1" stop-color="${EMBER}" stop-opacity="0"/></radialGradient>
<radialGradient id="bg" cx="78%" cy="48%" r="60%"><stop offset="0" stop-color="#2a1a12"/><stop offset="1" stop-color="${INK}"/></radialGradient>
</defs>
<rect width="${W}" height="${H}" rx="24" fill="url(#bg)"/>
<circle cx="${ox}" cy="${oy}" r="232" fill="none" stroke="${PAPER}" stroke-opacity=".06"/>
<circle cx="${ox}" cy="${oy}" r="178" fill="none" stroke="${PAPER}" stroke-opacity=".1" stroke-dasharray="3 7"><animateTransform attributeName="transform" type="rotate" from="0 ${ox} ${oy}" to="360 ${ox} ${oy}" dur="90s" repeatCount="indefinite"/></circle>
<circle cx="${ox}" cy="${oy}" r="128" fill="none" stroke="${PAPER}" stroke-opacity=".12"/>
<circle cx="${ox}" cy="${oy}" r="150" fill="url(#g)"><animate attributeName="r" values="140;158;140" dur="4.2s" repeatCount="indefinite"/></circle>
<g>${dotRing(ox, oy, 86, 44, 3.2)}<animateTransform attributeName="transform" type="rotate" from="0 ${ox} ${oy}" to="360 ${ox} ${oy}" dur="24s" repeatCount="indefinite"/></g>
<text x="${ox}" y="${oy + 190}" text-anchor="middle" class="m">hold the orb to talk</text>
<g transform="translate(70 52) scale(${(46 / KOE.h).toFixed(5)})" fill="${PAPER}" style="filter:drop-shadow(0 0 10px rgba(210,104,63,.5))"><path d="${KOE.d}"/></g>
<text x="${(70 + (46 * KOE.w) / KOE.h + 20).toFixed(0)}" y="84" class="e">KOE, “VOICE” · KIKOE</text>
<text x="68" y="214" class="h" fill="${PAPER}">Talk to Kik.</text>
<text x="68" y="318" class="h" fill="${DIM}">The agents do <tspan font-style="italic" fill="${EMBER_LT}">the work.</tspan></text>
<text x="72" y="388" class="l">The room you run your coding agents from, by voice.</text>
<text x="72" y="420" class="l">An ear, a voice, a mind and an infinite canvas, beside Claude Code.</text>
<text x="72" y="486" class="m"><tspan fill="${EMBER}">· </tspan>MIT licensed   <tspan fill="${EMBER}">· </tspan>Windows 10 / 11   <tspan fill="${EMBER}">· </tspan>runs on your Claude subscription   <tspan fill="${EMBER}">· </tspan>Whisper on your PC</text>
</svg>`;
}

async function pipelineSvg() {
  const [serif, mono] = await Promise.all([
    font("InstrumentSerif-400-normal.woff2"),
    font("IBMPlexMono-400-normal.woff2"),
  ]);
  const W = 1280;
  const H = 460;
  const y = 150;
  const nodes = [
    { x: 76, t: "you speak", d: "headset or phone" },
    { x: 256, t: "the ear", d: "Silero + Whisper" },
    { x: 436, t: "for Kik?", d: "the name, or Jev 0.3 s" },
    { x: 616, t: "a reflex?", d: "stop · quiet · yes · no" },
    { x: 796, t: "Jev", d: "one call, 0.4 s" },
  ];
  const dests = [
    { y: 56, t: "kik · talking", d: "Haiku, kept warm · 0.5–1.7 s" },
    { y: 126, t: "kik · thinking", d: "Opus, in the background · ~25 s" },
    { y: 196, t: "agent · project", d: "Claude Code in the repo" },
    { y: 266, t: "the PC · the canvas", d: "code, at once" },
  ];
  let s = "";
  for (const n of nodes) {
    s += `<circle cx="${n.x}" cy="${y}" r="30" fill="${INK}" stroke="${PAPER}" stroke-opacity=".22"/>`;
    s += `<text x="${n.x}" y="${y + 60}" text-anchor="middle" class="t">${n.t}</text>`;
    s += `<text x="${n.x}" y="${y + 82}" text-anchor="middle" class="d">${n.d}</text>`;
  }
  let paths = "";
  for (const [i, d] of dests.entries()) {
    const id = `p${i}`;
    paths += `<path id="${id}" d="M826 ${y} C 900 ${y}, 920 ${d.y + 27}, 990 ${d.y + 27}" fill="none" stroke="${PAPER}" stroke-opacity=".16" stroke-dasharray="3 5"/>`;
    s += `<rect x="990" y="${d.y}" width="262" height="54" rx="10" fill="${INK}" stroke="${i === 2 ? EMBER : PAPER}" stroke-opacity="${i === 2 ? ".7" : ".2"}"/>`;
    s += `<text x="1006" y="${d.y + 23}" class="k">${d.t}</text><text x="1006" y="${d.y + 42}" class="d">${d.d}</text>`;
    s += `<circle r="4" fill="${EMBER}"><animateMotion dur="1.8s" begin="${(2.4 + i * 0.35).toFixed(2)}s" repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1"><mpath href="#${id}"/></animateMotion></circle>`;
  }
  // the two ways out before the switchboard
  const drop = `<path d="M436 180 V 350" stroke="${PAPER}" stroke-opacity=".16" stroke-dasharray="3 5"/><text x="436" y="378" text-anchor="middle" class="d">not for Kik:</text><text x="436" y="398" text-anchor="middle" class="d">dropped whole</text>`;
  const reflex = `<path d="M616 180 V 350" stroke="${EMBER}" stroke-opacity=".5" stroke-dasharray="3 5"/><text x="616" y="378" text-anchor="middle" class="d">a reflex:</text><text x="616" y="398" text-anchor="middle" class="d">done at once, no model</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="How a sentence moves: you speak, the ear, for Kik?, a reflex?, Jev, then Kik talking, Kik thinking, the agent, or the PC and canvas">
<style>${face("S", serif)}${face("M", mono)}
.t{font:400 24px S,Georgia,serif;fill:${PAPER}}.k{font:400 15px M,monospace;fill:${EMBER_LT}}.d{font:400 12.5px M,monospace;fill:${DIM}}.e{font:400 13px M,monospace;fill:${EMBER};letter-spacing:2px}</style>
<rect width="${W}" height="${H}" rx="24" fill="#1c1714"/>
<text x="40" y="44" class="e">HOW A SENTENCE MOVES</text>
<path id="main" d="M76 ${y} H 826" stroke="${PAPER}" stroke-opacity=".2"/>
${paths}${drop}${reflex}${s}
<circle r="7" fill="${EMBER_LT}"><animateMotion dur="2.4s" repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines=".5 0 .3 1"><mpath href="#main"/></animateMotion><animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.05;.9;1" dur="2.4s" repeatCount="indefinite"/></circle>
<text x="40" y="436" class="d">Jev chooses; code acts. No model writes a command that gets run.</text>
</svg>`;
}

// --- captures of the built site -------------------------------------------------

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};
function serve(root, port) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let p = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
      try {
        if ((await stat(p)).isDirectory()) p = join(p, "index.html");
        const body = await readFile(p);
        res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    }).listen(port, () => resolve(server));
  });
}

async function captures() {
  const port = 4611;
  const server = await serve(join(site, "out"), port);
  const b = await openBrowser(9334);
  const save = async (name, png, width) => {
    const out = join(dest, `${name}.webp`);
    const info = await sharp(png)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 84 })
      .toFile(out);
    console.log(`${name}.webp ${info.width}×${info.height} ${(info.size / 1024).toFixed(0)} KB`);
  };
  try {
    await b.size(1400, 1000);
    await b.goto(`http://127.0.0.1:${port}/`, 3000);
    // No sticky nav, no Kik in the corner, and every animation at rest on a
    // good frame: these are pictures of the components, not of a scroll.
    await b.eval(`(() => {
      const s = document.createElement("style");
      s.textContent = ".nav,.companion{display:none!important} section{content-visibility:visible!important}";
      document.head.append(s);
    })()`);
    await b.eval(`document.querySelector("#room").scrollIntoView()`);
    await b.sleep(1500);
    await save("room", await b.shot(".room-frame"), 2400);
    await save("phone-iphone", await b.shot(".device-stage", 8), 760);
    await b.eval(`[...document.querySelectorAll(".model-switch button")][1].click()`);
    await b.sleep(900);
    await save("phone-pixel", await b.shot(".device-stage", 8), 760);
    await save("island", await b.shot(".island", 6), 900);
    await b.eval(`document.querySelector("#switchboard").scrollIntoView()`);
    await b.eval(`[...document.querySelectorAll(".chip")][2].click()`);
    await b.sleep(4200);
    await save("switchboard", await b.shot(".sim"), 2200);
    await b.eval(`document.querySelector("#canvas").scrollIntoView()`);
    await b.sleep(800);
    await save("board", await b.shot(".demo-board"), 2200);
  } finally {
    await b.close();
    server.close();
  }
}

await writeFile(join(dest, "hero.svg"), await heroSvg());
await writeFile(join(dest, "pipeline.svg"), await pipelineSvg());
console.log("hero.svg pipeline.svg");
await captures();
