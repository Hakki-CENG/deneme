import { contextBridge } from "electron";
contextBridge.exposeInMainWorld("hafDesktop", Object.freeze({
  platform: process.platform,
  versions: Object.freeze({ electron: process.versions.electron, chrome: process.versions.chrome }),
}));
