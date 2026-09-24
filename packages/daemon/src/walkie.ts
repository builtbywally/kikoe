/**
 * The walkie-talkie: your phone as a microphone for Kik.
 *
 * The headset is the ear when you are at the desk. This is for when you are
 * not: hold a button on your phone, talk, let go, and what you said arrives
 * as though the headset had heard it.
 *
 * Three things make this more than a page.
 *
 * **It is a second listener, on purpose off.** `docs/APP.md` says loopback
 * only, and that stays the rule for the daemon: this is a *separate* server,
 * on its own port, that binds the LAN only when the setting is on. Turning
 * it off closes the socket. Nothing about the main daemon changes.
 *
 * **It has to be HTTPS.** `getUserMedia` refuses to run outside a secure
 * context, and a phone hitting `http://192.168.x.x` is not one — localhost
 * is the exception, and the phone is not localhost. So the daemon makes
 * itself a self-signed certificate, kept in `~/.kikoe`, and the phone is
 * asked to trust it once. That warning is the honest cost of not routing
 * your voice through somebody else's tunnel.
 *
 * **The audio is raw.** The page downsamples to the 16 kHz mono the
 * recognizer already wants and posts Int16 PCM, so there is no codec to
 * decode on this side and no second speech model: the same Whisper that
 * hears the headset hears the phone.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { HOME } from "./config.js";

export const WALKIE_RATE = 16000;
/** A held button is a sentence or two; anything longer is a stuck finger. */
export const MAX_CLIP_S = 60;
const MAX_BODY = WALKIE_RATE * 2 * MAX_CLIP_S;
/** Where a phone remembers the token, so the bare address keeps working. */
export const COOKIE = "kikoe_walkie";
const COOKIE_DAYS = 180;

export interface WalkieOptions {
  port: number;
  token: string;
  /** raw 16 kHz mono PCM from the phone; resolves with what was heard */
  onAudio: (pcm: Int16Array) => Promise<string> | string;
  /**
   * The canvas on the phone: the daemon's loopback port and its *viewer*
   * token. The phone's reads are passed through with that token, so the
   * daemon's own rule — a viewer may look and may not touch — is what holds,
   * not a second copy of it here.
   */
  room?: { port: number; viewer: string };
  /** a sentence typed on the phone; the same power as saying it */
  onText?: (text: string) => Promise<string> | string;
  log?: (line: string) => void;
}

/** What the phone may read through us: the viewer's routes, and nothing that acts. */
export const ROOM_READS = ["/state", "/sessions", "/stream", "/pins", "/backdrop", "/usage"];

/** Is this path one the phone may read through the proxy? */
export function proxiable(pathname: string): boolean {
  return (
    ROOM_READS.includes(pathname) ||
    pathname === "/room" ||
    pathname.startsWith("/room/") ||
    pathname.startsWith("/artifact/") ||
    // the bundled backdrops: the Room asks for ../backdrops/, which is outside
    // /room/, so the phone got a 404 and a background that came and went
    pathname.startsWith("/backdrops/")
  );
}

export interface Cert {
  key: string;
  cert: string;
  /** the sha256 of the certificate, so the page can show what to expect */
  fingerprint: string;
}

/** Every address this machine answers on, so the phone has a URL that works. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family !== "IPv4" || n.internal) continue;
      out.push(n.address);
    }
  }
  return out;
}

function certFile(): string {
  return path.join(HOME, "walkie_cert.pem");
}
function keyFile(): string {
  return path.join(HOME, "walkie_key.pem");
}
/** What the certificate was made for; a PEM is base64, so we cannot ask it. */
function certMetaFile(): string {
  return path.join(HOME, "walkie_cert.json");
}

/**
 * The certificate, made once and kept.
 *
 * It is kept rather than regenerated because the phone is asked to trust it
 * by hand: a new certificate every restart would mean a new warning every
 * restart, and a warning you see constantly is a warning you stop reading.
 * Every LAN address goes in as a SAN — a modern browser ignores the common
 * name entirely, so without them the certificate is refused outright.
 */
export async function ensureCert(hosts: string[] = lanAddresses()): Promise<Cert> {
  if (existsSync(certFile()) && existsSync(keyFile())) {
    const cert = readFileSync(certFile(), "utf8");
    const key = readFileSync(keyFile(), "utf8");
    // A laptop moves between networks, so a certificate that does not cover
    // the address the phone will actually dial is worse than none — the
    // browser refuses it outright rather than offering to continue.
    if (coversAll(hosts)) return { key, cert, fingerprint: readFingerprint() };
  }
  const selfsigned = (await import("selfsigned")) as unknown as {
    generate: (
      attrs: Array<{ name: string; value: string }>,
      opts: Record<string, unknown>,
    ) => Promise<{ private: string; cert: string; fingerprint?: string }>;
  };
  const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    ...hosts.map((ip) => ({ type: 7, ip })),
  ];
  const made = await selfsigned.generate([{ name: "commonName", value: "kikoe" }], {
    days: 3650,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames }],
  });
  mkdirSync(HOME, { recursive: true });
  writeFileSync(certFile(), made.cert);
  writeFileSync(keyFile(), made.private);
  writeFileSync(
    certMetaFile(),
    JSON.stringify({ hosts, fingerprint: made.fingerprint ?? "", made: Date.now() }),
  );
  return { key: made.private, cert: made.cert, fingerprint: made.fingerprint ?? "" };
}

function meta(): { hosts?: string[]; fingerprint?: string } {
  try {
    if (!existsSync(certMetaFile())) return {};
    return JSON.parse(readFileSync(certMetaFile(), "utf8"));
  } catch {
    return {};
  }
}

function readFingerprint(): string {
  return meta().fingerprint ?? "";
}

/** Does the certificate we already have name every address we answer on? */
function coversAll(hosts: string[]): boolean {
  const had = meta().hosts;
  if (!Array.isArray(had)) return false;
  return hosts.every((h) => had.includes(h));
}

/**
 * One piece of Kik's voice, as an event: 16-bit PCM at the rate it was made,
 * in base64. Base64 costs a third more than binary, and on a home network
 * that is nothing next to one stream that already reconnects by itself.
 */
export function voiceEvent(samples: Float32Array, rate: number): string {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const b = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
  return `event: pcm\ndata: {"r":${rate},"b":"${b}"}\n\n`;
}

export class Walkie {
  private server: https.Server | null = null;
  private readonly log: (line: string) => void;
  /** phones that asked to hear Kik; empty costs nothing */
  private readonly ears = new Set<import("node:http").ServerResponse>();
  constructor(private readonly opts: WalkieOptions) {
    this.log = opts.log ?? (() => {});
  }

  /** How many phones are listening to Kik's voice. */
  get listeners(): number {
    return this.ears.size;
  }

  /** What the desk speaker is playing, to every phone that is listening. */
  voice(samples: Float32Array, rate: number): void {
    if (!this.ears.size || !samples.length) return;
    const ev = voiceEvent(samples, rate);
    for (const res of this.ears) res.write(ev);
  }

  /** Kik was cut off: the phones stop too, rather than finishing the sentence. */
  voiceDrop(): void {
    for (const res of this.ears) res.write("event: drop\ndata: {}\n\n");
  }

  get running(): boolean {
    return this.server !== null;
  }

  /** Where to point the phone. */
  urls(): string[] {
    return lanAddresses().map(
      (ip) => `https://${ip}:${this.opts.port}/?t=${encodeURIComponent(this.opts.token)}`,
    );
  }

  async start(): Promise<void> {
    if (this.server) return;
    const { key, cert } = await ensureCert();
    const server = https.createServer({ key, cert }, (req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // The LAN, deliberately: this is the one part of Kikoe that is not
      // loopback, and it exists only while the setting is on.
      server.listen(this.opts.port, "0.0.0.0", () => resolve());
    });
    server.on("error", (e) => this.log(`walkie: ${e.message}`));
    this.server = server;
    this.log(`walkie: listening on ${this.opts.port}; ${this.urls().join(" ")}`);
  }

  async stop(): Promise<void> {
    const s = this.server;
    if (!s) return;
    this.server = null;
    // A phone watching the canvas or listening to Kik holds a stream open,
    // and close() waits for every connection: off would never finish.
    for (const res of this.ears) res.end();
    this.ears.clear();
    const closed = new Promise<void>((resolve) => s.close(() => resolve()));
    s.closeAllConnections();
    await closed;
    this.log("walkie: stopped");
  }

  /**
   * Is this request allowed, and did the link carry the token itself?
   *
   * A phone loses the query string constantly: tapping through the
   * certificate warning, a reload, "add to home screen", or retyping the
   * address by hand all arrive at the bare origin. The first time the token
   * is seen we set a cookie, so the answer to "the link needs its token"
   * stops being "find the original link again".
   */
  private auth(req: import("node:http").IncomingMessage): { ok: boolean; fresh: boolean } {
    const t = this.opts.token;
    if (!t) return { ok: false, fresh: false };
    const url = new URL(req.url ?? "/", "https://x");
    if (url.searchParams.get("t") === t) return { ok: true, fresh: true };
    const header = String(req.headers.authorization ?? "");
    if (header === `Bearer ${t}`) return { ok: true, fresh: false };
    for (const part of String(req.headers.cookie ?? "").split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k === COOKIE && rest.join("=") === t) return { ok: true, fresh: false };
    }
    return { ok: false, fresh: false };
  }

  private async handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "https://x");
    const { ok, fresh } = this.auth(req);
    if (!ok) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
      res.end(denied());
      return;
    }
    // Remembered on this phone, so the bare address keeps working. Scoped to
    // this origin, unreadable to scripts, and worth no more than the link the
    // user already had.
    const headers: Record<string, string> = {};
    if (fresh) {
      headers["set-cookie"] =
        `${COOKIE}=${this.opts.token}; Max-Age=${COOKIE_DAYS * 86400}; Path=/; Secure; HttpOnly; SameSite=Lax`;
    }
    // The certificate itself, so a phone can be told to trust it properly
    // rather than waved past a warning. Some browsers will hand over a
    // microphone after you click through an interstitial and some will not;
    // installing this once removes the question, and the warning with it.
    if (req.method === "GET" && url.pathname === "/cert.pem") {
      try {
        res.writeHead(200, {
          ...headers,
          "content-type": "application/x-pem-file",
          "content-disposition": 'attachment; filename="kikoe.pem"',
        });
        res.end(readFileSync(certFile(), "utf8"));
      } catch {
        res.writeHead(404).end("no certificate");
      }
      return;
    }
    // With the canvas on, the bare address is the Room: what you see on the
    // desk, with a button to talk. The button-only page stays at /talk.
    if (
      req.method === "GET" &&
      this.opts.room &&
      (url.pathname === "/" || url.pathname === "/index.html")
    ) {
      res.writeHead(302, { ...headers, location: "/room/?phone=1" });
      res.end();
      return;
    }
    // Kik's voice, for a phone that wants to hear it. Its own stream rather
    // than the Room's, so a phone that only looks never pays for audio.
    if (req.method === "GET" && url.pathname === "/voice") {
      res.writeHead(200, {
        ...headers,
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(": listening\n\n");
      this.ears.add(res);
      this.log(`walkie: a phone is listening (${this.ears.size})`);
      res.on("close", () => {
        this.ears.delete(res);
        this.log(`walkie: a phone stopped listening (${this.ears.size})`);
      });
      return;
    }
    if (req.method === "GET" && this.opts.room && proxiable(url.pathname)) {
      this.proxy(req, res, url, headers);
      return;
    }
    if (
      req.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/talk")
    ) {
      const body = page(this.opts.token);
      res.writeHead(200, {
        ...headers,
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    if (req.method === "POST" && url.pathname === "/say" && this.opts.onText) {
      let raw = "";
      for await (const c of req) {
        raw += c;
        if (raw.length > 4000) break;
      }
      let text = "";
      try {
        text = String(JSON.parse(raw || "{}").text ?? "")
          .trim()
          .slice(0, 1000);
      } catch {
        /* not json */
      }
      if (!text) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "nothing to say" }));
        return;
      }
      const kind = await this.opts.onText(text);
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, kind }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/audio") {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_BODY) {
          tooBig = true;
          break;
        }
        chunks.push(c as Buffer);
      }
      if (tooBig) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "that was a long press" }));
        return;
      }
      const buf = Buffer.concat(chunks);
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
      const seconds = pcm.length / WALKIE_RATE;
      this.log(`walkie: ${seconds.toFixed(1)}s of audio`);
      let heard = "";
      try {
        heard = String(await this.opts.onAudio(pcm));
      } catch (e) {
        this.log(`walkie: ${(e as Error).message}`);
      }
      res.writeHead(200, {
        ...headers,
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, text: heard, seconds: Number(seconds.toFixed(2)) }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("no");
  }

  /**
   * One read, passed to the daemon on loopback as a viewer.
   *
   * Whatever token the phone's page put in the address is replaced by the
   * viewer's, so the walkie token never reaches the daemon and the phone can
   * never be more than a viewer there. The event stream is piped as it comes:
   * nothing is buffered, so a card lands on the phone when it lands on the desk.
   */
  private proxy(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    url: URL,
    headers: Record<string, string>,
  ): void {
    const room = this.opts.room;
    if (!room) return;
    const q = new URLSearchParams(url.search);
    q.delete("t");
    if (q.has("token") || url.pathname === "/stream" || url.pathname === "/backdrop")
      q.set("token", room.viewer);
    const search = q.toString();
    const up = http.request(
      {
        host: "127.0.0.1",
        port: room.port,
        path: `${url.pathname}${search ? `?${search}` : ""}`,
        method: "GET",
        headers: {
          authorization: `Bearer ${room.viewer}`,
          accept: String(req.headers.accept ?? "*/*"),
        },
      },
      (r) => {
        const out: Record<string, string | string[]> = { ...headers };
        for (const [k, v] of Object.entries(r.headers)) {
          if (v === undefined || k === "set-cookie" || k === "connection") continue;
          out[k] = v;
        }
        res.writeHead(r.statusCode ?? 502, out);
        r.pipe(res);
      },
    );
    up.on("error", (e) => {
      this.log(`walkie: the room is unreachable: ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("Kikoe is not answering");
    });
    // A phone that closes the page must not leave a stream open on the daemon.
    res.on("close", () => up.destroy());
    up.end();
  }
}

/**
 * What you get without the token.
 *
 * It used to be one line of plain text, which told you what was wrong and
 * nothing about what to do — and "the link needs its token" is exactly what
 * you see when a phone drops the query string, which phones do constantly.
 */
function denied(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kik</title>
<style>
  html,body{margin:0;height:100%;background:#14100e;color:#f5f1ec;
    font:15px/1.6 "Segoe UI",system-ui,-apple-system,sans-serif;
    display:flex;align-items:center;justify-content:center;padding:28px}
  div{max-width:34ch}
  h1{font:600 19px/1.3 inherit;margin:0 0 12px}
  p{color:#8b8b80;margin:0 0 10px}
  b{color:#d2683f;font-weight:600}
</style></head><body><div>
<h1>This link is missing its token</h1>
<p>Open the <b>whole</b> link from Kikoe — Settings, then Phone. It ends in
<b>?t=</b> and a long word, and that part is what lets your phone in.</p>
<p>Phones drop it easily: tapping past the certificate warning, adding the
page to your home screen, or typing the address by hand all lose it. Use the
full link once and this phone will be remembered.</p>
</div></body></html>`;
}

/**
 * The page. One button, held.
 *
 * Deliberately one file with no build step and nothing fetched: it has to
 * work on a phone that has just been told the certificate is suspicious,
 * and every extra request is another thing to go wrong. The capture is a
 * ScriptProcessor rather than an AudioWorklet because a worklet needs its
 * own module URL, and one file is worth more here than the deprecation.
 */
function page(token: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#14100e">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Kik</title>
<style>
  :root { --ink:#14100e; --paper:#f5f1ec; --ember:#d2683f; --dim:#8b8b80; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin:0; height:100%; background:var(--ink); color:var(--paper);
    font: 15px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif;
    overscroll-behavior: none; user-select: none; -webkit-user-select: none; }
  body { display:flex; flex-direction:column; align-items:center; justify-content:center;
    gap:28px; padding: max(20px, env(safe-area-inset-top)) 20px max(20px, env(safe-area-inset-bottom)); }
  #talk { width:min(74vw,300px); aspect-ratio:1; border-radius:50%; border:none;
    background: radial-gradient(circle at 34% 30%, #e0805a, var(--ember) 62%, #8f3f22);
    color:#1a0f0a; font: 600 19px/1.2 inherit; letter-spacing:.02em;
    box-shadow: 0 18px 60px rgba(210,104,63,.28); transition: transform .12s ease, box-shadow .12s ease;
    touch-action: none; }
  #talk[data-on="1"] { transform: scale(.94); box-shadow: 0 6px 26px rgba(210,104,63,.5); }
  #talk:disabled { filter: grayscale(.7) brightness(.6); }
  #said { min-height:3.4em; max-width:34ch; text-align:center; color:var(--paper); font-size:16px; }
  #note { color:var(--dim); font-size:13px; text-align:center; max-width:32ch; min-height:2.4em; }
  .level { width:min(74vw,300px); height:3px; background:rgba(245,241,236,.12); border-radius:2px; overflow:hidden; }
  .level i { display:block; height:100%; width:0%; background:var(--ember); transition:width .08s linear; }
</style></head><body>
<button id="talk">hold to talk</button>
<div class="level"><i id="bar"></i></div>
<div id="said"></div>
<div id="note">connecting…</div>
<script>
const TOKEN = ${JSON.stringify(token)};
const RATE = ${WALKIE_RATE};
const talk = document.getElementById("talk");
const said = document.getElementById("said");
const note = document.getElementById("note");
const bar = document.getElementById("bar");
let ctx = null, stream = null, node = null, src = null;
let chunks = [], recording = false;

function say(t) { note.textContent = t; }

// The phone's microphone runs at whatever rate it likes, usually 48 kHz.
// Whisper wants 16, so we average each run of samples down rather than
// picking one: cheaper than a filter and good enough for speech.
function downsample(input, from, to) {
  if (from === to) return Float32Array.from(input);
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0, n = 0;
    for (let j = start; j < end; j++) { sum += input[j]; n++; }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

async function open() {
  if (ctx) return true;
  if (!window.isSecureContext) {
    // Clicking past the certificate warning is enough for most browsers.
    // For the ones it is not, the certificate can be installed instead,
    // and then there is no warning and no doubt.
    note.innerHTML = 'the browser will not give up the microphone here. ' +
      '<a style="color:#d2683f" href="/cert.pem?t=' + encodeURIComponent(TOKEN) + '">install the certificate</a>, ' +
      'trust it in your phone’s settings, then reload.';
    talk.disabled = true; return false;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    say("this browser will not share a microphone here");
    talk.disabled = true; return false;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    say("microphone refused: " + (e && e.name ? e.name : e));
    return false;
  }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  src = ctx.createMediaStreamSource(stream);
  node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < input.length; i++) { const v = Math.abs(input[i]); if (v > peak) peak = v; }
    bar.style.width = Math.min(100, Math.round(peak * 160)) + "%";
    if (!recording) return;
    chunks.push(downsample(input, ctx.sampleRate, RATE));
  };
  src.connect(node);
  // Chrome will not run a ScriptProcessor that goes nowhere, and a zero gain
  // keeps it running without the phone hearing itself.
  const mute = ctx.createGain(); mute.gain.value = 0;
  node.connect(mute); mute.connect(ctx.destination);
  say("hold the button and talk");
  return true;
}

function start(e) {
  if (e) e.preventDefault();
  if (!ctx || recording) return;
  if (ctx.state === "suspended") ctx.resume();
  chunks = []; recording = true;
  talk.dataset.on = "1"; talk.textContent = "listening";
  said.textContent = "";
  if (navigator.vibrate) navigator.vibrate(12);
}

async function stop(e) {
  if (e) e.preventDefault();
  if (!recording) return;
  recording = false;
  talk.dataset.on = "0"; talk.textContent = "hold to talk";
  bar.style.width = "0%";
  let total = 0; for (const c of chunks) total += c.length;
  if (total < RATE * 0.25) { say("too short"); return; }
  const pcm = new Int16Array(total);
  let i = 0;
  for (const c of chunks) for (let j = 0; j < c.length; j++) {
    const v = Math.max(-1, Math.min(1, c[j]));
    pcm[i++] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  chunks = [];
  say("sending " + (total / RATE).toFixed(1) + "s…");
  talk.disabled = true;
  try {
    const res = await fetch("/audio?t=" + encodeURIComponent(TOKEN), {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: pcm.buffer,
    });
    const j = await res.json();
    said.textContent = j.text ? "“" + j.text + "”" : "";
    say(j.text ? "sent" : (j.error || "nothing came back"));
  } catch (err) {
    say("could not reach Kikoe: " + err.message);
  } finally {
    talk.disabled = false;
  }
}

talk.addEventListener("pointerdown", async (e) => { if (await open()) start(e); });
talk.addEventListener("pointerup", stop);
talk.addEventListener("pointercancel", stop);
talk.addEventListener("pointerleave", stop);
talk.addEventListener("contextmenu", (e) => e.preventDefault());
open();
</script></body></html>`;
}
