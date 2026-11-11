# PDF Tool — versione web

Visualizzatore ed editor PDF che gira **interamente nel browser**: nessun
backend, nessun file lascia il computer. L'obiettivo è la reattività di
SumatraPDF, non la pesantezza di Adobe Reader.

Stack: Vite + React + TypeScript (strict) + Tailwind CSS, **pdf.js** per il
rendering, **pdf-lib** per le modifiche.

## Avvio

```bash
cd web
npm install
npm run dev      # sviluppo, http://localhost:5173
npm run build    # controllo dei tipi + build di produzione in web/dist
npm run preview  # serve la build di produzione
```

`web/dist` è un sito statico: si può pubblicare su qualunque hosting di file
statici (i percorsi sono relativi, quindi funziona anche in una sottocartella).

## App desktop per Windows

La stessa app si può usare senza browser, come programma installabile
(Electron): finestra propria, collegamento nel menu Start, apertura dei PDF
con doppio clic o *Apri con*.

```bash
npm run desktop    # build + avvio dell'app desktop, senza installare
npm run dist:win   # crea l'installer in web/release/PDF-Tool-Setup-<versione>.exe
```

L'installer non è firmato: al primo avvio Windows SmartScreen può mostrare un
avviso. I PDF protetti da password non si aprono nell'app desktop (manca la
finestra di richiesta della password).

## Funzioni

**Viewer**

- scorrimento continuo virtualizzato: nel DOM ci sono solo le pagine visibili
  più una di margine;
- zoom (Ctrl+rotella ancorato al puntatore, `Ctrl +`/`-`, adatta
  larghezza/pagina, percentuali fisse), navigazione per numero di pagina;
- ricerca testo incrementale (`Ctrl+F`, `Invio`/`Maiusc+Invio`);
- selezione e copia del testo;
- pannello miniature (`F4`), anch'esso virtualizzato.

**Editor**

- immagini: dal pulsante, trascinate sulla pagina o incollate (`Ctrl+V`);
  spostabili e ridimensionabili;
- caselle di testo (doppio clic per rimodificarle), colore e dimensione;
- testo già presente nella pagina: doppio clic su una riga la trasforma in una
  casella modificabile (l'originale viene coperto, non rimosso dal file);
- OCR (pulsante *OCR*, `Maiusc`+clic per tutte le pagine): riconosce il testo
  delle scansioni con Tesseract, in italiano, dentro il browser. Il testo
  riconosciuto si può selezionare, cercare e modificare con un doppio clic;
  per ora non viene scritto nel PDF esportato come testo ricercabile;
- disegno a mano libera, evidenziatore, rettangoli, con colore e spessore;
- pagine: riordino trascinando le miniature, selezione multipla
  (`Ctrl`/`Maiusc`+clic), eliminazione (`Canc`);
- unione: pulsante *Unisci* (in fondo) oppure rilascio di un PDF sul pannello
  miniature (nel punto scelto);
- compilazione dei moduli AcroForm (testo, caselle, radio, menu a tendina);
- annulla/ripristina (`Ctrl+Z` / `Ctrl+Y`) per tutte le modifiche;
- *Esporta PDF* (`Ctrl+S`) scarica il file modificato.

## Scelte per la velocità

- **Virtualizzazione**: le pagine sono posizionate in modo assoluto in un
  contenitore alto quanto il documento; si montano solo quelle nel viewport.
- **Rendering fuori dal thread UI**: parsing nel worker di pdf.js e disegno
  nel *renderer worker* (OffscreenCanvas); lo scroll non aspetta il render.
- **Cache LRU** dei canvas già renderizzati (budget ~96 MB): tornare su una
  pagina vista è immediato. Durante lo zoom il canvas esistente viene
  riscalato via CSS e ridisegnato solo quando la scala si ferma.
- **Apertura immediata**: si legge solo la prima pagina; le dimensioni delle
  altre vengono corrette in background.
- **Editor lazy**: pdf-lib (~420 kB) si scarica alla prima esportazione; il
  livello di editing, quello dei moduli e la gestione immagini sono chunk
  separati caricati al primo uso. Aprire un PDF in sola lettura non carica
  nulla di tutto ciò.

## Struttura

```
src/
├── state/store.ts      # stato immutabile, cronologia annulla/ripristina
├── state/actions.ts    # apri, unisci, esporta, smistamento dei file
├── pdf/pdfjs.ts        # unico punto di contatto con pdf.js, cache dei render
├── viewer/             # Viewer (virtualizzazione), PageView, miniature, ricerca
├── editor/             # chunk lazy: EditorLayer, FormLayer, images, export
└── ui/                 # toolbar e icone
```

## Stato: cosa è verificato e cosa no

### Verificato

`npm run build` passa (TypeScript strict). La suite `tests/e2e.cjs` pilota la
**build di produzione in Chromium headless** con Playwright e supera 50
controlli su 50:

| Area | Cosa viene controllato |
|------|------------------------|
| Apertura | PDF aperto, pagina renderizzata, livello testo allineato, miniature |
| Lazy loading | nessun chunk editor in sola lettura; `images`/`EditorLayer` al primo uso; pdf-lib solo all'esportazione; `FormLayer` solo con moduli |
| Immagine | inserimento, spostamento, ridimensionamento proporzionale; nel PDF esportato **e riaperto** l'immagine è nel punto giusto |
| Documento lungo | 800 pagine: al massimo 4 pagine nel DOM; scroll con frame p95 ≈ 16,7 ms (max ≈ 33 ms); salto all'ultima pagina; zoom Ctrl+rotella; adatta pagina |
| Ricerca | 8 risultati su 800 pagine, navigazione, posizione dell'evidenziazione |
| Strumenti | testo (accenti, a capo), rettangolo, evidenziatore, disegno, spostamento, annulla/ripristina; tutto ritrovato nel PDF esportato e riaperto |
| Pagine | riordino trascinando una miniatura, unione di un secondo PDF, eliminazione; ordine delle pagine verificato nel file esportato |
| Moduli | compilazione di testo, multiriga, casella, radio, tendina; valori riletti dal PDF esportato (campi ancora compilabili) |
| Rotazione | pagina con `/Rotate 90` e CropBox spostato: immagine (rilasciata con drag&drop) e rettangolo esportati nel punto giusto |

Per rieseguirla:

```bash
npm run build && node tests/make-fixtures.mjs && npm run test:e2e
```

(richiede il pacchetto `playwright` risolvibile da Node, con il suo Chromium).

### Implementato ma non coperto dai test automatici

- selezione multipla delle miniature e riordino di più pagine insieme;
- rilascio di un file PDF sul pannello miniature per inserirlo in un punto;
- immagini incollate dagli appunti; formati diversi da PNG/JPEG (WebP, GIF,
  SVG, BMP: convertiti in PNG) e JPEG con orientamento EXIF (ricodificati);
- PDF protetti da password (richiesta della password all'apertura);
- caselle a selezione multipla (list box) nei moduli;
- tema scuro (controllato solo a vista).

### Non verificato

- **Altri browser**: provato solo Chromium. Firefox e Safari non sono stati
  provati.
- **PDF reali pesanti**: la fluidità è misurata su un PDF sintetico di 800
  pagine di testo, in headless. Scansioni ad alta risoluzione o pagine con
  grafica vettoriale molto complessa non sono state misurate.
- **Dispositivi touch**: l'interfaccia è pensata per mouse e tastiera.

### Limiti noti

- Le caselle di testo usano Helvetica standard: i caratteri fuori dal set
  WinAnsi (emoji, cirillico, CJK…) vengono sostituiti con «?» all'esportazione,
  con un avviso. Le lettere accentate italiane funzionano.
- Le modifiche vengono scritte nel contenuto della pagina: riaprendo il PDF
  esportato non sono più spostabili.
- Se le pagine vengono riordinate, eliminate o unite da più file, il PDF viene
  ricostruito: le pagine eliminate spariscono davvero dal file, ma i moduli
  vengono **appiattiti** (valori visibili, non più modificabili) e i
  **segnalibri si perdono**. Senza modifiche alla struttura il file originale
  viene aggiornato sul posto e conserva moduli compilabili, segnalibri e
  metadati.
- I PDF cifrati si possono leggere ma non esportare (pdf-lib non li supporta).
- Un'annotazione non si può trascinare da una pagina all'altra; le miniature
  non mostrano le annotazioni; non c'è rotazione delle pagine, stampa né
  pannello dei segnalibri (li ha l'app desktop).
- Campi firma, pulsanti e script JavaScript dei moduli non sono gestiti.
- La ricerca non distingue maiuscole/minuscole e non normalizza gli accenti;
  le evidenziazioni dei risultati sono approssimate sulla larghezza del testo.
