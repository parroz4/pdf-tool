"""Smoke test senza display: apre il PDF di prova e verifica il rendering.

Uso: QT_QPA_PLATFORM=offscreen venv/bin/python tests/smoke_test.py

Verifica: creazione finestra, apertura documento, rendering asincrono
della prima pagina (cache popolata), ricerca testo, nessuna eccezione.
"""

import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QSettings, QTimer  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

# Le impostazioni persistenti (file recenti, stato per documento) vanno in
# una directory temporanea: il test non deve toccare la config reale.
_settings_dir = tempfile.mkdtemp(prefix="pdftool-test-settings-")
QSettings.setPath(QSettings.Format.IniFormat, QSettings.Scope.UserScope, _settings_dir)

from pdf_tool.app import MainWindow  # noqa: E402
from pdf_tool.viewer.render import make_key  # noqa: E402
from pdf_tool.viewer.view import MODE_BOOK, MODE_CONTINUOUS, MODE_SINGLE  # noqa: E402

PDF = os.path.join(ROOT, "examples", "test.pdf")

failures = []


def main():
    app = QApplication([])
    window = MainWindow(PDF)
    window.show()

    view = window.view
    if view.doc is None:
        print("FAIL: documento non aperto")
        return 1
    print(f"OK: documento aperto ({view.doc.page_count} pagine, zoom {view.zoom:.2f})")

    # Forza un ciclo di paint (accoda i render asincroni)
    view.viewport().repaint()

    def check_render():
        key = make_key(0, view.zoom)
        image = view._cache.get(key)
        if image is None:
            failures.append("prima pagina non renderizzata entro il timeout")
        else:
            print(f"OK: prima pagina renderizzata ({image.width()}x{image.height()} px)")

        # Ricerca sincrona diretta sul documento
        hits = view.doc.search("velocita")
        total = sum(len(v) for v in hits.values())
        if total == 0:
            failures.append("ricerca testo senza risultati")
        else:
            print(f"OK: ricerca 'velocita' -> {total} risultati in {len(hits)} pagine")
            view.set_search_results(hits)
            view.goto_hit(1)
            view.viewport().repaint()
            print(f"OK: evidenziazione e salto al risultato {view.current_hit_index() + 1}")

        # Navigazione base
        view.goto_page(view.doc.page_count - 1)
        view.viewport().repaint()
        print(f"OK: goto ultima pagina (corrente: {view.current_page() + 1})")
        view.zoom_in()
        view.viewport().repaint()
        print(f"OK: zoom in (zoom {view.zoom:.2f})")

        # Modalità di visualizzazione: la pagina corrente si deve conservare
        view.goto_page(2)
        before = view.current_page()
        for mode, name in ((MODE_SINGLE, "pagina singola"),
                           (MODE_BOOK, "libro"),
                           (MODE_CONTINUOUS, "scorrimento")):
            view.set_mode(mode)
            view.viewport().repaint()
            after = view.current_page()
            # In modalità libro la pagina 2 può stare in una coppia: basta
            # che la riga mostrata contenga la pagina di partenza.
            row_pages = view._rows[view._row_of[before]]
            if after != before and before not in row_pages:
                failures.append(
                    f"cambio modalità '{name}': pagina {before} -> {after}")
            else:
                print(f"OK: modalità '{name}' (pagina corrente {after + 1})")

        # Flip di pagina in modalità singola
        view.set_mode(MODE_SINGLE)
        view.goto_page(0)
        view._flip(1)
        view.viewport().repaint()
        if view.current_page() != 1:
            failures.append(f"flip pagina: atteso 2, corrente {view.current_page() + 1}")
        else:
            print("OK: flip alla pagina successiva in modalità singola")
        view.set_mode(MODE_CONTINUOUS)

        # Rotazione: a 90/270 gradi largh. e alt. della pagina si scambiano,
        # e la cache non deve confondere immagini a rotazioni diverse
        view.goto_page(0)
        w0, h0 = view._page_geo[0][3], view._page_geo[0][4]
        view.rotate_right()
        view.viewport().repaint()
        w90, h90 = view._page_geo[0][3], view._page_geo[0][4]
        if (w90, h90) != (h0, w0):
            failures.append(f"rotazione 90°: geometria {w0}x{h0} -> {w90}x{h90} (atteso scambio)")
        else:
            print(f"OK: rotazione 90° (geometria {w0}x{h0} -> {w90}x{h90})")
        key0 = make_key(0, view.zoom, 0)
        key90 = make_key(0, view.zoom, 90)
        if view._cache.get(key0) is not None and view._cache.get(key90) is not None \
                and view._cache.get(key0) is view._cache.get(key90):
            failures.append("cache non distingue rotazioni diverse")
        view.rotate_left()
        view.viewport().repaint()
        if view.rotation != 0:
            failures.append(f"rotazione: atteso ritorno a 0°, corrente {view.rotation}")

        # Persistenza: pagina/zoom/modalità devono sopravvivere alla chiusura
        view.goto_page(3)
        view.set_zoom(2.0)
        view.set_mode(MODE_SINGLE)
        window._remember_doc_state(view.doc.path)
        window._save_settings()
        window.close()

        window2 = MainWindow(PDF)
        window2.show()
        v2 = window2.view
        if (v2.current_page(), round(v2.zoom, 2), v2.mode) != (3, 2.0, MODE_SINGLE):
            failures.append(
                f"stato non ripristinato: pagina {v2.current_page()}, "
                f"zoom {v2.zoom:.2f}, modo {v2.mode} (atteso 3, 2.00, {MODE_SINGLE})")
        else:
            print("OK: pagina/zoom/modalità ripristinati alla riapertura")
        if window2._recent_files and os.path.samefile(window2._recent_files[0], PDF):
            print("OK: file recenti aggiornato")
        else:
            failures.append("file recenti non aggiornato correttamente")
        window2.close()

        app.quit()

    # Lascia 3 secondi al thread pool per il render della prima pagina
    QTimer.singleShot(3000, check_render)
    app.exec()

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        return 1
    print("SMOKE TEST SUPERATO")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
