// Settings and first run. Named calls only; the page never gets a generic
// request(path) it could point anywhere.

import { contextBridge, ipcRenderer } from "electron";

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
  answerPermission: (allow: boolean, id?: string) =>
    ipcRenderer.invoke("settings:answerPermission", allow, id),
  interrupt: () => ipcRenderer.invoke("settings:interrupt"),
  inputDevices: () => ipcRenderer.invoke("settings:inputDevices"),
  openHome: () => ipcRenderer.invoke("settings:openHome"),
  openLogs: () => ipcRenderer.invoke("settings:openLogs"),
  pickClaudeSettings: () => ipcRenderer.invoke("settings:pickClaudeSettings"),
  onGoto: (fn: (page: string) => void) =>
    ipcRenderer.on("settings:goto", (_e, page: string) => fn(page)),
  onProgress: (fn: (p: unknown) => void) =>
    ipcRenderer.on("settings:progress", (_e, p: unknown) => fn(p)),
});
