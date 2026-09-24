/**
 * The app. Electron is Node, so the daemon runs right here in the main
 * process: no bundled interpreter, no sidecar, no IPC to a foreign runtime.
 *
 *   main process
 *   ├── daemon      hook endpoint on 127.0.0.1, narrator, arbiter, TTS, audio
 *   ├── tray        mode, pause, settings, doctor, quit
 *   ├── island      the pill: click-through, display only
 *   └── settings    voice, hooks, sessions, doctor; also the first-run flow
 */

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  Daemon,
  HOME,
  KOKORO,
  MODELS,
  type Settings,
  Supervisor,
  VERSION,
  WHISPER_BASE,
  WHISPER_TINY,
  anthropicKeyFromFile,
  crashSource,
  elevenKeyFromFile,
  fetchModel,
  fetchVad,
  hasCurl,
  hookStatus,
  installHooks,
  listOutputDevices,
  loadSettings,
  log,
  modelInstalled,
  openrouterKeyFromFile,
  probe,
  removeModel,
  saveSettings,
  settingsPath,
  uninstallHooks,
  withKit,
} from "@kikoe/daemon";
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  safeStorage,
  screen,
  shell,
  utilityProcess,
} from "electron";

const RENDERER = path.join(__dirname, "..", "renderer");
const RESOURCES = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
process.env.KIKOE_PIPER_DIR ??= path.join(RESOURCES, "models", "vits-piper-en_GB-alan-medium");

let daemon: Daemon | null = null;
let tray: Tray | null = null;
let island: BrowserWindow | null = null;
let roomWin: BrowserWindow | null = null;
let ear: Electron.UtilityProcess | null = null;
let paused = false;
let pauseTimer: NodeJS.Timeout | null = null;
let restarts = 0;
let lastCrash = "";
let downloading: { name: string; received: number; total: number; phase: string } | null = null;
const smoke = process.argv.includes("--smoke");
const shotIndex = process.argv.indexOf("--screenshot");
const shotPath = shotIndex >= 0 ? (process.argv[shotIndex + 1] ?? "") : "";
const noAudio = process.argv.includes("--no-audio") || smoke || Boolean(shotPath);

// --- the key, in the keychain ----------------------------------------------

const KEY_FILE = () => path.join(HOME, "elevenlabs_key.enc");

function loadElevenKey(): string {
  try {
    if (existsSync(KEY_FILE()) && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(readFileSync(KEY_FILE())).trim();
    }
  } catch {
    /* fall through to the developer file */
  }
  return elevenKeyFromFile();
}

function saveElevenKey(key: string): void {
  mkdirSync(HOME, { recursive: true });
  if (!key) {
    try {
      writeFileSync(KEY_FILE(), Buffer.alloc(0));
    } catch {
      /* ignore */
    }
    return;
  }
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("the OS keychain is not available on this machine");
  writeFileSync(KEY_FILE(), safeStorage.encryptString(key), { mode: 0o600 });
}

const ANTHROPIC_FILE = () => path.join(HOME, "anthropic_key.enc");

function loadAnthropicKey(): string {
  try {
    if (existsSync(ANTHROPIC_FILE()) && safeStorage.isEncryptionAvailable()) {
      const k = safeStorage.decryptString(readFileSync(ANTHROPIC_FILE())).trim();
      if (k) return k;
    }
  } catch {
    /* fall through to the developer file */
  }
  return anthropicKeyFromFile();
}

function saveAnthropicKey(key: string): void {
  mkdirSync(HOME, { recursive: true });
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("the OS keychain is not available on this machine");
  writeFileSync(ANTHROPIC_FILE(), key ? safeStorage.encryptString(key) : Buffer.alloc(0), {
    mode: 0o600,
  });
}

// --- daemon -----------------------------------------------------------------

async function startDaemon(): Promise<void> {
  const settings = loadSettings();
  daemon = new Daemon({
    settings,
    audio: !noAudio,
    elevenKey: loadElevenKey(),
    anthropicKey: loadAnthropicKey(),
    openrouterKey: openrouterKeyFromFile(),
    persistBoard: !smoke && !shotPath,
    roomDir: path.join(RENDERER, "room"),
  });
  await daemon.listen();
  // The phone speaks through the ear that is already loaded.
  daemon.transcribe = transcribeWithEar;
  daemon.onMicReady = () => earKeeper.ready();
  if (!smoke && !shotPath) await daemon.syncWalkie();
  daemon.hub.listen((frame) => {
    if (frame.type === "speech")
      updateTrayTitle(String(frame.phase) === "speaking" ? String(frame.text ?? "") : "");
    if (frame.type === "event" && frame.kind === "permission") toastIfQuiet(frame);
  });
}

async function restartDaemon(reason = "settings"): Promise<void> {
  restarts++;
  log(`daemon restart (${reason})`);
  try {
    if (daemon) await Promise.race([daemon.close(), new Promise((r) => setTimeout(r, 3000))]);
  } catch {
    /* it was already broken */
  }
  daemon = null;
  await startDaemon();
  island?.webContents.send("island:reconnect");
  roomWin?.webContents.send("island:reconnect");
}

/**
 * A daemon exception is not an app crash. Log it, count it, restart the
 * daemon in place, show it in doctor. Three crashes in a minute stop the
 * quick retries so a broken machine does not loop the speaker.
 *
 * Gate 2 of docs/OS.md: giving up used to be a line in a log file, the one
 * moment the user most needed telling; and every uncaught error in the
 * process restarted the daemon, the app's own included. Now an app error is
 * logged and left alone, and a daemon that gives up says so — through the
 * system voice, since its own is the thing that stopped — shows a
 * notification that restarts it, and tries once more a minute later.
 */
let crashTimes: number[] = [];
let cooling: NodeJS.Timeout | null = null;
function onCrash(kind: string, err: unknown): void {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const source = crashSource(err);
  lastCrash = `${new Date().toISOString()} ${kind} (${source}): ${msg.slice(0, 400)}`;
  log(`CRASH ${kind} in the ${source}: ${msg}`);
  // The app's own mistake: restarting the daemon would not fix it, and would
  // cut off whatever Kik was saying for nothing.
  if (source === "app") return;
  const now = Date.now();
  crashTimes = crashTimes.filter((t) => now - t < 60_000);
  crashTimes.push(now);
  if (crashTimes.length > 2) {
    log("too many crashes in a minute; the daemon is down, trying again in a minute");
    daemonDown();
    if (!cooling)
      cooling = setTimeout(() => {
        cooling = null;
        crashTimes = [];
        void restartDaemon("after cooling off");
      }, 60_000);
    return;
  }
  void restartDaemon("crash");
}

/** Say and show that Kikoe has stopped, without the daemon that stopped. */
function daemonDown(): void {
  const line = "Kikoe has stopped working. I'll try again in a minute.";
  if (Notification.isSupported()) {
    const n = new Notification({
      title: "Kikoe stopped",
      body: "It crashed three times in a minute. Click to start it now.",
    });
    n.on("click", () => {
      crashTimes = [];
      void restartDaemon("from the notification");
    });
    n.show();
  }
  if (noAudio) return;
  // A fixed sentence, no user text: nothing here needs quoting beyond this.
  if (process.platform === "win32")
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${line.replace(/'/g, "''")}')`,
      ],
      { windowsHide: true },
      () => {},
    );
  else if (process.platform === "darwin") execFile("say", [line], () => {});
}
process.on("uncaughtException", (e) => onCrash("uncaughtException", e));
process.on("unhandledRejection", (e) => onCrash("unhandledRejection", e));

/** Paused or silent, a permission still needs you: an OS notification carries it. */
function toastIfQuiet(frame: Record<string, unknown>): void {
  if (!daemon) return;
  const quiet = paused || daemon.narrator.mode === "silent";
  if (!quiet || !Notification.isSupported()) return;
  const args = (frame.args ?? {}) as Record<string, string>;
  const what = args.command || args.file_path || String(frame.text ?? "") || "a tool call";
  const n = new Notification({
    title: `${frame.repo || "Claude Code"} needs you`,
    body: what.slice(0, 160),
    silent: true,
  });
  n.on("click", () => {
    openRoom();
    roomWin?.webContents.send("room:view", { view: "control" });
  });
  n.show();
}

// --- the ear -----------------------------------------------------------------

/**
 * The ear is kept up, not just started: an exit nobody asked for is a crash,
 * and the supervisor starts it again with backoff and says so aloud
 * (docs/OS.md, gate 1). Before this, a crash was a word in /state and voice
 * input was simply over until someone noticed.
 */
const earKeeper = new Supervisor({
  name: "mic",
  start: spawnEar,
  say: (line) => daemon?.say(line, 3, "head"),
  log,
  lines: {
    lost: "I lost the mic. Back in a second.",
    failing: "I can't hear you: the mic keeps failing. Settings, Doctor says why.",
    back: "I can hear you again.",
  },
});

/** Turn the ear on, and keep it on. */
async function startEar(): Promise<void> {
  if (ear || !daemon) return;
  if (!loadSettings().mic) return;
  await earKeeper.want();
}

/** The mic runs in its own process so a transcription never stalls a window. */
async function spawnEar(): Promise<void> {
  if (ear || !daemon) return;
  const s = loadSettings();
  if (!s.mic) return;
  daemon.micPhase = "starting";
  // The ear's models come on demand, the first time it is turned on.
  try {
    await fetchVad();
    const spec = s.stt_model === "base" ? WHISPER_BASE : WHISPER_TINY;
    if (!modelInstalled(spec)) {
      daemon.micPhase = "downloading the speech model";
      await fetchModel(spec, (p) => {
        downloading = { name: spec.name, ...p };
        roomWin?.webContents.send("settings:progress", downloading);
      });
      downloading = null;
      roomWin?.webContents.send("settings:progress", null);
    }
  } catch (e) {
    daemon.micPhase = `dead: ${(e as Error).message}`;
    log(`ear models: ${(e as Error).message}`);
    // a failure like any other: the supervisor tries again later
    throw e;
  }
  const child = utilityProcess.fork(path.join(__dirname, "mic.js"), [], {
    serviceName: "kikoe-mic",
    stdio: "pipe",
    env: {
      ...process.env,
      KIKOE_PORT: String(daemon.settings.port),
      KIKOE_TOKEN: daemon.token,
      KIKOE_MODELS: MODELS,
      KIKOE_MIC_DEVICE: s.mic_device,
      KIKOE_STT_MODEL: s.stt_model,
    },
  });
  ear = child;
  child.stderr?.on("data", (d: Buffer) => log(String(d).trim()));
  // The phone's audio goes to the ear that is already running rather than a
  // second copy of Whisper: one recognizer, two sources.
  child.on("message", (m: { type?: string; id?: number; text?: string }) => {
    if (m?.type !== "clip" || typeof m.id !== "number") return;
    const waiting = clipWaiters.get(m.id);
    if (!waiting) return;
    clipWaiters.delete(m.id);
    waiting(String(m.text ?? ""));
  });
  child.on("exit", (code) => {
    log(`mic process exited ${code}`);
    // An ear stopped for a settings change can exit after its replacement has
    // started; that exit is about a process nobody wants any more.
    if (ear !== child) return;
    ear = null;
    if (daemon) daemon.micPhase = code === 0 ? "off" : "dead";
    // Anything still waiting on the ear will never be answered now.
    for (const [, resolve] of clipWaiters) resolve("");
    clipWaiters.clear();
    buildTrayMenu();
    // Wanted and gone is a crash: the supervisor brings it back.
    earKeeper.exited(code);
  });
  buildTrayMenu();
}

/** Clips sent to the ear, waiting for their text back. */
const clipWaiters = new Map<number, (text: string) => void>();
let clipId = 0;

/** Hand a clip to the ear and wait for what it heard. */
function transcribeWithEar(pcm: Int16Array): Promise<string> {
  if (!ear) return Promise.resolve("");
  const id = ++clipId;
  return new Promise<string>((resolve) => {
    const done = (t: string) => {
      clearTimeout(timer);
      resolve(t);
    };
    // A minute of audio decodes in a few seconds; anything past this is the
    // ear having died mid-clip, and a walkie that hangs is worse than one
    // that says it heard nothing.
    const timer = setTimeout(() => {
      clipWaiters.delete(id);
      resolve("");
    }, 60_000);
    clipWaiters.set(id, done);
    // Structured clone carries a typed array as itself; a minute of speech
    // as a plain array would be a million numbers to serialise.
    ear?.postMessage({ type: "clip", id, pcm });
  });
}

function stopEar(): void {
  // released first, so the exit that follows is not taken for a crash
  earKeeper.release();
  if (!ear) return;
  ear.kill();
  ear = null;
  if (daemon) daemon.micPhase = "off";
  buildTrayMenu();
}

// --- windows ----------------------------------------------------------------

const ISLAND_W = 720;
const ISLAND_H = 320;
const TOP_MARGIN = 10;

function createIsland(): void {
  const { x, y, width } = screen.getPrimaryDisplay().workArea;
  island = new BrowserWindow({
    width: ISLAND_W,
    height: ISLAND_H,
    x: Math.round(x + (width - ISLAND_W) / 2),
    y: y + TOP_MARGIN,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    show: !smoke,
    webPreferences: {
      preload: path.join(__dirname, "preload-island.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  island.setAlwaysOnTop(true, "screen-saver");
  island.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  island.setIgnoreMouseEvents(true, { forward: true });
  island.loadFile(path.join(RENDERER, "island", "index.html"));
  island.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  island.on("closed", () => {
    island = null;
  });
}

function openSettings(page = ""): void {
  // Settings live inside the Kikoe window, as a view beside the Room.
  openRoom();
  const send = () => roomWin?.webContents.send("room:view", { view: "settings", page });
  if (roomWin?.webContents.isLoading()) roomWin.webContents.once("did-finish-load", send);
  else send();
}

/**
 * The Room: the voice-first control room. The one Kikoe window, dark, that
 * can live full screen on a second monitor. It shows the spoken line, the
 * orb, the agents, and the board the agent pins things to; the Control Room
 * and settings are views inside it.
 */
function openRoom(): void {
  if (roomWin) {
    roomWin.show();
    roomWin.focus();
    return;
  }
  roomWin = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: "Kikoe",
    backgroundColor: "#14100e",
    show: false,
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#14100e", symbolColor: "#f5f1ec", height: 36 },

    webPreferences: {
      preload: path.join(__dirname, "preload-room.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // A web card is an iframe. Sites that forbid framing would show a blank
  // card, so for subframes only, those headers are dropped. The frame is
  // still sandboxed and cross-origin: it cannot reach the Room.
  roomWin.webContents.session.webRequest.onHeadersReceived(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      if (details.resourceType !== "subFrame") return callback({});
      const headers: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(details.responseHeaders ?? {})) {
        const key = k.toLowerCase();
        if (key === "x-frame-options") continue;
        headers[k] =
          key === "content-security-policy"
            ? v.map((line) => line.replace(/frame-ancestors[^;]*;?/gi, ""))
            : v;
      }
      callback({ responseHeaders: headers });
    },
  );
  applyTheme(loadSettings().theme);
  roomWin.loadFile(path.join(RENDERER, "room", "index.html"));
  roomWin.once("ready-to-show", () => roomWin?.show());
  // The island is presence for when the Room is not in front of you. When the
  // Room fills the screen it is the same orb twice, and the pill sits on top
  // of the thing it is reporting on, so it stands down until you look away.
  const sync = () => syncIsland();
  roomWin.on("focus", sync);
  roomWin.on("blur", sync);
  roomWin.on("maximize", sync);
  roomWin.on("unmaximize", sync);
  roomWin.on("enter-full-screen", sync);
  roomWin.on("leave-full-screen", sync);
  roomWin.on("minimize", sync);
  roomWin.on("restore", sync);
  roomWin.on("show", sync);
  roomWin.on("hide", sync);
  roomWin.on("closed", () => {
    roomWin = null;
    syncIsland();
  });
  syncIsland();
}

/** The user said "hide the island" in the tray; nothing automatic overrules that. */
let islandHiddenByHand = false;

/** Is the Room in front of you and filling the screen? */
function roomOwnsTheScreen(): boolean {
  if (!roomWin || roomWin.isDestroyed()) return false;
  if (!roomWin.isVisible() || roomWin.isMinimized()) return false;
  if (!roomWin.isFocused()) return false;
  return roomWin.isMaximized() || roomWin.isFullScreen();
}

function syncIsland(): void {
  if (!island || island.isDestroyed()) return;
  const shouldShow = !islandHiddenByHand && !roomOwnsTheScreen();
  if (shouldShow && !island.isVisible()) island.showInactive();
  else if (!shouldShow && island.isVisible()) island.hide();
}

// --- tray -------------------------------------------------------------------

function trayIcon(): Electron.NativeImage {
  const file = path.join(
    RESOURCES,
    "build",
    process.platform === "darwin" ? "trayTemplate.png" : "icon.png",
  );
  const img = nativeImage.createFromPath(file);
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 18, height: 18 });
}

function updateTrayTitle(text: string): void {
  if (!tray) return;
  tray.setToolTip(text ? `kikoe: ${text}` : `kikoe ${VERSION}`);
}

function buildTrayMenu(): void {
  if (!tray || !daemon) return;
  const mode = daemon.narrator.mode;
  const modeItem = (label: string, value: string): Electron.MenuItemConstructorOptions => ({
    label,
    type: "radio",
    checked: mode === value,
    click: () => {
      daemon?.setMode(value);
      saveSettings({ narrate: value });
      buildTrayMenu();
    },
  });
  const menu = Menu.buildFromTemplate([
    { label: `kikoe ${VERSION}`, enabled: false },
    { type: "separator" },
    modeItem("Silent", "silent"),
    modeItem("Attention", "attention"),
    modeItem("Normal", "normal"),
    modeItem("Verbose", "verbose"),
    { type: "separator" },
    { label: paused ? "Resume" : "Pause for an hour", click: () => togglePause() },
    { label: "Stop talking", click: () => daemon?.interrupt() },
    { type: "separator" },
    {
      label:
        daemon.micPhase === "off" || daemon.micPhase === "dead"
          ? "Start listening"
          : "Stop listening",
      click: () => {
        const on = !(daemon?.micPhase && daemon.micPhase !== "off" && daemon.micPhase !== "dead");
        saveSettings({ mic: on });
        if (on) void startEar();
        else stopEar();
      },
    },
    { label: "The Room", click: () => openRoom() },
    {
      label: "Copy a viewer link for another screen",
      click: () => {
        if (!daemon) return;
        clipboard.writeText(
          `http://127.0.0.1:${daemon.settings.port}/room/?token=${daemon.viewer}`,
        );
      },
    },
    {
      label: "Copy a link that can answer (careful)",
      click: () => {
        if (!daemon) return;
        clipboard.writeText(`http://127.0.0.1:${daemon.settings.port}/room/?token=${daemon.token}`);
        new Notification({
          title: "This link can approve tool calls",
          body: "Anyone holding it can answer a permission. Share the viewer link unless you mean it.",
          silent: true,
        }).show();
      },
    },
    { label: "Clear the board", click: () => daemon?.board.clear() },
    {
      label: "Control room",
      click: () => {
        openRoom();
        roomWin?.webContents.send("room:view", { view: "control" });
      },
    },
    { label: "Settings…", click: () => openSettings() },
    { label: "Doctor…", click: () => openSettings("doctor") },
    {
      // A choice made here is a standing one: the Room filling the screen
      // hides the island by itself, but it must never un-hide one you put
      // away on purpose.
      label: islandHiddenByHand ? "Show island" : "Hide island",
      click: () => {
        islandHiddenByHand = !islandHiddenByHand;
        syncIsland();
      },
    },
    { type: "separator" },
    { label: "Quit", click: () => quit() },
  ]);
  tray.setContextMenu(menu);
}

function togglePause(): void {
  if (!daemon) return;
  if (paused) {
    paused = false;
    if (pauseTimer) clearTimeout(pauseTimer);
    daemon.setMode(loadSettings().narrate);
  } else {
    paused = true;
    daemon.setMode("silent");
    pauseTimer = setTimeout(
      () => {
        paused = false;
        daemon?.setMode(loadSettings().narrate);
        buildTrayMenu();
      },
      60 * 60 * 1000,
    );
  }
  buildTrayMenu();
}

async function quit(): Promise<void> {
  try {
    if (daemon && !noAudio) {
      daemon.say("Shutting down.", 3);
      await Promise.race([daemon.arbiter.drain(), new Promise((r) => setTimeout(r, 4000))]);
    }
    stopEar();
    await Promise.race([daemon?.close(), new Promise((r) => setTimeout(r, 3000))]);
  } finally {
    app.exit(0);
  }
}

/** Dark, light, or the system's choice. The overlaid controls follow. */
function applyTheme(theme: string): void {
  nativeTheme.themeSource = theme === "light" || theme === "dark" ? theme : "system";
  const light = !nativeTheme.shouldUseDarkColors;
  const overlay = light
    ? { color: "#f5f1ec", symbolColor: "#14100e", height: 36 }
    : { color: "#14100e", symbolColor: "#f5f1ec", height: 36 };
  for (const w of [roomWin]) {
    try {
      w?.setTitleBarOverlay(overlay);
      w?.setBackgroundColor(overlay.color);
    } catch {
      /* not every platform overlays */
    }
  }
}
nativeTheme.on("updated", () => applyTheme(loadSettings().theme));

function applyLoginItem(on: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
  } catch (e) {
    log(`login item: ${(e as Error).message}`);
  }
}

// --- ipc: what the windows may ask for ----------------------------------------

function daemonConfig() {
  return { url: `http://127.0.0.1:${daemon?.settings.port ?? 4570}`, token: daemon?.token ?? "" };
}

ipcMain.handle("island:config", () => daemonConfig());
ipcMain.on("island:openSettings", (_e, page?: string) => openSettings(page ?? ""));
ipcMain.handle("room:state", () => daemon?.state() ?? null);
ipcMain.handle("room:answerPin", (_e, id: string, answer: string) => ({
  ok: daemon?.board.answer(String(id), String(answer)) ?? false,
}));
ipcMain.handle("room:answerWord", (_e, word: string) => ({
  to: daemon?.answerWord(String(word)) ?? null,
}));
const ARTIFACT_EXT: Record<string, string> = {
  html: "html",
  svg: "svg",
  markdown: "md",
  note: "md",
  checklist: "md",
  table: "md",
  diff: "diff",
  text: "txt",
  image: "png",
  react: "jsx",
};
/** An artboard in its own window: the page as a page, the drawing as a drawing. */
ipcMain.handle("room:openArtifact", (_e, id: string) => {
  const p = daemon?.board.get(String(id));
  if (!p) return { error: "no such pin" };
  if (p.kind === "web") {
    const url = p.body.trim();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { ok: true };
  }
  if (p.kind === "html" || p.kind === "react") {
    // the served page, in its own window, with the runtime it needs
    const w = new BrowserWindow({
      width: 1100,
      height: 760,
      title: p.title || p.kind,
      autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    void w.loadURL(`http://127.0.0.1:${loadSettings().port}/artifact/${p.id}`);
    return { ok: true };
  }
  const w = new BrowserWindow({
    width: 1100,
    height: 760,
    title: p.title || p.kind,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const body =
    p.kind === "svg"
      ? `<!doctype html><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#14100e;color:#f5f1ec">${p.body}</body>`
      : p.kind === "image"
        ? `<!doctype html><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#14100e"><img src="${p.body}" style="max-width:100%;max-height:100vh"></body>`
        : `<!doctype html><body style="margin:0;padding:32px;font:15px/1.6 system-ui;background:#14100e;color:#f5f1ec;white-space:pre-wrap">${p.body.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c)}</body>`;
  void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(body)}`);
  return { ok: true };
});
ipcMain.handle("room:saveArtifact", async (_e, id: string) => {
  const p = daemon?.board.get(String(id));
  if (!p) return { error: "no such pin" };
  const ext = ARTIFACT_EXT[p.kind] ?? "txt";
  const name = `${(p.title || p.kind).replace(/[^\w.-]+/g, "-").slice(0, 60)}.${ext}`;
  const r = await dialog.showSaveDialog({ defaultPath: path.join(app.getPath("downloads"), name) });
  if (r.canceled || !r.filePath) return { ok: false };
  if (p.kind === "image" && p.body.startsWith("data:")) {
    const b64 = p.body.slice(p.body.indexOf(",") + 1);
    writeFileSync(r.filePath, Buffer.from(b64, "base64"));
  } else writeFileSync(r.filePath, p.body);
  return { ok: true, file: r.filePath };
});
ipcMain.handle("room:removePin", (_e, id: string) => ({
  ok: daemon?.board.remove(String(id)) ?? false,
}));
ipcMain.handle("room:clearBoard", () => ({ cleared: daemon?.board.clear() ?? 0 }));
ipcMain.handle(
  "room:actOnPin",
  (_e, id: string, action: string) =>
    daemon?.actOnPin(String(id), String(action)) ?? { ok: false, said: "not running" },
);
ipcMain.on("room:artifactBase", (e) => {
  e.returnValue = `http://127.0.0.1:${loadSettings().port}`;
});
ipcMain.handle("room:updatePin", (_e, id: string, patch: Record<string, unknown>) => ({
  ok: Boolean(
    daemon?.board.update(String(id), {
      title: typeof patch.title === "string" ? patch.title : undefined,
      body: typeof patch.body === "string" ? patch.body : undefined,
      sticky: typeof patch.sticky === "boolean" ? patch.sticky : undefined,
      size: patch.wide === true ? "wide" : patch.wide === false ? "normal" : undefined,
      w: typeof patch.w === "number" ? patch.w : undefined,
      h: typeof patch.h === "number" ? patch.h : undefined,
      x: typeof patch.x === "number" ? patch.x : undefined,
      y: typeof patch.y === "number" ? patch.y : undefined,
    }),
  ),
}));
ipcMain.handle("room:sayToKik", (_e, text: string) =>
  daemon ? daemon.typed(String(text)) : { kind: "none", intent: "" },
);
ipcMain.on("island:interactive", (_e, on: boolean) =>
  island?.setIgnoreMouseEvents(!on, on ? undefined : { forward: true }),
);
ipcMain.on("island:height", (_e, px: number) => {
  if (!island) return;
  const max = screen.getPrimaryDisplay().workArea.height - TOP_MARGIN * 2;
  const h = Math.max(ISLAND_H, Math.min(Math.round(Number(px) || 0), max));
  const [w = ISLAND_W, cur = 0] = island.getSize();
  if (cur !== h) island.setSize(w, h);
});
ipcMain.handle("island:devices", () => {
  try {
    const outputs = listOutputDevices().map((d) => ({ name: d.name, api: "", default: d.default }));
    return { outputs, inputs: [], output: daemon?.speaker.info().device ?? "", input: "" };
  } catch (e) {
    return { error: (e as Error).message };
  }
});
ipcMain.handle("island:chooseDevice", () => ({ error: "device choice moves to Settings" }));
ipcMain.handle("island:testDevice", () => {
  daemon?.say("Testing, one two.", 2);
  return { ok: true };
});

function snapshot() {
  const s = loadSettings();
  return {
    settings: s,
    version: VERSION,
    hasElevenKey: Boolean(loadElevenKey()),
    hasAnthropicKey: Boolean(loadAnthropicKey()),
    hasOpenrouterKey: Boolean(openrouterKeyFromFile()),
    hooks: hookStatus(s.claude_settings || settingsPath()),
    claudeSettingsPath: s.claude_settings || settingsPath(),
    curl: hasCurl(),
    state: daemon?.state() ?? null,
    home: HOME,
    platform: process.platform,
    kokoro: modelInstalled(KOKORO),
    downloading,
    restarts,
    lastCrash,
    paused,
    loginItem: (() => {
      try {
        return app.getLoginItemSettings().openAtLogin;
      } catch {
        return false;
      }
    })(),
  };
}

ipcMain.handle("settings:get", () => snapshot());
ipcMain.handle("settings:refreshUsage", async () => {
  if (!daemon) return { error: "the daemon is not running" };
  await daemon.usage.poll();
  return { ok: true, providers: daemon.usage.list() };
});
ipcMain.handle(
  "settings:save",
  async (
    _e,
    patch: Partial<Settings> & { elevenKey?: string | null; anthropicKey?: string | null },
  ) => {
    const { elevenKey, anthropicKey, ...rest } = patch;
    if (elevenKey !== undefined && elevenKey !== null) saveElevenKey(elevenKey);
    if (anthropicKey !== undefined && anthropicKey !== null) saveAnthropicKey(anthropicKey);
    const s = saveSettings(rest);
    if ("start_at_login" in rest) applyLoginItem(Boolean(rest.start_at_login));
    if ("theme" in rest) applyTheme(String(rest.theme));
    if ("mic" in rest || "mic_device" in rest || "stt_model" in rest) {
      stopEar();
      if (loadSettings().mic) void startEar();
    }
    if ("port" in rest) await restartDaemon("port change");
    else if (
      ["tts", "elevenlabs_voice", "elevenlabs_model", "tts_strict", "voices", "earcons"].some(
        (k) => k in rest,
      ) ||
      elevenKey !== undefined
    ) {
      daemon?.reconfigure(
        loadSettings(),
        loadElevenKey(),
        loadAnthropicKey(),
        openrouterKeyFromFile(),
      );
    } else if (rest.narrate) daemon?.setMode(rest.narrate);
    // Switching a provider off has to stop its credential being read, not just
    // hide its ring, so the store is rebuilt rather than filtered on the way out.
    if ("usage" in rest || "usage_off" in rest) {
      daemon?.applyUsageSettings(s);
      void daemon?.usage.poll();
    }
    // Off has to mean the socket is closed, not the switch is grey, so this
    // is awaited: Settings reads the state straight afterwards and must not
    // be told "listening" about a server that is still binding.
    // The switchboard and the PC switch take effect on the next sentence.
    if (daemon && ("jev" in rest || "pc" in rest)) {
      daemon.settings.jev = s.jev;
      daemon.settings.pc = s.pc;
    }
    // Hands change the tools Kik has, and its talking session learns its
    // tools when it starts: so the head is rebuilt, not just the flag set.
    if (daemon && "hands" in rest && daemon.settings.hands !== s.hands) {
      daemon.reconfigure(
        loadSettings(),
        loadElevenKey(),
        loadAnthropicKey(),
        openrouterKeyFromFile(),
      );
    }
    if (("walkie" in rest || "walkie_port" in rest || "walkie_tailscale" in rest) && daemon) {
      daemon.settings = loadSettings();
      if ("walkie_port" in rest && daemon.walkie) {
        const w = daemon.walkie;
        daemon.walkie = null;
        await w.stop();
      }
      await daemon.syncWalkie();
    }
    buildTrayMenu();
    return { ok: true, settings: s };
  },
);
ipcMain.handle("settings:say", (_e, text: string, label?: string) => {
  if (!daemon) return { error: "daemon not running" };
  const t = String(text || "Hello. This is how I sound.");
  if (label) {
    // Preview a repo's voice: a line carrying that label goes through voiceFor.
    daemon.arbiter.submit({
      text: t,
      session: `preview:${label}`,
      label,
      priority: 2,
      ttl: 0,
      dedupe: "",
      preempt: false,
      created: Date.now() / 1000,
      eventId: "",
    });
  } else daemon.say(t, 2);
  return { ok: true };
});
ipcMain.handle("settings:installHooks", (_e, profile: string) => {
  if (!daemon) return { error: "daemon not running" };
  try {
    const file = loadSettings().claude_settings || settingsPath();
    const r = installHooks({ profile, file, port: daemon.settings.port, token: daemon.token });
    saveSettings({ hook_profile: profile, claude_settings: file, onboarded: true });
    log(
      `hooks installed: ${r.events.length} events via ${r.kind} into ${r.file}; assets ${r.assets.length}`,
    );
    return { ok: true, ...r };
  } catch (e) {
    return { error: (e as Error).message };
  }
});
ipcMain.handle("settings:uninstallHooks", () => {
  try {
    return {
      ok: true,
      ...uninstallHooks({ file: loadSettings().claude_settings || settingsPath() }),
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
});
ipcMain.handle("settings:migrate", () => {
  try {
    const file = loadSettings().claude_settings || settingsPath();
    const r = uninstallHooks({ file, legacy: true, keepOurs: true });
    log(`legacy hooks removed: ${r.legacyRemoved.join(", ")}; assets ${r.assets.length}`);
    return { ok: true, ...r };
  } catch (e) {
    return { error: (e as Error).message };
  }
});
ipcMain.handle("settings:previewHooks", (_e, profile: string) => {
  if (!daemon) return { error: "daemon not running" };
  try {
    return {
      ok: true,
      ...installHooks({ profile, port: daemon.settings.port, token: daemon.token, dryRun: true }),
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
});
ipcMain.handle("settings:demo", async () => {
  if (!daemon) return { error: "daemon not running" };
  runDemo(daemon);
  return { ok: true };
});
ipcMain.handle("settings:elevenVoices", async () => {
  const key = loadElevenKey();
  if (!key) return { error: "no ElevenLabs key" };
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": key },
    });
    if (!r.ok) return { error: `elevenlabs ${r.status}` };
    const j = (await r.json()) as {
      voices: Array<{
        voice_id: string;
        name: string;
        category: string;
        labels?: Record<string, string>;
      }>;
    };
    return {
      ok: true,
      voices: j.voices.map((v) => ({
        id: v.voice_id,
        name: v.name,
        category: v.category,
        gender: v.labels?.gender ?? "",
        accent: v.labels?.accent ?? "",
      })),
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
});
ipcMain.handle("settings:fetchKokoro", async () => {
  if (downloading) return { error: "already downloading" };
  downloading = { name: "kokoro", received: 0, total: KOKORO.size, phase: "download" };
  try {
    await fetchModel(KOKORO, (p) => {
      downloading = { name: "kokoro", ...p };
      roomWin?.webContents.send("settings:progress", downloading);
    });
    daemon?.reconfigure(
      loadSettings(),
      loadElevenKey(),
      loadAnthropicKey(),
      openrouterKeyFromFile(),
    );
    return { ok: true };
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    downloading = null;
    roomWin?.webContents.send("settings:progress", null);
  }
});
ipcMain.handle("settings:removeKokoro", () => {
  removeModel(KOKORO);
  daemon?.reconfigure(loadSettings(), loadElevenKey(), loadAnthropicKey(), openrouterKeyFromFile());
  return { ok: true };
});
ipcMain.handle("settings:answerPermission", (_e, allow: boolean, id?: string) => ({
  ok: daemon?.answerPermission(Boolean(allow), id) ?? false,
}));
ipcMain.handle("settings:interrupt", () => {
  daemon?.interrupt();
  return { ok: true };
});
ipcMain.handle("settings:inputDevices", () => {
  try {
    const { RtAudio } = require("audify");
    const rt = new RtAudio();
    const def = rt.getDefaultInputDevice();
    return {
      ok: true,
      devices: (rt.getDevices() as any[])
        .filter((d) => d.inputChannels > 0)
        .map((d) => ({ name: String(d.name), default: d.id === def })),
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
});
ipcMain.handle("settings:copyLink", (_e, kind: string) => {
  if (!daemon) return { error: "daemon not running" };
  const token = kind === "full" ? daemon.token : daemon.viewer;
  clipboard.writeText(`http://127.0.0.1:${daemon.settings.port}/room/?token=${token}`);
  return { ok: true };
});
ipcMain.handle("settings:openHome", () => shell.openPath(HOME));
ipcMain.handle("settings:openLogs", () => shell.openPath(path.join(HOME, "logs")));
ipcMain.handle("settings:pickBackdrop", async () => {
  const r = await dialog.showOpenDialog({
    title: "Choose a backdrop",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }],
  });
  const src = r.filePaths[0];
  if (r.canceled || !src) return { ok: false };
  try {
    mkdirSync(HOME, { recursive: true });
    const dest = path.join(HOME, `backdrop${path.extname(src).toLowerCase()}`);
    copyFileSync(src, dest);
    const next = { ...loadSettings(), backdrop: "custom", backdrop_image: dest };
    saveSettings(next);
    daemon?.reconfigure(next, loadElevenKey(), loadAnthropicKey(), openrouterKeyFromFile());
    return { ok: true, file: dest };
  } catch (e) {
    return { error: (e as Error).message };
  }
});
ipcMain.handle("settings:pickClaudeSettings", async () => {
  const r = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "settings.json", extensions: ["json"] }],
  });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  saveSettings({ claude_settings: r.filePaths[0] });
  return { ok: true, file: r.filePaths[0] };
});

/** A scripted session through the real pipeline: what it sounds like when there is something to say. */
function runDemo(d: Daemon): void {
  const cwd = process.cwd();
  const at = (ms: number, payload: Record<string, unknown>) =>
    setTimeout(() => d.hook({ session_id: "demo", cwd, ...payload }), ms);
  at(0, { hook_event_name: "UserPromptSubmit", prompt: "fix the failing auth tests" });
  at(300, {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: "src/auth/token_refresh.ts" },
  });
  at(900, {
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "src/auth/token_refresh.ts" },
  });
  at(1200, {
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "src/auth/session.ts" },
  });
  at(4200, {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: "Tests: 18 passed, 2 failed, 20 total",
  });
  at(8500, {
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "git push origin main" },
  });
  at(14000, {
    hook_event_name: "Stop",
    last_assistant_message:
      "Fixed the race in `src/auth/token_refresh.ts` by acquiring the lock first. Two tests still fail on Windows path separators.",
  });
}

// --- lifecycle --------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => openSettings());
  app.whenReady().then(async () => {
    if (app.dock) app.dock.hide();
    const port = loadSettings().port;
    const other = await probe(port);
    if (other) {
      const msg = other.kikoe
        ? `Another kikoe is already running on port ${port}.`
        : `Something else is listening on port ${port}; change the port in ~/.kikoe/config.local.json.`;
      log(msg);
      if (!smoke) dialog.showErrorBox("kikoe", msg);
      app.exit(1);
      return;
    }
    try {
      await startDaemon();
    } catch (e) {
      log(`daemon failed to start: ${(e as Error).message}`);
      if (!smoke)
        dialog.showErrorBox("kikoe", `The daemon failed to start: ${(e as Error).message}`);
      app.exit(1);
      return;
    }
    applyTheme(loadSettings().theme);
    tray = new Tray(trayIcon());
    updateTrayTitle("");
    buildTrayMenu();
    tray.on("click", () => openSettings());
    createIsland();
    if (smoke) {
      daemon?.say("Smoke test.", 2);
      await Promise.race([daemon?.arbiter.drain(), new Promise((r) => setTimeout(r, 5000))]);
      const st = daemon?.state();
      process.stdout.write(
        `${JSON.stringify({ ok: true, version: VERSION, tts: st?.tts, spoken: st?.arbiter.spoken })}\n`,
      );
      await Promise.race([daemon?.close(), new Promise((r) => setTimeout(r, 2000))]);
      app.exit(0);
      return;
    }
    openRoom();
    if (shotPath) {
      // Stage the board the way the design shows it, capture, exit.
      await new Promise((r) => setTimeout(r, 1500));
      daemon?.hook({
        hook_event_name: "PreToolUse",
        session_id: "shot",
        cwd: process.cwd(),
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
      });
      // Open the board the staged work will land on *first*: hooks from this
      // repo make cards on this repo's project, and a board that is showing
      // somewhere else is correctly empty.
      daemon?.projects.ensure("kikoe", process.cwd());
      daemon?.openProject("kikoe");
      // A real turn through the real hook path, so the shot proves the work
      // feed rather than posing for it: an edit becomes a diff, a failing
      // command becomes a run with its stderr, a test run becomes a verdict.
      daemon?.hook({
        hook_event_name: "PostToolUse",
        session_id: "shot",
        cwd: process.cwd(),
        tool_name: "Edit",
        tool_input: { file_path: "packages/daemon/src/tts.ts" },
        tool_response: {
          filePath: "packages/daemon/src/tts.ts",
          structuredPatch: [
            {
              oldStart: 118,
              oldLines: 4,
              newStart: 118,
              newLines: 5,
              lines: [
                "   async speak(line: string) {",
                "-    return this.eleven(line);",
                "+    const voice = this.pick(line);",
                "+    return voice ? this.eleven(line, voice) : this.piper(line);",
                "   }",
              ],
            },
          ],
        },
      });
      daemon?.hook({
        hook_event_name: "PostToolUse",
        session_id: "shot",
        cwd: process.cwd(),
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
        tool_response: { stdout: "Test Files  16 passed (16)\nTests  189 passed (189)" },
      });
      daemon?.typed("add a retry to the token refresh");
      daemon?.board.add({
        kind: "markdown",
        title: "why the retry is bounded",
        body: "# Why the retry is bounded\n\nThree attempts with backoff, then give up.\n\n- a fourth never helped",
        repo: "api",
      });
      daemon?.board.add({
        kind: "table",
        title: "npm test",
        body: "npm test | 18 passed, 2 failed\npaths | joins with the platform separator | fail",
        repo: "storefront",
      });
      daemon?.board.add({
        kind: "diff",
        title: "token refresh · 3 lines",
        body: "-    const next = await this.fetchNew(token);\n+    const release = await this.lock.acquire();\n+    try { return await this.fetchNew(token); }\n+    finally { release(); }",
        repo: "storefront",
        ask: ["apply", "no"],
        wait_s: 90,
      });
      // a page Kik wrote, with the kit: the shot shows what a designed artboard looks like
      daemon?.board.add({
        kind: "html",
        title: "Sign in",
        body: withKit(
          '<!doctype html><html><head><title>Sign in</title></head><body><div class="narrow"><div class="card stack"><div class="row center"><span class="avatar big">W</span></div><h1 class="center">Welcome back</h1><p class="muted center">Sign in to reach your wallet from any device.</p><div class="field"><label>Email</label><input placeholder="you@example.com"></div><div class="field"><label>Password</label><input type="password" placeholder="Your password"></div><label class="check"><input type="checkbox"> Keep me signed in</label><button class="primary block big">Sign in</button><p class="dim center"><small>No account? <a href="#">Create one</a></small></p></div></div></body></html>',
        ),
        repo: "kik",
        by: "kik",
        size: "wide",
        h: 620,
      });
      // a live web card, framing the daemon itself so the shot needs no network
      daemon?.board.add({
        kind: "web",
        title: "the shop on localhost",
        body: `http://127.0.0.1:${loadSettings().port}/`,
        repo: "kik",
        by: "kik",
        size: "wide",
      });
      await new Promise((r) => setTimeout(r, 2500));
      const img = await roomWin?.webContents.capturePage();
      if (img) writeFileSync(shotPath, img.toPNG());
      // and the settings view, in the same window
      roomWin?.webContents.send("room:view", { view: "settings", page: "welcome" });
      await new Promise((r) => setTimeout(r, 1200));
      const img2 = await roomWin?.webContents.capturePage();
      if (img2) writeFileSync(shotPath.replace(/\.png$/, "-settings.png"), img2.toPNG());
      // The pill has its own window, so the Room's capture never showed it —
      // which meant the one surface that is looked at all day was the one
      // surface no screenshot could check. Transparent, so it comes out on
      // nothing; that is what it looks like in use.
      // Hover the first usage ring, so its card is in the shot. The pill only
      // ever opens that card on a pointer, so without staging the move the one
      // surface that carries the actual numbers could never be checked.
      //
      // The card has to be *pinned*, not merely opened: the window is
      // click-through with mouse moves forwarded, so the real pointer sitting
      // anywhere else keeps closing a staged hover before the capture. Stubbing
      // the close is the harness freezing a frame, and it lives here rather
      // than in the pill for exactly that reason.
      await island?.webContents.executeJavaScript(
        `(() => {
          hideUsageCard = () => {};
          const r = document.querySelector(".ring-cell .ring")?.getBoundingClientRect();
          if (!r) return false;
          document.dispatchEvent(new MouseEvent("mousemove", {
            clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
          }));
          return true;
        })()`,
      );
      await new Promise((r) => setTimeout(r, 400));
      const img3 = await island?.webContents.capturePage();
      if (img3) writeFileSync(shotPath.replace(/\.png$/, "-island.png"), img3.toPNG());
      process.stdout.write(`${JSON.stringify({ ok: Boolean(img), path: shotPath })}\n`);
      await Promise.race([daemon?.close(), new Promise((r) => setTimeout(r, 2000))]);
      app.exit(img ? 0 : 1);
      return;
    }
    void startEar();
    daemon?.hub.listen((frame) => {
      if (frame.type === "control" && frame.intent === "shutdown") void quit();
    });
    if (!loadSettings().onboarded) openSettings("welcome");
  });
}

app.on("window-all-closed", () => {
  /* a tray app: closing windows is not quitting */
});
app.on("before-quit", (e) => {
  if (daemon) {
    e.preventDefault();
    void quit();
  }
});
