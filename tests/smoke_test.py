"""Smoke test senza display: apre il PDF di prova e verifica il rendering.

Uso: QT_QPA_PLATFORM=offscreen venv/bin/python tests/smoke_test.py

Verifica: creazione finestra, apertura documento, rendering asincrono
della prima pagina (cache popolata), ricerca testo, nessuna eccezione.
"""

import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pymupdf  # noqa: E402
from PySide6.QtCore import QEvent, QPoint, QPointF, QSettings, Qt, QTimer  # noqa: E402
from PySide6.QtGui import QColor, QImage, QMouseEvent  # noqa: E402
from PySide6.QtWidgets import (  # noqa: E402
    QApplication, QFileDialog, QInputDialog, QMessageBox,
)

# Le impostazioni persistenti (file recenti, stato per documento) vanno in
# una directory temporanea: il test non deve toccare la config reale.
_settings_dir = tempfile.mkdtemp(prefix="pdftool-test-settings-")
QSettings.setPath(QSettings.Format.IniFormat, QSettings.Scope.UserScope, _settings_dir)

# QMessageBox.question/critical aprono dialog modali: sotto la piattaforma
# offscreen il loro comportamento di blocco è inconsistente (a volte
# ritornano subito, a volte restano in attesa di un click che non arriverà
# mai). Il test non deve MAI dipendere da un vero dialog modale: qui li
# si sostituisce con stub che rispondono subito, e si segnala se
# `critical` viene mai invocato (indicherebbe un errore reale da indagare).
critical_calls = []
QMessageBox.question = staticmethod(
    lambda *a, **k: QMessageBox.StandardButton.Discard)
QMessageBox.critical = staticmethod(
    lambda *a, **k: critical_calls.append(a) or QMessageBox.StandardButton.Ok)

from pdf_tool.app import MainWindow  # noqa: E402
from pdf_tool.viewer.render import make_key  # noqa: E402
from pdf_tool.viewer.view import (  # noqa: E402
    MODE_BOOK, MODE_CONTINUOUS, MODE_SINGLE, TOOL_ADD_IMAGE,
)

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

        # Pagina successiva/precedente in modalità singola
        view.set_mode(MODE_SINGLE)
        view.goto_page(0)
        view.next_page()
        view.viewport().repaint()
        if view.current_page() != 1:
            failures.append(f"next_page: atteso 2, corrente {view.current_page() + 1}")
        else:
            print("OK: pagina successiva in modalità singola")

        # La barra di scorrimento deve coprire l'intero documento anche in
        # modalità paginate (non solo la pagina corrente)
        vbar = view.verticalScrollBar()
        if vbar.maximum() <= 0:
            failures.append("barra di scorrimento non copre l'intero documento in Pagina singola")
        else:
            print(f"OK: barra di scorrimento attiva in Pagina singola (max={vbar.maximum()})")
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

        # --- Fase 2: editing (testo, immagine, unione, riordino, form) ---
        # Lavora su una copia: gli edit non devono toccare il PDF di esempio.
        edit_src = os.path.join(tempfile.mkdtemp(prefix="pdftool-test-edit-"), "edit.pdf")
        shutil.copy(PDF, edit_src)
        edit_window = MainWindow(edit_src)
        edit_window.show()
        edit_view = edit_window.view
        if edit_view.doc is None:
            failures.append("editing: documento di test non aperto")
        else:
            initial_pages = edit_view.doc.page_count

            edit_view.doc.add_freetext(0, (50, 50, 250, 90), "Testo di prova")
            edit_view.refresh_after_edit()
            if not edit_view.doc.dirty:
                failures.append("editing: add_freetext non segna il documento come modificato")
            else:
                print("OK: editing - testo aggiunto (documento segnato come modificato)")

            # Undo/redo: annullare il testo appena aggiunto deve farlo sparire
            if not edit_view.doc.can_undo():
                failures.append("editing: can_undo() False dopo add_freetext")
            annots_before_undo = len(edit_view.doc.text_annots(0))
            edit_window.undo()
            annots_after_undo = len(edit_view.doc.text_annots(0))
            if annots_after_undo != annots_before_undo - 1:
                failures.append(
                    f"editing: undo non ha rimosso l'annotazione ({annots_before_undo} -> "
                    f"{annots_after_undo})")
            else:
                print("OK: editing - undo (rimuove il testo appena aggiunto)")
            edit_window.redo()
            if len(edit_view.doc.text_annots(0)) != annots_before_undo:
                failures.append("editing: redo non ha ripristinato l'annotazione")
            else:
                print("OK: editing - redo (ripristina il testo)")

            img_path = os.path.join(tempfile.mkdtemp(prefix="pdftool-test-img-"), "logo.png")
            img = QImage(30, 30, QImage.Format.Format_RGB32)
            img.fill(QColor("blue"))
            img.save(img_path)
            edit_view.doc.add_image(0, (260, 50, 300, 90), img_path)
            edit_view.refresh_after_edit()
            print("OK: editing - immagine inserita senza eccezioni")

            edit_view.doc.insert_pdf(PDF)
            edit_window._after_structural_edit()
            if edit_view.doc.page_count != initial_pages * 2:
                failures.append(
                    f"editing: unione PDF, atteso {initial_pages * 2} pagine, "
                    f"trovate {edit_view.doc.page_count}")
            else:
                print(f"OK: editing - unione PDF ({edit_view.doc.page_count} pagine)")

            last = edit_view.doc.page_count - 1
            edit_window._move_page(last, 0)
            if edit_view.doc.page_count != initial_pages * 2:
                failures.append("editing: move_page ha alterato il numero di pagine")
            else:
                print("OK: editing - riordino pagine (move_page)")

            # Nota: _delete_page() mostra un QMessageBox.question di conferma
            # (blocca in headless senza qualcuno che clicchi) - qui si testa
            # direttamente l'operazione sul documento, che è ciò che quella
            # dialog richiama dopo la conferma.
            before_delete = edit_view.doc.page_count
            edit_view.doc.delete_page(0)
            edit_window._after_structural_edit()
            if edit_view.doc.page_count != before_delete - 1:
                failures.append("editing: delete_page non ha rimosso la pagina")
            else:
                print(f"OK: editing - eliminazione pagina ({edit_view.doc.page_count} pagine)")

            # _hit_test: un clic dentro la prima pagina deve risolvere in
            # (pagina, punto), senza eccezioni
            edit_view.viewport().repaint()
            hit = edit_view._hit_test(QPoint(50, 50))
            if hit is None:
                failures.append("editing: _hit_test non trova la pagina sotto il cursore")
            else:
                print(f"OK: editing - _hit_test risolve in pagina {hit[0]}, punto {hit[1]}")

            saved_pages = edit_view.doc.page_count
            edit_window.save_document()
            if edit_view.doc.dirty:
                failures.append("editing: il documento risulta ancora modificato dopo il salvataggio")
            else:
                print("OK: editing - salvataggio (dirty tornato a False)")
            edit_window.close()  # non dirty: nessuna dialog di conferma

            reopened = MainWindow(edit_src)
            reopened.show()
            if reopened.view.doc is None or reopened.view.doc.page_count != saved_pages:
                failures.append("editing: le modifiche non risultano persistite su disco")
            else:
                print(f"OK: editing - modifiche persistite su disco ({saved_pages} pagine)")
            reopened.close()

        # Compilazione modulo: PDF con un campo testo, generato al volo.
        # QInputDialog è sostituito con uno stub per evitare un vero popup
        # modale (bloccante) durante il test automatico.
        form_doc = pymupdf.open()
        form_page = form_doc.new_page(width=300, height=300)
        widget = pymupdf.Widget()
        widget.field_name = "campo"
        widget.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
        widget.field_type_string = "Text"
        widget.rect = pymupdf.Rect(50, 50, 200, 80)
        widget.field_value = ""
        form_page.add_widget(widget)
        form_path = os.path.join(tempfile.mkdtemp(prefix="pdftool-test-form-"), "form.pdf")
        form_doc.save(form_path)
        form_doc.close()

        form_window = MainWindow(form_path)
        form_window.show()
        original_get_text = QInputDialog.getMultiLineText
        QInputDialog.getMultiLineText = staticmethod(
            lambda *a, **k: ("Valore compilato", True))
        try:
            form_window._fill_form_field_at(0, (100, 60))
        finally:
            QInputDialog.getMultiLineText = original_get_text
        widgets_after = form_window.view.doc.widgets(0)
        if widgets_after and widgets_after[0]["value"] == "Valore compilato":
            print("OK: editing - compilazione campo modulo (_fill_form_field_at)")
        else:
            failures.append(f"editing: campo modulo non compilato correttamente ({widgets_after})")
        # Non chiuso volutamente: ha modifiche non salvate e close()
        # mostrerebbe una vera dialog di conferma (blocca in headless).
        # app.quit() più sotto termina comunque il loop senza invocare
        # closeEvent sulle finestre rimaste aperte.

        # _add_image_at: anche qui il file dialog è sostituito con uno stub.
        # L'immagine resta "in sospeso" (trascinabile) finché non si
        # conferma: il documento non deve risultare modificato subito.
        img2_window = MainWindow(edit_src)
        img2_window.show()
        # Attiva davvero lo strumento (passa da _toggle_tool, come farebbe
        # un clic sul pulsante): altrimenti lo spegnimento più sotto non
        # genera un cambio di stato reale e non scatta la conferma.
        img2_window._tool_actions[TOOL_ADD_IMAGE].setChecked(True)
        original_get_open = QFileDialog.getOpenFileName
        QFileDialog.getOpenFileName = staticmethod(lambda *a, **k: (img_path, ""))
        try:
            img2_window._add_image_at(0, (100, 100))
        finally:
            QFileDialog.getOpenFileName = original_get_open
        if img2_window.view.doc.dirty or img2_window.view._pending_image is None:
            failures.append("editing: _add_image_at doveva lasciare un'immagine in sospeso")
        else:
            print("OK: editing - _add_image_at (immagine in sospeso, non ancora impressa)")

        # Trascinamento dell'immagine in sospeso: simula press/move/release
        pi = img2_window.view._pending_image
        x0, y0 = pi["x"], pi["y"]
        press = QMouseEvent(
            QEvent.Type.MouseButtonPress,
            QPointF(x0 + pi["w"] / 2, y0 + pi["h"] / 2),
            Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
        img2_window.view.mousePressEvent(press)
        move = QMouseEvent(
            QEvent.Type.MouseMove,
            QPointF(x0 + pi["w"] / 2 + 30, y0 + pi["h"] / 2 + 15),
            Qt.MouseButton.NoButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
        img2_window.view.mouseMoveEvent(move)
        release = QMouseEvent(
            QEvent.Type.MouseButtonRelease,
            QPointF(x0 + pi["w"] / 2 + 30, y0 + pi["h"] / 2 + 15),
            Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier)
        img2_window.view.mouseReleaseEvent(release)
        pi_after_drag = img2_window.view._pending_image
        if pi_after_drag is None or (pi_after_drag["x"], pi_after_drag["y"]) == (x0, y0):
            failures.append("editing: il trascinamento dell'immagine in sospeso non ha spostato nulla")
        else:
            print(f"OK: editing - immagine in sospeso trascinata "
                  f"({x0:.0f},{y0:.0f}) -> ({pi_after_drag['x']:.0f},{pi_after_drag['y']:.0f})")

        # Conferma: cambiare strumento imprime l'immagine sulla pagina
        img2_window._tool_actions[TOOL_ADD_IMAGE].setChecked(False)
        if img2_window.view._pending_image is not None or not img2_window.view.doc.dirty:
            failures.append("editing: il cambio di strumento non ha confermato l'immagine in sospeso")
        else:
            print("OK: editing - immagine impressa alla conferma (cambio strumento)")

        # Editor di testo inline: apertura, digitazione, chiusura per
        # perdita del focus (commit) -> deve comparire una nuova annotazione
        annots_before = len(img2_window.view.doc.text_annots(0))
        img2_window.view._open_text_editor(0, (60, 400))
        editor = img2_window.view._text_editor
        if editor is None:
            failures.append("editing: _open_text_editor non ha creato l'editor inline")
        else:
            editor.setPlainText("Scritto direttamente sulla pagina")
            img2_window.view._close_text_editor(commit=True)
            annots_after = len(img2_window.view.doc.text_annots(0))
            if annots_after != annots_before + 1:
                failures.append(
                    f"editing: editor inline, annotazioni {annots_before} -> {annots_after}")
            else:
                print("OK: editing - editor di testo inline (scrittura diretta sulla pagina)")

            # Spostamento dell'annotazione appena creata (nessuno strumento
            # attivo: si trascina direttamente, come da richiesta)
            annot = img2_window.view.doc.text_annots(0)[-1]
            rx0, ry0, rx1, ry1 = img2_window.view.doc.to_pixel_rect(
                0, annot["rect"], img2_window.view.zoom, img2_window.view.rotation)
            origin = img2_window.view._page_origin(0)
            if origin is not None:
                ox, oy = origin
                cx, cy = ox + (rx0 + rx1) / 2, oy + (ry0 + ry1) / 2
                press2 = QMouseEvent(
                    QEvent.Type.MouseButtonPress, QPointF(cx, cy),
                    Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
                    Qt.KeyboardModifier.NoModifier)
                img2_window.view.mousePressEvent(press2)
                if img2_window.view._drag is None:
                    failures.append("editing: clic su un'annotazione di testo non avvia il trascinamento")
                else:
                    move2 = QMouseEvent(
                        QEvent.Type.MouseMove, QPointF(cx + 40, cy + 20),
                        Qt.MouseButton.NoButton, Qt.MouseButton.LeftButton,
                        Qt.KeyboardModifier.NoModifier)
                    img2_window.view.mouseMoveEvent(move2)
                    release2 = QMouseEvent(
                        QEvent.Type.MouseButtonRelease, QPointF(cx + 40, cy + 20),
                        Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton,
                        Qt.KeyboardModifier.NoModifier)
                    img2_window.view.mouseReleaseEvent(release2)
                    moved_rect = img2_window.view.doc.text_annots(0)[-1]["rect"]
                    if moved_rect == annot["rect"]:
                        failures.append("editing: il trascinamento non ha spostato l'annotazione")
                    else:
                        print(f"OK: editing - annotazione di testo spostata "
                              f"({annot['rect']} -> {moved_rect})")

        img2_window.save_document()
        img2_window.close()

        if critical_calls:
            failures.append(
                f"QMessageBox.critical invocato {len(critical_calls)} volta/e durante il "
                f"test (probabile errore reale, non solo un dettaglio dell'headless): "
                f"{[str(c[1:]) for c in critical_calls]}")
        else:
            print("OK: nessun errore critico (QMessageBox.critical) durante il test")

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
