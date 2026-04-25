const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require("electron");
const net = require("net");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { getBridgeConnectOptions } = require("./bridgeConfig.cjs");

let mainWindow;
/** @type {import('net').Socket | null} */
let bridge = null;
/** @type {string} */
let receiveBuf = "";
/** @type {string[]} */
const lineQueue = [];
/** @type {((line: string) => void)[]} */
let lineWaiters = [];

function onSocketChunk(chunk) {
  receiveBuf += chunk;
  let ix;
  while ((ix = receiveBuf.indexOf("\n")) >= 0) {
    const line = receiveBuf.slice(0, ix);
    receiveBuf = receiveBuf.slice(ix + 1);
    if (lineWaiters.length > 0) {
      lineWaiters.shift()(line);
    } else {
      lineQueue.push(line);
    }
  }
}

function readLine() {
  return new Promise((resolve) => {
    if (lineQueue.length > 0) {
      resolve(lineQueue.shift());
    } else {
      lineWaiters.push(resolve);
    }
  });
}

const BRIDGE_RETRY_MS = 500;
const BRIDGE_MAX_ATTEMPTS = 40; // ~20s if host starts late

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolves a connected client socket, or rejects if the host never creates the pipe.
 * On Windows, connect ENOENT means nothing is listening — usually otl_marketlab_host.exe is not running.
 */
function getBridge() {
  if (bridge && !bridge.destroyed) {
    return Promise.resolve(bridge);
  }
  const opt = getBridgeConnectOptions();
  return new Promise((resolve, reject) => {
    const tryConnect = (attempt) => {
      const s = net.createConnection(opt, () => {
        bridge = s;
        receiveBuf = "";
        lineQueue.length = 0;
        lineWaiters = [];
        s.setEncoding("utf8");
        s.on("data", onSocketChunk);
        s.on("error", () => {
          bridge = null;
          receiveBuf = "";
        });
        s.on("close", () => {
          bridge = null;
          receiveBuf = "";
        });
        resolve(s);
      });
      s.once("error", (err) => {
        s.destroy();
        const retryable = err && (err.code === "ENOENT" || err.code === "ECONNREFUSED");
        if (retryable && attempt < BRIDGE_MAX_ATTEMPTS) {
          void sleep(BRIDGE_RETRY_MS).then(() => tryConnect(attempt + 1));
          return;
        }
        const pathHint = opt.path != null ? String(opt.path) : "";
        reject(
          new Error(
            `Command Bridge not reachable${pathHint ? ` (${pathHint})` : ""}: ${err.message}. ` +
              "Start the C++ host first: otl_marketlab_host.exe in another PowerShell, wait for " +
              '"Waiting for the UI to connect", then run npm start (or use Ping again).'
          )
        );
      });
    };
    tryConnect(1);
  });
}

/**
 * @param {string} line
 * @returns {Promise<string>}
 */
function sendLine(line) {
  return getBridge().then(
    (s) =>
      new Promise((resolve, reject) => {
        s.write(`${line}\n`, (err) => {
          if (err) {
            reject(err);
            return;
          }
          readLine().then(resolve).catch(reject);
        });
      })
  );
}

/**
 * If `MARKET_LAB_SPAWN_HOST=1`, start `otl_marketlab_host` so the named pipe exists before the UI connects.
 * Set `MARKET_LAB_HOST_EXE` to a full path, or place the executable next to `main.cjs` (otl_marketlab_host.exe on Windows).
 */
function trySpawnHostProcess() {
  if (process.env.MARKET_LAB_SPAWN_HOST !== "1") {
    return;
  }
  const fromEnv = process.env.MARKET_LAB_HOST_EXE;
  const candidates = [];
  if (fromEnv) {
    candidates.push(fromEnv);
  }
  if (process.platform === "win32") {
    candidates.push(path.join(__dirname, "otl_marketlab_host.exe"));
  } else {
    candidates.push(path.join(__dirname, "otl_marketlab_host"));
  }
  for (const exe of candidates) {
    if (!exe) {
      continue;
    }
    try {
      if (fs.existsSync(exe)) {
        const child = spawn(exe, [], {
          detached: true,
          stdio: "ignore",
          cwd: path.dirname(exe),
          windowsHide: false
        });
        child.on("error", () => {
          // ignore: user can start the host manually
        });
        child.unref();
        return;
      }
    } catch {
      // ignore
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#121212",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.removeMenu();
  void mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  nativeTheme.themeSource = "dark";
  trySpawnHostProcess();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("mlab-ping", async () => sendLine("PING"));
ipcMain.handle("mlab-load", async (_e, p) => sendLine(`LOAD_DATA ${p}`));
ipcMain.handle("mlab-seek", async (_e, t) => sendLine(`SEEK ${t}`));
ipcMain.handle("mlab-set-uber", async (_e, /** @type {string} */ json) =>
  sendLine(`SET_UBER_SIGNAL ${json}`)
);
ipcMain.handle("mlab-pick-csv", async () => {
  const win =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getFocusedWindow();
  const r = await dialog.showOpenDialog(win != null ? win : null, {
    title: "Load Yahoo / universe close CSV",
    properties: ["openFile"],
    filters: [{ name: "CSV", extensions: ["csv"] }]
  });
  if (r.canceled || !r.filePaths[0]) {
    return { canceled: true };
  }
  return { canceled: false, path: r.filePaths[0] };
});
