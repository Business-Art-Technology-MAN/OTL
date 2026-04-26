const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("marketLab", {
  ping: () => ipcRenderer.invoke("mlab-ping"),
  loadData: (/** @type {string} */ path) => ipcRenderer.invoke("mlab-load", path),
  seek: (/** @type {string} */ timeToken) => ipcRenderer.invoke("mlab-seek", timeToken),
  setUberSignal: (/** @type {string} */ json) => ipcRenderer.invoke("mlab-set-uber", json),
  setPortfolioConfig: (/** @type {string} */ json) =>
    ipcRenderer.invoke("mlab-set-portfolio", json),
  /** @param {string} filePath */
  exportAnalysisCsv: (filePath) => ipcRenderer.invoke("mlab-export-csv", filePath),
  pickCsv: () => ipcRenderer.invoke("mlab-pick-csv"),
  pickCsvExport: () => ipcRenderer.invoke("mlab-pick-csv-export")
});
