// Guscio desktop di PDF Tool (Electron): mostra la build di produzione
// (web/dist) in una finestra, senza server e senza rete. I file dell'app sono
// serviti dallo schema privato app://, così moduli ES, worker, wasm e fetch
// funzionano come su un sito.
const { app, BrowserWindow, Menu, ipcMain, net, protocol, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/** Il primo argomento che è un PDF esistente (doppio clic su un file, "Apri con"). */
function pdfFromArgs(argv) {
  for (const arg of argv.slice(1)) {
    if (/\.pdf$/i.test(arg) && fs.existsSync(arg)) return path.resolve(arg);
  }
  return null;
}

let win = null;
let pendingFile = pdfFromArgs(process.argv);

function readPdf(file) {
  return { name: path.basename(file), data: fs.readFileSync(file) };
}

function sendFile(file) {
  if (!win) {
    pendingFile = file;
    return;
  }
  try {
    win.webContents.send('open-file', readPdf(file));
  } catch (e) {
    console.error('Apertura non riuscita', e);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: '#e4e4e7',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
  });
  // I link esterni si aprono nel browser di sistema, non nell'app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  void win.loadURL('app://pdf-tool/index.html');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const file = pdfFromArgs(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    if (file) sendFile(file);
  });

  app.whenReady().then(() => {
    protocol.handle('app', (request) => {
      const { pathname } = new URL(request.url);
      const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
      // mai fuori dalla cartella dell'app
      if (file !== DIST && !file.startsWith(DIST + path.sep)) {
        return new Response('Not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(file).toString());
    });

    // Il renderer chiede il file con cui l'app è stata avviata, quando è pronto.
    ipcMain.handle('initial-file', () => {
      const file = pendingFile;
      pendingFile = null;
      if (!file) return null;
      try {
        return readPdf(file);
      } catch {
        return null;
      }
    });

    Menu.setApplicationMenu(null);
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
