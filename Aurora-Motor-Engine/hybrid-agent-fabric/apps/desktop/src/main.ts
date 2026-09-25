import { app, BrowserWindow, shell, session } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAllowedArtifactFrameUrl } from "./security.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = new URL(process.env.HAF_DESKTOP_URL ?? "http://127.0.0.1:8787/canvas/");
let mainWindow: BrowserWindow | null = null;

function allowed(url: string): boolean {
  try { const parsed = new URL(url); return parsed.origin === target.origin; } catch { return false; }
}

async function createWindow() {
  const partition = "persist:haf-canvas";
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(["clipboard-sanitized-write", "notifications"].includes(permission));
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: {
      ...details.responseHeaders,
      "Content-Security-Policy": ["default-src 'self'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'"],
    } });
  });
  mainWindow = new BrowserWindow({
    width: 1500, height: 960, minWidth: 1000, minHeight: 700,
    backgroundColor: "#080d17", title: "Hybrid Agent Fabric",
    webPreferences: {
      // `.cjs`, not `.js`: Electron wraps a sandboxed preload in a CommonJS
      // loader, and an ESM preload is only loaded when `sandbox` is false. This
      // window keeps `sandbox: true`, so the ESM build of this file silently
      // exposed nothing -- `window.hafDesktop` came back undefined on both
      // Electron 41.7.1 and 44.4.5. `tsconfig.preload.json` emits CommonJS and
      // the build renames it to `.cjs` (the package is `"type": "module"`).
      preload: join(__dirname, "preload.cjs"), partition,
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => { if (!allowed(url)) event.preventDefault(); });
  mainWindow.webContents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame) return;
    if (!isAllowedArtifactFrameUrl(details.url, target.origin)) details.preventDefault();
  });
  await mainWindow.loadURL(target.toString());
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});
app.whenReady().then(createWindow);
app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) void createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
