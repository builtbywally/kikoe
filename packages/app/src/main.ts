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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  Daemon,
  HOME,
  KOKORO,
  MODELS,
  type Settings,
  VERSION,
  elevenKeyFromFile,
  fetchModel,
  hasCurl,
  hookStatus,
  installHooks,
  listOutputDevices,
  loadSettings,
  log,
  modelInstalled,
  probe,
  removeModel,
  saveSettings,
  settingsPath,
  uninstallHooks,
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
let settingsWin: BrowserWindow | null = null;
let roomWin: BrowserWindow | null = null;
let ear: Electron.UtilityProcess | null = null;
let paused = false;
let pauseTimer: NodeJS.Timeout | null = null;
let restarts = 0;
let lastCrash = "";
let downloading: { name: string; received: number; total: number; phase: string } | null = null;
const smoke = process.argv.includes("--smoke");
const noAudio = process.argv.includes("--no-audio") || smoke;

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

// --- daemon -----------------------------------------------------------------

async function startDaemon(): Promise<void> {
  const settings = loadSettings();
  daemon = new Daemon({
    settings,
    audio: !noAudio,
    elevenKey: loadElevenKey(),
    roomDir: path.join(RENDERER, "room"),
  });
  await daemon.listen();
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
 * daemon in place, show it in doctor. Two crashes in a minute stop the
 * retry so a broken machine does not loop the speaker.
 */
let crashTimes: number[] = [];
function onCrash(kind: string, err: unknown): void {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  lastCrash = `${new Date().toISOString()} ${kind}: ${msg.slice(0, 400)}`;
  log(`CRASH ${kind}: ${msg}`);
  const now = Date.now();
  crashTimes = crashTimes.filter((t) => now - t < 60_000);
  crashTimes.push(now);
  if (crashTimes.length > 2) {
    log("too many crashes in a minute; leaving the daemon down");
    return;
  }
  void restartDaemon("crash");
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
  n.on("click", () => openSettings("sessions"));
  n.show();
}

// --- the ear -----------------------------------------------------------------

/** The mic runs in its own process so a transcription never stalls a window. */
function startEar(): void {
  if (ear || !daemon) return;
  const s = loadSettings();
  if (!s.mic) return;
  daemon.micPhase = "starting";
  ear = utilityProcess.fork(path.join(__dirname, "mic.js"), [], {
    serviceName: "kikoe-mic",
    stdio: "pipe",
    env: {
      ...process.env,
      KIKOE_PORT: String(daemon.settings.port),
      KIKOE_TOKEN: daemon.token,
      KIKOE_MODELS: MODELS,
      KIKOE_MIC_DEVICE: s.mic_device,
    },
  });
  ear.stderr?.on("data", (d: Buffer) => log(String(d).trim()));
  ear.on("exit", (code) => {
    log(`mic process exited ${code}`);
    ear = null;
    if (daemon) daemon.micPhase = code === 0 ? "off" : "dead";
    buildTrayMenu();
  });
  buildTrayMenu();
}

function stopEar(): void {
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
  if (settingsWin) {
    settingsWin.show();
    settingsWin.focus();
    if (page) settingsWin.webContents.send("settings:goto", page);
    return;
  }
  settingsWin = new BrowserWindow({
    width: 760,
    height: 680,
    minWidth: 560,
    minHeight: 480,
    title: "kikoe",
    show: false,
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0f1115", symbolColor: "#f5f1ec", height: 36 },

    webPreferences: {
      preload: path.join(__dirname, "preload-settings.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  applyTheme(loadSettings().theme);
  settingsWin.loadFile(path.join(RENDERER, "settings", "index.html"), page ? { hash: page } : {});
  settingsWin.once("ready-to-show", () => settingsWin?.show());
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
}

/**
 * The Room: the voice-first control room. A normal window, dark, that can
 * live full screen on a second monitor. It shows the spoken line, the orb,
 * the agents, and the board the agent pins things to.
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
  applyTheme(loadSettings().theme);
  roomWin.loadFile(path.join(RENDERER, "room", "index.html"));
  roomWin.once("ready-to-show", () => roomWin?.show());
  roomWin.on("closed", () => {
    roomWin = null;
  });
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
        if (on) startEar();
        else stopEar();
      },
    },
    { label: "The Room", click: () => openRoom() },
    {
      label: "Copy the Room link for another screen",
      click: () => {
        if (!daemon) return;
        clipboard.writeText(`http://127.0.0.1:${daemon.settings.port}/room/?token=${daemon.token}`);
      },
    },
    { label: "Clear the board", click: () => daemon?.board.clear() },
    { label: "Sessions…", click: () => openSettings("sessions") },
    { label: "Settings…", click: () => openSettings() },
    { label: "Doctor…", click: () => openSettings("doctor") },
    {
      label: island?.isVisible() ? "Hide island" : "Show island",
      click: () => (island?.isVisible() ? island.hide() : island?.show()),
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
  for (const w of [roomWin, settingsWin]) {
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
ipcMain.handle("room:removePin", (_e, id: string) => ({
  ok: daemon?.board.remove(String(id)) ?? false,
}));
ipcMain.handle("room:clearBoard", () => ({ cleared: daemon?.board.clear() ?? 0 }));
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
ipcMain.handle(
  "settings:save",
  async (_e, patch: Partial<Settings> & { elevenKey?: string | null }) => {
    const { elevenKey, ...rest } = patch;
    if (elevenKey !== undefined && elevenKey !== null) saveElevenKey(elevenKey);
    const s = saveSettings(rest);
    if ("start_at_login" in rest) applyLoginItem(Boolean(rest.start_at_login));
    if ("theme" in rest) applyTheme(String(rest.theme));
    if ("mic" in rest || "mic_device" in rest) {
      stopEar();
      if (loadSettings().mic) startEar();
    }
    if ("port" in rest) await restartDaemon("port change");
    else if (
      ["tts", "elevenlabs_voice", "elevenlabs_model", "tts_strict", "voices", "earcons"].some(
        (k) => k in rest,
      ) ||
      elevenKey !== undefined
    ) {
      daemon?.reconfigure(loadSettings(), loadElevenKey());
    } else if (rest.narrate) daemon?.setMode(rest.narrate);
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
    const r = uninstallHooks({ file, legacy: true });
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
      settingsWin?.webContents.send("settings:progress", downloading);
    });
    daemon?.reconfigure(loadSettings(), loadElevenKey());
    return { ok: true };
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    downloading = null;
    settingsWin?.webContents.send("settings:progress", null);
  }
});
ipcMain.handle("settings:removeKokoro", () => {
  removeModel(KOKORO);
  daemon?.reconfigure(loadSettings(), loadElevenKey());
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
ipcMain.handle("settings:openHome", () => shell.openPath(HOME));
ipcMain.handle("settings:openLogs", () => shell.openPath(path.join(HOME, "logs")));
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
    startEar();
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
