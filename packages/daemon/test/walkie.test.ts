/**
 * The walkie-talkie: the phone as a microphone.
 *
 * The things worth pinning here are the ones that would be quiet failures:
 * the token actually gating a server that is on the network rather than on
 * loopback, the audio arriving as the PCM the recognizer wants, and a long
 * press not being able to post a hundred megabytes.
 */

import { mkdtempSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-walkie-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let mod: typeof import("../src/walkie.js");
let walkie: InstanceType<typeof import("../src/walkie.js").Walkie>;
const PORT = 4700 + Math.floor(Math.random() * 200);
const TOKEN = "w-test-token";
let got: Int16Array | null = null;

function req(
  p: string,
  opts: { method?: string; body?: Buffer; auth?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: p,
        method: opts.method ?? "GET",
        // It is self-signed by design; that is the thing under test elsewhere.
        rejectUnauthorized: false,
        headers: opts.auth ? { authorization: opts.auth } : {},
      },
      (res) => {
        let out = "";
        res.on("data", (c) => {
          out += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out }));
      },
    );
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

beforeAll(async () => {
  mod = await import("../src/walkie.js");
  walkie = new mod.Walkie({
    port: PORT,
    token: TOKEN,
    onAudio: (pcm) => {
      got = pcm;
      return "switch to marine";
    },
  });
  await walkie.start();
}, 30_000);

afterAll(async () => {
  await walkie.stop();
});

describe("the certificate", () => {
  it("is made once and kept, so the phone is only warned once", async () => {
    const a = await mod.ensureCert(["10.0.0.5"]);
    const b = await mod.ensureCert(["10.0.0.5"]);
    expect(a.cert).toContain("BEGIN CERTIFICATE");
    expect(b.cert).toBe(a.cert);
  }, 30_000);

  it("is made again when the machine answers on an address it does not name", async () => {
    const a = await mod.ensureCert(["10.0.0.5"]);
    const b = await mod.ensureCert(["10.0.0.5", "192.168.9.9"]);
    expect(b.cert).not.toBe(a.cert);
  }, 30_000);
});

describe("the server", () => {
  it("refuses without the token, on every route", async () => {
    expect((await req("/")).status).toBe(401);
    expect((await req("/audio", { method: "POST", body: Buffer.alloc(4) })).status).toBe(401);
    expect((await req("/?t=wrong")).status).toBe(401);
  });

  it("takes the token in the link or in a header", async () => {
    expect((await req(`/?t=${TOKEN}`)).status).toBe(200);
    expect((await req("/", { auth: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it("serves one page that needs nothing else to load", async () => {
    const r = await req(`/?t=${TOKEN}`);
    expect(r.body).toContain("hold to talk");
    expect(r.body).toContain("getUserMedia");
    // No build step, no CDN: it has to work on a phone that has just been
    // told this certificate is suspicious.
    expect(r.body).not.toMatch(/<script[^>]+src=/);
    expect(r.body).not.toMatch(/<link[^>]+href=/);
  });

  it("says out loud when it is not a secure context, instead of failing silently", async () => {
    const r = await req(`/?t=${TOKEN}`);
    expect(r.body).toContain("isSecureContext");
  });

  it("takes raw PCM and hands back what was heard", async () => {
    // half a second of 16 kHz mono, as the page would send it
    const pcm = new Int16Array(mod.WALKIE_RATE / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(3000 * Math.sin(i / 12));
    const body = Buffer.from(pcm.buffer);
    const r = await req(`/audio?t=${TOKEN}`, { method: "POST", body });
    expect(r.status).toBe(200);
    const j = JSON.parse(r.body);
    expect(j.text).toBe("switch to marine");
    expect(j.seconds).toBeCloseTo(0.5, 1);
    expect(got?.length).toBe(pcm.length);
    expect(got?.[10]).toBe(pcm[10]);
  });

  it("refuses a clip longer than a held button could be", async () => {
    const tooMuch = Buffer.alloc(mod.WALKIE_RATE * 2 * (mod.MAX_CLIP_S + 5));
    const r = await req(`/audio?t=${TOKEN}`, { method: "POST", body: tooMuch });
    expect(r.status).toBe(413);
  });

  it("gives a link with the token already in it", () => {
    for (const u of walkie.urls()) {
      expect(u).toContain(`:${PORT}/`);
      expect(u).toContain(encodeURIComponent(TOKEN));
      expect(u.startsWith("https://")).toBe(true);
    }
  });

  it("closes the socket when it stops, rather than merely ignoring it", async () => {
    await walkie.stop();
    expect(walkie.running).toBe(false);
    await expect(req(`/?t=${TOKEN}`)).rejects.toThrow();
    await walkie.start();
    expect((await req(`/?t=${TOKEN}`)).status).toBe(200);
  }, 30_000);
});
