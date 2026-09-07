// The Room's bridge: the live stream, the board, and the few words a person
// can say back. Named calls only.

import { contextBridge, ipcRenderer } from "electron";

type Frame = Record<string, unknown> & { type: string };

let config: { url: string; token: string } | null = null;
async function ready() {
  if (!config) config = await ipcRenderer.invoke("island:config");
  return config!;
}

contextBridge.exposeInMainWorld("room", {
  async stream(onFrame: (f: Frame) => void, onStatus: (s: string) => void) {
    const { url, token } = await ready();
    let source: EventSource | null = null;
    let reconnecting = false;
    const connect = () => {
      reconnecting = false;
      source = new EventSource(`${url}/stream?token=${encodeURIComponent(token)}`);
      source.onopen = () => onStatus("connected");
      source.onmessage = (e) => {
        let frame: Frame;
        try {
          frame = JSON.parse(e.data);
        } catch {
          return;
        }
        try {
          onFrame(frame);
        } catch (err) {
          console.error("room: handler failed for", frame?.type, err);
        }
      };
      source.onerror = () => {
        if (reconnecting) return;
        reconnecting = true;
        onStatus("disconnected");
        source?.close();
        setTimeout(connect, 2000);
      };
    };
    connect();
    ipcRenderer.on("island:reconnect", () => {
      config = null;
      source?.close();
      void ready().then(connect);
    });
  },
  state: () => ipcRenderer.invoke("room:state"),
  answerPin: (id: string, answer: string) => ipcRenderer.invoke("room:answerPin", id, answer),
  answerWord: (word: string) => ipcRenderer.invoke("room:answerWord", word),
  removePin: (id: string) => ipcRenderer.invoke("room:removePin", id),
  updatePin: (id: string, patch: Record<string, unknown>) =>
    ipcRenderer.invoke("room:updatePin", id, patch),
  // The titlebar and Settings have always called this; the handler and the
  // browser shim have always had it. Only this line was missing, so the
  // button threw in the app and worked on the second screen.
  clearBoard: () => ipcRenderer.invoke("room:clearBoard"),
  actOnPin: (id: string, action: string) => ipcRenderer.invoke("room:actOnPin", id, action),
  sayToKik: (text: string) => ipcRenderer.invoke("room:sayToKik", text),
  native: true,
  /** where the daemon serves pages: a card frames `${base}/artifact/<id>` */
  artifactBase: ipcRenderer.sendSync("room:artifactBase") as string,
  openArtifact: (id: string) => ipcRenderer.invoke("room:openArtifact", id),
  saveArtifact: (id: string) => ipcRenderer.invoke("room:saveArtifact", id),
  onView: (fn: (v: { view: string; page?: string }) => void) =>
    ipcRenderer.on("room:view", (_e, v: { view: string; page?: string }) => fn(v)),
});

// Settings, inside the same window. Named calls only.
contextBridge.exposeInMainWorld("kikoe", {
  get: () => ipcRenderer.invoke("settings:get"),
  save: (patch: Record<string, unknown>) => ipcRenderer.invoke("settings:save", patch),
  say: (text: string, label?: string) => ipcRenderer.invoke("settings:say", text, label),
  previewHooks: (profile: string) => ipcRenderer.invoke("settings:previewHooks", profile),
  installHooks: (profile: string) => ipcRenderer.invoke("settings:installHooks", profile),
  uninstallHooks: () => ipcRenderer.invoke("settings:uninstallHooks"),
  migrate: () => ipcRenderer.invoke("settings:migrate"),
  demo: () => ipcRenderer.invoke("settings:demo"),
  elevenVoices: () => ipcRenderer.invoke("settings:elevenVoices"),
  fetchKokoro: () => ipcRenderer.invoke("settings:fetchKokoro"),
  removeKokoro: () => ipcRenderer.invoke("settings:removeKokoro"),
  inputDevices: () => ipcRenderer.invoke("settings:inputDevices"),
  copyLink: (kind: string) => ipcRenderer.invoke("settings:copyLink", kind),
  openHome: () => ipcRenderer.invoke("settings:openHome"),
  openLogs: () => ipcRenderer.invoke("settings:openLogs"),
  pickClaudeSettings: () => ipcRenderer.invoke("settings:pickClaudeSettings"),
  pickBackdrop: () => ipcRenderer.invoke("settings:pickBackdrop"),
  refreshUsage: () => ipcRenderer.invoke("settings:refreshUsage"),
  onProgress: (fn: (p: unknown) => void) =>
    ipcRenderer.on("settings:progress", (_e, p: unknown) => fn(p)),
});
