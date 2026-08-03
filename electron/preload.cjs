const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vellum", {
  platform: process.platform,
  isElectron: true,
  touchId: {
    status: () => ipcRenderer.invoke("vellum:touchid-status"),
    save: (email, password) =>
      ipcRenderer.invoke("vellum:touchid-save", { email, password }),
    signIn: () => ipcRenderer.invoke("vellum:touchid-signin"),
    clear: () => ipcRenderer.invoke("vellum:touchid-clear"),
  },
  exportPdf: (html, suggestedName) =>
    ipcRenderer.invoke("vellum:export-pdf", { html, suggestedName }),
});

// Forward menu commands (⌘T / ⌘W) into the page as window events.
for (const channel of ["vellum:new-tab", "vellum:close-tab"]) {
  ipcRenderer.on(channel, () => {
    window.dispatchEvent(new CustomEvent(channel));
  });
}
