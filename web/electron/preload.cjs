// Ponte minimo tra finestra e processo principale: solo l'apertura dei PDF
// passati all'app (doppio clic su un file, "Apri con", seconda istanza).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdfToolDesktop', {
  /** Il PDF con cui l'app è stata avviata, se c'è. */
  initialFile: () => ipcRenderer.invoke('initial-file'),
  /** Chiamata quando arriva un altro PDF mentre l'app è già aperta. */
  onOpenFile: (callback) => {
    ipcRenderer.on('open-file', (_event, file) => callback(file));
  },
});
