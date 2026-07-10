"""Smoke test senza display: apre il PDF di prova e verifica il rendering.

Uso: QT_QPA_PLATFORM=offscreen venv/bin/python tests/smoke_test.py

Verifica: creazione finestra, apertura documento, rendering asincrono
della prima pagina (cache popolata), ricerca testo, nessuna eccezione.
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QTimer  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from pdf_tool.app import MainWindow  # noqa: E402
from pdf_tool.viewer.render import make_key  # noqa: E402

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
