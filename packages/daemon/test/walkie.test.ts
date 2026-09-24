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
  opts: { method?: string; body?: Buffer; auth?: string; cookie?: string } = {},
): Promise<{ status: number; body: string; cookie: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.auth) headers.authorization = opts.auth;
    if (opts.cookie) headers.cookie = opts.cookie;
    const r = https.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: p,
        method: opts.method ?? "GET",
        // It is self-signed by design; that is the thing under test elsewhere.
        rejectUnauthorized: false,
        headers,
      },
      (res) => {
        let out = "";
        res.on("data", (c) => {
          out += c;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: out,
            cookie: String(res.headers["set-cookie"]?.[0] ?? ""),
          }),
        );
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

  it("remembers a phone that arrived with the full link", async () => {
    // The bug: a phone drops the query string when you tap past the
    // certificate warning, reload, or add the page to the home screen, and
    // every visit after that said "the link needs its token".
    const first = await req(`/?t=${TOKEN}`);
    expect(first.status).toBe(200);
    expect(first.cookie).toContain(`${mod.COOKIE}=${TOKEN}`);
    expect(first.cookie).toContain("HttpOnly");
    expect(first.cookie).toContain("Secure");

    const cookie = first.cookie.split(";")[0] ?? "";
    // now the bare address works, which is the address a phone actually keeps
    expect((await req("/", { cookie })).status).toBe(200);
    expect((await req("/audio", { method: "POST", body: Buffer.alloc(4), cookie })).status).toBe(
      200,
    );
  });

  it("does not hand the cookie to someone who never had the token", async () => {
    const r = await req("/");
    expect(r.status).toBe(401);
    expect(r.cookie).toBe("");
    expect((await req("/", { cookie: `${mod.COOKIE}=guess` })).status).toBe(401);
  });

  it("says what to do when the token is missing, not just that it is", async () => {
    const r = await req("/");
    expect(r.body).toContain("Settings");
    expect(r.body).toContain("?t=");
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

describe("the canvas on the phone", () => {
  const PHONE = PORT + 211;
  const VIEWER = "v-viewer-token";
  // A stand-in for the daemon: records what reached it and as whom.
  const seen: Array<{ method: string; path: string; auth: string }> = [];
  let fakeDaemon: import("node:http").Server;
  let phone: InstanceType<typeof import("../src/walkie.js").Walkie>;
  const typed: string[] = [];

  function get(
    p: string,
    opts: { method?: string; body?: string; cookie?: string } = {},
  ): Promise<{ status: number; body: string; location: string; type: string }> {
    return new Promise((resolve, reject) => {
      const r = https.request(
        {
          host: "127.0.0.1",
          port: PHONE,
          path: p,
          method: opts.method ?? "GET",
          rejectUnauthorized: false,
          headers: {
            cookie: opts.cookie ?? `${mod.COOKIE}=${TOKEN}`,
            ...(opts.body ? { "content-type": "application/json" } : {}),
          },
        },
        (res) => {
          let out = "";
          res.on("data", (c) => {
            out += c;
            // an event stream never ends; the first event is enough
            if (String(res.headers["content-type"]).includes("event-stream")) {
              res.destroy();
              resolve({
                status: res.statusCode ?? 0,
                body: out,
                location: "",
                type: "event-stream",
              });
            }
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: out,
              location: String(res.headers.location ?? ""),
              type: String(res.headers["content-type"] ?? ""),
            }),
          );
        },
      );
      r.on("error", reject);
      if (opts.body) r.write(opts.body);
      r.end();
    });
  }

  beforeAll(async () => {
    const http = await import("node:http");
    fakeDaemon = http.createServer((q, s) => {
      seen.push({
        method: q.method ?? "",
        path: q.url ?? "",
        auth: String(q.headers.authorization),
      });
      if (q.url?.startsWith("/stream")) {
        s.writeHead(200, { "content-type": "text/event-stream" });
        s.write('data: {"type":"hello"}\n\n');
        return;
      }
      s.writeHead(200, { "content-type": "application/json" });
      s.end(JSON.stringify({ path: q.url }));
    });
    await new Promise<void>((r) => fakeDaemon.listen(0, "127.0.0.1", () => r()));
    const addr = fakeDaemon.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    phone = new mod.Walkie({
      port: PHONE,
      token: TOKEN,
      onAudio: () => "",
      onText: (t) => {
        typed.push(t);
        return "chat";
      },
      room: { port, viewer: VIEWER },
    });
    await phone.start();
  }, 30_000);

  afterAll(async () => {
    await phone.stop();
    await new Promise<void>((r) => fakeDaemon.close(() => r()));
  });

  it("opens on the canvas, not the bare button", async () => {
    const r = await get(`/?t=${TOKEN}`);
    expect(r.status).toBe(302);
    expect(r.location).toBe("/room/?phone=1");
    // the button alone is still there
    expect((await get("/talk")).body).toContain("hold to talk");
  });

  it("reads from the daemon as a viewer, never with the walkie token", async () => {
    seen.length = 0;
    const r = await get("/state");
    expect(r.status).toBe(200);
    expect(seen[0]?.auth).toBe(`Bearer ${VIEWER}`);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });

  it("swaps whatever token the page sent for the viewer's on the live stream", async () => {
    seen.length = 0;
    const r = await get(`/stream?token=${TOKEN}&t=${TOKEN}`);
    expect(r.body).toContain("hello");
    expect(seen[0]?.path).toBe(`/stream?token=${VIEWER}`);
  });

  it("passes on nothing that acts", async () => {
    seen.length = 0;
    for (const p of ["/pins/abc/answer", "/pins/clear", "/answer", "/speak", "/show"])
      expect((await get(p, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await get("/hook/claude")).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("lets nobody in without the token, canvas included", async () => {
    seen.length = 0;
    expect((await get("/room/", { cookie: "" })).status).toBe(401);
    expect((await get("/state", { cookie: "" })).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("takes a typed sentence the way it takes a spoken one", async () => {
    const r = await get("/say", {
      method: "POST",
      body: JSON.stringify({ text: "what's it doing" }),
    });
    expect(r.status).toBe(200);
    expect(typed).toContain("what's it doing");
  });

  it("plays Kik's voice to a phone that listens, and stops it when Kik is cut off", async () => {
    const events: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const r = https.request(
        {
          host: "127.0.0.1",
          port: PHONE,
          path: "/voice",
          rejectUnauthorized: false,
          headers: { cookie: `${mod.COOKIE}=${TOKEN}` },
        },
        (res) => {
          expect(String(res.headers["content-type"])).toContain("event-stream");
          res.on("data", (c) => {
            events.push(String(c));
            if (events.join("").includes("event: drop")) {
              res.destroy();
              resolve();
            }
          });
        },
      );
      r.on("error", reject);
      r.end();
    });
    // wait until the phone is counted, then speak
    for (let i = 0; i < 50 && phone.listeners === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(phone.listeners).toBe(1);
    phone.voice(new Float32Array([0, 0.5, -0.5, 1]), 22050);
    phone.voiceDrop();
    await done;
    const all = events.join("");
    expect(all).toContain('"r":22050');
    // four samples of 16-bit PCM, in base64
    const b = /"b":"([^"]+)"/.exec(all)?.[1] ?? "";
    expect(Buffer.from(b, "base64").length).toBe(8);
  });

  it("costs nothing when nobody listens", () => {
    // no phone attached: nothing is encoded, nothing thrown
    expect(() => phone.voice(new Float32Array(48000), 48000)).not.toThrow();
  });

  it("still turns off with a phone listening, instead of waiting on it for ever", async () => {
    await new Promise<void>((resolve) => {
      const r = https.request(
        {
          host: "127.0.0.1",
          port: PHONE,
          path: "/voice",
          rejectUnauthorized: false,
          headers: { cookie: `${mod.COOKIE}=${TOKEN}` },
        },
        (res) => {
          res.on("data", () => resolve());
          res.on("error", () => {});
        },
      );
      r.on("error", () => {});
      r.end();
    });
    await phone.stop();
    expect(phone.running).toBe(false);
    expect(phone.listeners).toBe(0);
    await phone.start();
  }, 15_000);

  it("serves the room and its artifacts through the same door", async () => {
    seen.length = 0;
    await get("/room/index.html?phone=1");
    await get("/artifact/p123");
    expect(seen.map((s) => s.path.split("?")[0])).toEqual(["/room/index.html", "/artifact/p123"]);
  });

  it("serves the backdrop the Room asks for, which lives outside /room/", async () => {
    // It asks for ../backdrops/, and until 2026-09-24 the phone got a 404 and
    // a background that came and went.
    seen.length = 0;
    await get("/backdrops/aurora-dark-small.jpg");
    expect(seen.map((s) => s.path)).toEqual(["/backdrops/aurora-dark-small.jpg"]);
    expect(mod.proxiable("/backdrops/aurora-dark.jpg")).toBe(true);
  });
});
