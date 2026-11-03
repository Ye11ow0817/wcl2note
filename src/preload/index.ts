import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../shared/desktop";

const bridge: DesktopBridge = {
  query: (id, payload) => ipcRenderer.invoke("wcl:query", id, payload),
  cancel: (id) => ipcRenderer.send("wcl:cancel", id),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  copyNote: (text) => ipcRenderer.invoke("note:copy", text),
  saveNote: (name, text) => ipcRenderer.invoke("note:save", name, text),
  openCredentialsPage: () => ipcRenderer.invoke("wcl:credentials-page"),
  version: () => ipcRenderer.invoke("app:version"),
};
contextBridge.exposeInMainWorld("wcl2note", bridge);
