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
  clearBoard: () => ipcRenderer.invoke("room:clearBoard"),
  interrupt: () => ipcRenderer.invoke("settings:interrupt"),
  openSettings: (page?: string) => ipcRenderer.send("island:openSettings", page),
});
