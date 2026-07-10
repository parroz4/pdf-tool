# PDF Tool

Visualizzatore PDF desktop leggero e veloce (stile SumatraPDF), scritto in
Python con **PyMuPDF** (rendering) e **PySide6** (UI). Fase 1: solo viewer;
l'editing (annotazioni, firma, form) arriverà in Fase 2 come layer opzionale.

Tre modalità di visualizzazione (`Ctrl+6/7/8`, come SumatraPDF):

- **Pagina singola**: una pagina alla volta; `←`/`→` o `PgUp`/`PgDown` per
  voltare pagina (anche la rotella, a inizio/fine pagina);
- **Scorrimento** (default): scroll continuo verticale;
- **Libro**: copertina da sola, poi coppie di pagine affiancate.

I PDF si aprono anche **trascinandoli sulla finestra**.

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

## Architettura (Fase 1)

```
pdf_tool/
├── app.py              # finestra principale, barra ricerca, statusbar, scorciatoie
├── __main__.py         # python -m pdf_tool
└── viewer/
    ├── document.py     # wrapper thread-safe di PyMuPDF (unico punto di contatto)
    ├── render.py       # cache LRU + task di rendering/ricerca su QThreadPool
    └── view.py         # widget a scroll continuo, painting solo delle pagine visibili
```

Scelte per la velocità:

- **rendering lazy**: si renderizzano solo le pagine visibili + 2 di prefetch,
  mai tutto il documento;
- **cache LRU** delle pagine renderizzate con budget in byte (~96 MB);
- **rendering fuori dal thread UI** (QThreadPool): lo scroll non si blocca mai,
  in attesa del render si mostra il render precedente riscalato;
- nessuna toolbar: UI ridotta a vista + statusbar.

La Fase 2 (annotazioni, firma, form) si aggancerà a `viewer/document.py`
come modulo separato, caricato solo quando serve.
