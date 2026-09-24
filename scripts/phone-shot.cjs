// Loads the walkie's canvas the way a phone would (390x844, touch, a phone
// user agent) and writes a PNG. The certificate is self-signed on purpose,
// so it is accepted here, for this check only. The address comes through
// the environment: Electron refuses to start with a URL on its command line.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");

const url = process.env.SHOT_URL;
const out = process.env.SHOT_OUT;
const logFile = `${out}.log`;
fs.writeFileSync(logFile, "");
const note = (...a) => fs.appendFileSync(logFile, `${a.join(" ")}\n`);

app.commandLine.appendSwitch("ignore-certificate-errors");
app.disableHardwareAcceleration();
app.on("certificate-error", (e, _wc, _u, _err, _cert, cb) => {
  e.preventDefault();
  cb(true);
});

async function capture(w) {
  try {
    const status = await w.webContents.executeJavaScript(
      "JSON.stringify({href: location.pathname + location.search, phone: document.documentElement.dataset.phone, readonly: document.documentElement.dataset.readonly, pins: document.querySelectorAll('.pin').length, talk: !!document.getElementById('phone-talk'), status: document.getElementById('tb-status')?.textContent})",
    );
    note("page:", status);
    const img = await w.webContents.capturePage();
    fs.writeFileSync(out, img.toPNG());
    note("wrote", out);
  } catch (e) {
    note("capture failed:", e?.stack || e);
  }
  app.exit(0);
}

app.whenReady().then(() => {
  note("ready");
  const w = new BrowserWindow({ width: 390, height: 844, show: false });
  w.webContents.setUserAgent(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  );
  w.webContents.on("console-message", (_e, level, msg) => {
    if (level >= 2) note("console:", msg);
  });
  w.webContents.on("did-fail-load", (_e, code, desc) => note("failed to load:", code, desc));
  w.webContents.on("did-finish-load", () => note("loaded"));
  w.loadURL(url).catch((e) => note("loadURL:", e?.message || e));
  // Whatever is on screen after eight seconds: the stream never "finishes".
  setTimeout(() => capture(w), 8000);
});
