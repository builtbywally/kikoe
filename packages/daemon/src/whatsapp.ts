/**
 * WhatsApp into Kik's inbox (KARA-PLAN phase 4), the way WhatsApp Web does
 * it: a linked device, paired by scanning a QR code with the phone.
 *
 * WhatsApp has no API for a personal account, so this uses Baileys, the
 * open-source WhatsApp Web client. It is installed the first time the user
 * turns WhatsApp on, into ~/.kikoe/bridges/whatsapp, rather than shipped:
 * a large dependency most users will never want. The bridge is a small
 * script run by the app's own node (ELECTRON_RUN_AS_NODE), talking JSON
 * lines on stdout: a QR to scan, "open", or a message. The pairing lives in
 * the bridge's auth folder and nowhere else; nothing is sent, only read.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Message } from "./life.js";

const BAILEYS = "@whiskeysockets/baileys@6.7.18";
const QRCODE = "qrcode@1.5.4";

const BRIDGE = `// Kikoe's WhatsApp bridge, written by whatsapp.ts. Reads, never sends.
const path = require("node:path");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const QR = require("qrcode");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const silent = { level: "silent", child: () => silent, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth"));
  // the protocol version WhatsApp wants today: the one a release ships with is refused (405) once it ages
  let version;
  try { version = (await fetchLatestBaileysVersion()).version; } catch {}
  const sock = makeWASocket({ ...(version ? { version } : {}), auth: state, logger: silent, browser: Browsers.windows("Kikoe"), markOnlineOnConnect: false, syncFullHistory: false });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (u) => {
    if (u.qr) out({ type: "qr", url: await QR.toDataURL(u.qr) });
    if (u.connection === "open") out({ type: "open" });
    if (u.connection === "close") {
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
      if (code === DisconnectReason.loggedOut) { out({ type: "logged-out" }); process.exit(0); }
      out({ type: "closed", code });
      setTimeout(start, 5000);
    }
  });
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const msg = m.message;
      const text = msg.conversation || (msg.extendedTextMessage && msg.extendedTextMessage.text) || (msg.imageMessage && msg.imageMessage.caption) || (msg.videoMessage && msg.videoMessage.caption) || "(a message without text)";
      out({ type: "message", id: m.key.id, chat: m.key.remoteJid, from: m.pushName || String(m.key.participant || m.key.remoteJid).split("@")[0], text, at: Number(m.messageTimestamp) * 1000 });
    }
  });
}
start().catch((e) => { out({ type: "error", message: String(e && e.message || e) }); process.exit(1); });
`;

export type WhatsAppPhase = "off" | "installing" | "starting" | "scan" | "open" | "error";

export class WhatsAppBridge {
  phase: WhatsAppPhase = "off";
  qr = "";
  detail = "";
  private child: ChildProcess | null = null;
  private stopped = true;

  constructor(
    private readonly dir: string,
    private readonly onMessage: (m: Message) => void,
    private readonly onPhase: (phase: WhatsAppPhase, qr: string, detail: string) => void,
    private readonly log: (s: string) => void = () => {},
  ) {}

  private set(phase: WhatsAppPhase, detail = ""): void {
    this.phase = phase;
    this.detail = detail;
    if (phase !== "scan") this.qr = "";
    this.onPhase(phase, this.qr, detail);
  }

  /** Install Baileys if needed, then run the bridge. Safe to call twice. */
  async start(): Promise<void> {
    if (this.child) return;
    this.stopped = false;
    try {
      mkdirSync(this.dir, { recursive: true });
      if (!existsSync(path.join(this.dir, "node_modules", "@whiskeysockets", "baileys"))) {
        this.set("installing");
        writeFileSync(
          path.join(this.dir, "package.json"),
          '{"name":"kikoe-whatsapp","private":true}',
        );
        await new Promise<void>((resolve, reject) =>
          execFile(
            process.platform === "win32" ? "npm.cmd" : "npm",
            ["install", BAILEYS, QRCODE, "--no-audit", "--no-fund", "--loglevel=error"],
            {
              cwd: this.dir,
              windowsHide: true,
              shell: process.platform === "win32",
              timeout: 10 * 60_000,
            },
            (err, _o, stderr) =>
              err ? reject(new Error(String(stderr || err.message).slice(0, 300))) : resolve(),
          ),
        );
      }
      writeFileSync(path.join(this.dir, "bridge.cjs"), BRIDGE);
    } catch (e) {
      this.set("error", `could not install the bridge: ${(e as Error).message}`);
      return;
    }
    if (this.stopped) return;
    this.set("starting");
    // the app's own node: Electron run as node, or node itself in a test
    const child = spawn(process.execPath, [path.join(this.dir, "bridge.cjs")], {
      cwd: this.dir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += String(d);
      let i = buf.indexOf("\n");
      while (i >= 0) {
        this.line(buf.slice(0, i));
        buf = buf.slice(i + 1);
        i = buf.indexOf("\n");
      }
    });
    child.stderr?.on("data", (d: Buffer) =>
      this.log(`whatsapp: ${String(d).trim().slice(0, 200)}`),
    );
    child.on("exit", (code) => {
      this.child = null;
      if (this.stopped) return this.set("off");
      if (this.phase !== "error") this.set("error", `the bridge stopped (${code})`);
    });
  }

  private line(l: string): void {
    let o: {
      type?: string;
      url?: string;
      id?: string;
      chat?: string;
      from?: string;
      text?: string;
      at?: number;
      message?: string;
    };
    try {
      o = JSON.parse(l);
    } catch {
      return;
    }
    if (o.type === "qr" && o.url) {
      this.qr = o.url;
      this.set("scan");
    } else if (o.type === "open") {
      this.set("open");
      this.log("whatsapp: linked");
    } else if (o.type === "logged-out")
      this.set("error", "unlinked from the phone; turn it off and on to pair again");
    else if (o.type === "error") this.set("error", String(o.message ?? ""));
    else if (o.type === "message" && o.id)
      this.onMessage({
        id: `whatsapp:${o.chat}:${o.id}`,
        source: "whatsapp",
        from: String(o.from ?? "someone"),
        text: String(o.text ?? ""),
        at: Number(o.at) || Date.now(),
      });
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
    this.set("off");
  }
}
