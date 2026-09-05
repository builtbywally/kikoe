// The island's whole bridge: the live stream, and a few named calls. The
// daemon token never enters page context; the main process supplies the
// stream URL and the page opens an EventSource against loopback.

import { contextBridge, ipcRenderer } from "electron";

type Frame = Record<string, unknown> & { type: string };

let config: { url: string; token: string } | null = null;
async function ready() {
  if (!config) config = await ipcRenderer.invoke("island:config");
  return config!;
}

contextBridge.exposeInMainWorld("island", {
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
          console.error("island: handler failed for", frame?.type, err);
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
  devices: () => ipcRenderer.invoke("island:devices"),
  chooseDevice: (kind: string, name: string) =>
    ipcRenderer.invoke("island:chooseDevice", { kind, name }),
  testDevice: (kind: string, name: string) =>
    ipcRenderer.invoke("island:testDevice", { kind, name }),
  setInteractive: (on: boolean) => ipcRenderer.send("island:interactive", Boolean(on)),
  openSettings: () => ipcRenderer.send("island:openSettings"),
  setHeight: (px: number) => ipcRenderer.send("island:height", px),
});
