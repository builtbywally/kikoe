// A small driver for headless Chrome over the DevTools protocol: open a page
// at a size, wait, evaluate, and capture elements. No puppeteer; Node's own
// WebSocket. Used by scripts/readme-images.mjs.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME ??
  (process.platform === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "google-chrome");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openBrowser(port = 9333) {
  const profile = await mkdtemp(join(tmpdir(), "kikoe-cdp-"));
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--hide-scrollbars",
      "--no-first-run",
      "--force-device-scale-factor=2",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let targets;
  for (let i = 0; i < 50; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.some((t) => t.type === "page")) break;
    } catch {}
    await sleep(200);
  }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  const api = {
    send,
    async size(width, height, mobile = false) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 2,
        mobile,
      });
    },
    async goto(url, wait = 2500) {
      await send("Page.enable");
      await send("Page.navigate", { url });
      await sleep(wait);
    },
    async eval(expression) {
      const r = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      return r.result.value;
    },
    /** A PNG of the element matching the selector, as a Buffer. */
    async shot(selector, pad = 0) {
      const box = await api.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
      })()`);
      await sleep(900);
      const r = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: {
          x: box.x - pad,
          y: box.y - pad,
          width: box.w + pad * 2,
          height: box.h + pad * 2,
          scale: 1,
        },
      });
      return Buffer.from(r.data, "base64");
    },
    sleep,
    async close() {
      ws.close();
      proc.kill();
      await sleep(300);
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
  return api;
}
