# PDF Tool

Visualizzatore ed editor PDF desktop leggero e veloce (stile SumatraPDF per
la visualizzazione), scritto in Python con **PyMuPDF** (rendering/editing) e
**PySide6** (UI).

Tre modalità di visualizzazione (`Ctrl+6/7/8`, come SumatraPDF):

- **Pagina singola**: una pagina alla volta; `←`/`→` o `PgUp`/`PgDown` per
  voltare pagina (anche la rotella, a inizio/fine pagina);
- **Scorrimento** (default): scroll continuo verticale;
- **Libro**: copertina da sola, poi coppie di pagine affiancate.

I PDF si aprono anche **trascinandoli sulla finestra**.

Tutte le funzioni sono accessibili dalla **barra dei menu** (File, Visualizza,
Vai, Cerca); le scorciatoie sono indicate accanto a ogni voce, quindi non
serve impararle a memoria.

Altre funzioni:

- **Pannello laterale** (`F9`): indice/segnalibri del PDF e miniature delle
  pagine, per navigare nei documenti lunghi;
- **File recenti** (menu File) e **persistenza per documento**: pagina, zoom,
  modalità e rotazione si ricordano automaticamente per ogni file;
- **Rotazione** (`Ctrl+]` / `Ctrl+[`) e **stampa** (`Ctrl+P`);
- Su Windows, *File → Imposta come app predefinita per i PDF* registra PDF
  Tool tra le app disponibili e apre le Impostazioni di Windows per
  completare la scelta (richiede la build distribuita, non l'esecuzione da
  sorgente).

## Editing (Fase 2)

Una **toolbar sempre visibile** (sotto la barra dei menu) dà accesso rapido
alle azioni di editing più usate; le stesse azioni sono anche nei menu
**Modifica** e **Documento**, con le scorciatoie.

Strumenti (in Modifica; restano attivi finché non li disattivi, per
compilare/inserire più elementi di seguito):

- **Compila modulo** (`Ctrl+Shift+F`): i campi rilevati si evidenziano in
  blu; un clic su un campo testo apre un editor, un clic su una casella la
  spunta direttamente;
- **Aggiungi testo** (`Ctrl+Shift+T`): un clic sulla pagina apre un editor
  **direttamente sopra il testo** (niente popup) — si scrive lì, si conferma
  perdendo il focus o con `Ctrl+Invio`, si annulla con `Esc`;
- **Aggiungi immagine** (`Ctrl+Shift+I`): un clic sceglie il file immagine e
  la posiziona; resta **trascinabile** finché non la confermi (clic altrove,
  cambio strumento o salvataggio), poi viene impressa in modo permanente.

**Testo sempre spostabile**: senza nessuno strumento attivo, un clic su
un'annotazione di testo già inserita la rende trascinabile — non serve
riattivare "Aggiungi testo". (Le immagini invece, una volta impresse, non
sono più spostabili: il formato PDF non ha un vero equivalente di
"annotazione immagine" movibile come per il testo.)

**Annulla/Ripristina** (`Ctrl+Z` / `Ctrl+Y`): copre tutte le modifiche —
testo, immagini, campi modulo, pagine.

Dal menu **Documento**:

- **Unisci PDF…** accoda in fondo tutte le pagine di un altro file;
- **Elimina pagina corrente**;
- **Salva** (`Ctrl+S`) / **Salva con nome…** (`Ctrl+Shift+S`).

Il **pannello miniature** (`F9`) è anche un organizzatore di pagine:

- **trascina** una miniatura per riordinare le pagine;
- **Ctrl/Maiusc+clic** per selezionarne più di una;
- dal **menu contestuale** (clic destro) o da tastiera: **copia**
  (`Ctrl+C`), **taglia** (`Ctrl+X`), **incolla qui** (`Ctrl+V`, prima della
  miniatura scelta), **elimina** (`Canc`) — funzionano anche su più pagine
  selezionate insieme, e si può incollare pagine copiate da un documento in
  un altro aperto in un'altra finestra;
- **Inserisci PDF qui…** dal menu contestuale inserisce un altro file PDF
  esattamente tra due pagine, non solo in fondo.

Le modifiche non salvate sono segnalate con un punto (•) nel titolo della
finestra; chiudendo un documento modificato (o aprendone un altro) viene
chiesto se salvare.

## Avvio

```bash
cd ~/pdf-tool
venv/bin/python -m pdf_tool                      # apri poi con Ctrl+O
venv/bin/python -m pdf_tool examples/test.pdf    # apri un file da CLI
```

Per rigenerare il PDF di prova: `venv/bin/python examples/make_test_pdf.py`

Smoke test senza display: `QT_QPA_PLATFORM=offscreen venv/bin/python tests/smoke_test.py`

## Scorciatoie da tastiera

| Tasti                | Azione                                   |
|----------------------|------------------------------------------|
| `Ctrl+O`             | Apri file                                |
| `Ctrl+Q`             | Esci                                     |
| `Ctrl+rotella`       | Zoom (ancorato al puntatore)             |
| `Ctrl++` / `Ctrl+-`  | Zoom avanti / indietro                   |
| `Ctrl+1`             | Zoom 100%                                |
| `Ctrl+2`             | Adatta alla larghezza                    |
| `Ctrl+0`             | Adatta alla pagina                       |
| `PgUp` / `PgDown`    | Scorri di una schermata                  |
| `Home` / `End`       | Inizio / fine documento                  |
| `↑` / `↓`            | Scroll fine                              |
| `Ctrl+6` / `Ctrl+7` / `Ctrl+8` | Modalità: pagina singola / scorrimento / libro |
| `←` / `→`            | Pagina precedente / successiva (modalità paginate) |
| `Ctrl+G`             | Vai a pagina…                            |
| `Ctrl+F`             | Cerca (Invio: avanti, Maiusc+Invio: indietro, Esc: chiudi) |
| `F3` / `Maiusc+F3`   | Risultato successivo / precedente        |
| `F9`                 | Mostra/nascondi pannello laterale        |
| `Ctrl+]` / `Ctrl+[`  | Ruota a destra / sinistra                |
| `Ctrl+P`             | Stampa…                                  |
| `Ctrl+Shift+F/T/I`   | Strumento: compila modulo / aggiungi testo / aggiungi immagine |
| `Ctrl+Z` / `Ctrl+Y`  | Annulla / Ripristina                     |
| `Ctrl+S` / `Ctrl+Shift+S` | Salva / Salva con nome…             |

Nel pannello miniature: `Ctrl/Maiusc+clic` seleziona più pagine,
`Ctrl+C`/`Ctrl+X`/`Ctrl+V` copia/taglia/incolla, `Canc` elimina.

## Build portatile per Windows

Lo stesso codice gira su Windows. Per ottenere l'app portatile (nessuna
installazione, avviabile da cartella/chiavetta):

- **In locale su un PC Windows** (nella root del progetto):

  ```
  pip install -r requirements.txt pyinstaller
  pyinstaller packaging/pdf_tool_win.spec
  ```

  Il risultato è `dist/PDFTool/`: copia la cartella dove vuoi e avvia
  `PDFTool.exe`.

- **Con GitHub Actions**: pubblicando il repo su GitHub, il workflow
  `.github/workflows/build-windows.yml` produce l'artifact
  `PDFTool-windows-portable` (avvio manuale da Actions o push di un tag `v*`).

La build è in modalità *onedir* (cartella) e non *onefile*: il singolo `.exe`
autoestraente costerebbe secondi a ogni avvio, contro l'obiettivo di velocità.

## Architettura

```
pdf_tool/
├── app.py              # finestra principale, menu, dialoghi di editing, statusbar
├── __main__.py         # python -m pdf_tool
└── viewer/
    ├── document.py     # wrapper thread-safe di PyMuPDF (unico punto di contatto)
    ├── render.py       # cache LRU + task di rendering/ricerca su QThreadPool
    ├── view.py         # widget a scroll continuo, painting solo delle pagine visibili
    └── sidebar.py       # pannello laterale: indice/segnalibri e miniature
```

Scelte per la velocità:

- **rendering lazy**: si renderizzano solo le pagine visibili + 2 di prefetch,
  mai tutto il documento;
- **cache LRU** delle pagine renderizzate con budget in byte (~96 MB);
- **rendering fuori dal thread UI** (QThreadPool): lo scroll non si blocca mai,
  in attesa del render si mostra il render precedente riscalato;
- nessuna toolbar: UI ridotta a vista + statusbar.

`viewer/document.py` è l'unico punto di contatto con MuPDF: il rendering è
di sola lettura e chiamabile da thread worker, mentre le operazioni di
editing (form, testo, immagini, unione, riordino pagine, salvataggio) mutano
il documento in memoria sul thread UI — dopo vanno sempre seguite da un
refresh della vista (`PdfView.refresh_after_edit()` o `.reload_structure()`).
