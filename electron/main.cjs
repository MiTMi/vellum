const {
  app,
  BrowserWindow,
  shell,
  nativeTheme,
  Menu,
  ipcMain,
  systemPreferences,
  safeStorage,
  dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const isMac = process.platform === "darwin";

/* ---------------------- Touch ID sign-in support ---------------------- */
// Touch ID can't authenticate to Convex by itself — the server still needs
// the password. So: after a password sign-in the renderer may store the
// credentials here, encrypted with safeStorage (key lives in the user's
// macOS Keychain). "Sign in with Touch ID" prompts the biometric and only
// on success decrypts and returns them. The biometric gate is enforced by
// this process, not by a Keychain ACL — fine for a personal machine, but
// anything running as this user could read the encrypted file and call
// safeStorage itself; that's the safeStorage trust model.

const credsFile = () => path.join(app.getPath("userData"), "touchid-credentials.enc");

function touchIdAvailable() {
  return (
    isMac &&
    typeof systemPreferences.canPromptTouchID === "function" &&
    systemPreferences.canPromptTouchID() &&
    safeStorage.isEncryptionAvailable()
  );
}

ipcMain.handle("vellum:touchid-status", () => ({
  available: touchIdAvailable(),
  enrolled: touchIdAvailable() && fs.existsSync(credsFile()),
}));

ipcMain.handle("vellum:touchid-save", (_event, creds) => {
  if (!touchIdAvailable()) return false;
  if (
    !creds ||
    typeof creds.email !== "string" ||
    typeof creds.password !== "string"
  ) {
    return false;
  }
  const blob = safeStorage.encryptString(
    JSON.stringify({ email: creds.email, password: creds.password }),
  );
  fs.writeFileSync(credsFile(), blob, { mode: 0o600 });
  return true;
});

ipcMain.handle("vellum:touchid-signin", async () => {
  if (!touchIdAvailable() || !fs.existsSync(credsFile())) return null;
  try {
    await systemPreferences.promptTouchID("sign in to your workspace");
  } catch {
    return null; // cancelled or failed — the renderer falls back to password
  }
  try {
    const raw = safeStorage.decryptString(fs.readFileSync(credsFile()));
    const parsed = JSON.parse(raw);
    return { email: String(parsed.email), password: String(parsed.password) };
  } catch {
    return null; // corrupt/unreadable blob — treat as not enrolled
  }
});

/* -------------------------- PDF export -------------------------- */
// The renderer hands over finished HTML; we render it in a hidden window and
// print that to PDF. Scripts are disabled in the print window — the HTML is
// generated from page content, so it must never execute.

ipcMain.handle("vellum:export-pdf", async (_event, payload) => {
  const html = payload?.html;
  if (typeof html !== "string") return { ok: false, error: "no content" };

  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: payload?.suggestedName || "page.pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  // A temp file rather than a data: URL — page content can exceed the URL
  // length limit, and this keeps relative-free HTML loading predictable.
  const tmp = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "vellum-pdf-")),
    "page.html",
  );
  const win = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, contextIsolation: true, sandbox: true },
  });
  try {
    fs.writeFileSync(tmp, html, "utf8");
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
    });
    fs.writeFileSync(filePath, pdf);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    win.destroy();
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
});

ipcMain.handle("vellum:touchid-clear", () => {
  try {
    fs.rmSync(credsFile(), { force: true });
  } catch {
    /* non-fatal */
  }
  return true;
});

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
    // dist/index.html is the marketing landing; the workspace is app.html.
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "app.html"));
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
