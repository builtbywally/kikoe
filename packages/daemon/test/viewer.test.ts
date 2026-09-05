import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-viewer-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let mod: typeof import("../src/daemon.js");
let cfg: typeof import("../src/config.js");
let d: InstanceType<typeof import("../src/daemon.js").Daemon>;
let port = 0;

function call(
  method: string,
  p: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (c) => {
          out += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

beforeAll(async () => {
  mod = await import("../src/daemon.js");
  cfg = await import("../src/config.js");
  d = new mod.Daemon({ audio: false, settings: { ...cfg.DEFAULTS, tts: "none", port: 0 } });
  // pick a free port
  port = 4700 + Math.floor(Math.random() * 200);
  await d.listen(port);
});
afterAll(async () => {
  await d.close();
});

describe("the viewer token", () => {
  it("can watch", async () => {
    expect((await call("GET", "/state", d.viewer)).status).toBe(200);
    expect((await call("GET", "/pins", d.viewer)).status).toBe(200);
  });
  it("cannot act", async () => {
    expect((await call("POST", "/speak", d.viewer, { text: "hi" })).status).toBe(403);
    expect((await call("POST", "/answer", d.viewer, { word: "yes" })).status).toBe(403);
    expect((await call("POST", "/pins/clear", d.viewer)).status).toBe(403);
    expect((await call("POST", "/permission", d.viewer, { allow: true })).status).toBe(403);
  });
  it("a wrong token is refused outright, the full token can act", async () => {
    expect((await call("GET", "/state", "nope")).status).toBe(401);
    expect((await call("POST", "/pins/clear", d.token)).status).toBe(200);
  });
});
