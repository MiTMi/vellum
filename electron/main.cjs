const { app, BrowserWindow, shell, nativeTheme, Menu } = require("electron");
const path = require("path");
const fs = require("fs");

const isMac = process.platform === "darwin";

function buildMenu() {
  const send = (channel) => (_item, win) => {
    win?.webContents.send(channel);
  };
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Tab", accelerator: "CmdOrCtrl+T", click: send("vellum:new-tab") },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: send("vellum:close-tab") },
        { type: "separator" },
        isMac
          ? { role: "close", label: "Close Window", accelerator: "Shift+CmdOrCtrl+W" }
          : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const isDev = !!process.env.ELECTRON_START_URL;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 760,
    minHeight: 480,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#191919" : "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Open external links in the default browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow.webContents.getURL();
    if (url !== current && url.startsWith("http") && !url.startsWith("http://localhost")) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  if (process.env.ELECTRON_START_URL) {
    mainWindow.loadURL(process.env.ELECTRON_START_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  buildMenu();
  // In dev the Dock shows Electron's default icon — swap in ours.
  // (Packaged builds get the icon from electron-builder automatically.)
  if (process.platform === "darwin" && app.dock) {
    const iconPath = path.join(__dirname, "..", "build", "icon.png");
    try {
      if (fs.existsSync(iconPath)) app.dock.setIcon(iconPath);
    } catch {
      /* non-fatal */
    }
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
