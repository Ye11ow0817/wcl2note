import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../shared/desktop";
import type { UpdateSnapshot } from "../shared/updates";

const bridge: DesktopBridge = {
  query: (id, payload) => ipcRenderer.invoke("wcl:query", id, payload),
  cancel: (id) => ipcRenderer.send("wcl:cancel", id),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  copyNote: (text) => ipcRenderer.invoke("note:copy", text),
  saveNote: (name, text) => ipcRenderer.invoke("note:save", name, text),
  openCredentialsPage: () => ipcRenderer.invoke("wcl:credentials-page"),
  version: () => ipcRenderer.invoke("app:version"),
  getUpdateState: () => ipcRenderer.invoke("updates:state"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  onUpdateState: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: UpdateSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on("updates:changed", handler);
    return () => ipcRenderer.removeListener("updates:changed", handler);
  },
};
contextBridge.exposeInMainWorld("wcl2note", bridge);
