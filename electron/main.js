// Desktop shell: runs the local server and shows the app in its own window. Its one real job
// beyond a browser tab is native file drag, so tracks can be dropped straight onto Serato
// (a web page can't hand another app a real file).
import { app, BrowserWindow, ipcMain, nativeImage, shell, dialog } from 'electron';
import { fork } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUpdater } from './updater.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4321;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.mp4', '.aac', '.flac', '.wav', '.aif', '.aiff', '.ogg']);
const icon = nativeImage.createFromPath(path.join(ROOT, 'electron', 'icon.png'));
const dragIcon = nativeImage.createFromPath(path.join(ROOT, 'electron', 'drag.png'));

let server = null; // only set if we started it (a server from `npm start` is reused, not owned)
let win = null;
let quitting = false;
const SMOKE = !!process.env.PP_SMOKE; // headless self-check: load, verify the drag bridge, quit

app.setName('Party Planner');
// Dev-only: PP_DEBUG_PORT exposes DevTools protocol for automated checks; PP_HIDDEN keeps the window off-screen.
if (process.env.PP_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.PP_DEBUG_PORT);

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${ORIGIN}/api/status`, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

// Packaged app: the bundle is read-only, so user data lives in ~/Library/Application Support/Party Planner.
// A Billboard history shipped in the bundle (seed/) is copied there on first launch.
// (app.isPackaged only looks at whether the binary was renamed from "Electron", so check the location.)
const PACKAGED = /\.app\/Contents\/Resources\/app$/.test(ROOT);

function packagedDataDir() {
  if (!PACKAGED) return null;
  // scripts/install.sh writes config.json so your installed copy shares the project's data/ folder.
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (cfg.dataDir) return cfg.dataDir;
  } catch { /* no config: a shared copy, use Application Support */ }
  const dir = app.getPath('userData');
  const charts = path.join(dir, 'charts');
  const seed = path.join(ROOT, 'seed', 'hot-100.csv');
  fs.mkdirSync(charts, { recursive: true });
  if (!fs.existsSync(path.join(charts, 'hot-100.csv')) && fs.existsSync(seed)) fs.copyFileSync(seed, path.join(charts, 'hot-100.csv'));
  return dir;
}

async function ensureServer() {
  if (await ping()) return;
  // Electron's binary doubles as Node with ELECTRON_RUN_AS_NODE, so no separate Node install is needed.
  const dataDir = packagedDataDir();
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT), ...(dataDir ? { PP_DATA_DIR: dataDir } : {}) };
  server = fork(path.join(ROOT, 'server.js'), [], { cwd: ROOT, env, stdio: 'inherit' });
  server.on('exit', (code) => {
    server = null;
    if (!quitting) dialog.showErrorBox('Party Planner', `The library server stopped (exit code ${code}). Restart the app.`);
  });
  for (let i = 0; i < 120; i++) {
    if (await ping()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('The library server did not start within 60 seconds.');
}

const SPLASH = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><title>Party Planner</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#2b3038;color:#aab4c3;font:15px -apple-system,sans-serif">
<div style="text-align:center"><div style="font-weight:700;color:#ffffff;font-size:18px;margin-bottom:6px">Party Planner</div>Reading your Serato library…</div></body>`)}`;

async function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    title: 'Party Planner',
    show: !SMOKE && !process.env.PP_HIDDEN,
    backgroundColor: '#2b3038',
    icon,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Stay on the local app; anything else (e.g. a link) opens in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
  // Page logs tagged [drag…] go to data/app.log so drag problems can be diagnosed.
  win.webContents.on('console-message', (e) => {
    const msg = e.message ?? '';
    if (msg.startsWith('[drag')) console.log(`[page] ${msg}`);
  });
  // Don't await the splash: a reload (Cmd+R) during startup aborts it, and that must not stop the server.
  win.loadURL(SPLASH).catch(() => {});
  try {
    await ensureServer();
    if (!win) return;
    await win.loadURL(`${ORIGIN}/`);
    if (SMOKE) {
      const ok = await win.webContents.executeJavaScript('typeof window.desktop?.startDrag === "function" && document.body.classList.contains("desktop")');
      console.log(`SMOKE ${ok ? 'OK' : 'FAIL'}: loaded ${win.webContents.getURL()}`);
      app.quit();
    }
  } catch (e) {
    if (SMOKE) { console.log(`SMOKE FAIL: ${e.message}`); app.quit(); return; }
    dialog.showErrorBox('Party Planner', e.message);
  }
}

// Native drag: the page asks, we verify each path is an existing audio file, then hand macOS the
// real files. Serato (and Finder) accept these exactly like a drag from Finder.
// Self-updates from GitHub Releases (only for an installed .app; see updater.js).
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const updater = createUpdater({
  repo: PKG.updateRepo || null,
  currentVersion: PKG.version,
  appBundle: PACKAGED ? path.resolve(ROOT, '../../..') : null,
  onStatus: (status) => win?.webContents.send('update-status', status),
});
ipcMain.handle('update-status', () => updater.status());
ipcMain.handle('update-check', () => updater.check());
ipcMain.handle('update-install', () => updater.install());

ipcMain.on('start-drag', (event, files) => {
  const list = (Array.isArray(files) ? files : [files]).filter((f) =>
    typeof f === 'string' && path.isAbsolute(f) && AUDIO_EXT.has(path.extname(f).toLowerCase()) && fs.existsSync(f));
  console.log(`[drag] ${list.length}/${Array.isArray(files) ? files.length : 1} file(s): ${list[0] ? path.basename(list[0]) : '(none valid)'}`);
  if (!list.length) return;
  try {
    event.sender.startDrag({ file: list[0], files: list, icon: dragIcon });
    console.log('[drag] startDrag ok');
  } catch (e) {
    console.log(`[drag] startDrag failed: ${e.message}`);
  }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    if (process.platform === 'darwin' && !icon.isEmpty()) app.dock.setIcon(icon);
    createWindow();
    app.on('activate', () => { if (!win) createWindow(); });
    // Look for a new version shortly after launch, then every 6 hours.
    if (!SMOKE) {
      setTimeout(() => updater.check(), 15000);
      setInterval(() => updater.check(), 6 * 3600 * 1000);
    }
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  server?.kill();
});
