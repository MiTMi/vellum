const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vellum", {
  platform: process.platform,
  isElectron: true,
});

// Forward menu commands (⌘T / ⌘W) into the page as window events.
for (const channel of ["vellum:new-tab", "vellum:close-tab"]) {
  ipcRenderer.on(channel, () => {
    window.dispatchEvent(new CustomEvent(channel));
  });
}
