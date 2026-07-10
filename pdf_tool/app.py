"""PDF Tool — visualizzatore PDF leggero e veloce (Fase 1).

UI minimale: solo la vista, una barra di ricerca sottile (Ctrl+F) e la
statusbar. Tutto il resto passa dalle scorciatoie da tastiera.
L'editing (annotazioni, firma, form) arriverà in Fase 2 come layer
opzionale sopra `viewer.document`, senza appesantire il viewer.
"""

from __future__ import annotations

import os
import sys

from PySide6.QtCore import Qt, QThreadPool
from PySide6.QtGui import QAction, QActionGroup, QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QApplication, QFileDialog, QHBoxLayout, QInputDialog, QLabel, QLineEdit,
    QMainWindow, QMessageBox, QToolButton, QVBoxLayout, QWidget,
)

from .viewer.document import DocumentError
from .viewer.render import SearchSignals, SearchTask
from .viewer.view import (
    MODE_BOOK, MODE_CONTINUOUS, MODE_NAMES, MODE_SINGLE, PdfView,
)

APP_NAME = "PDF Tool"


class SearchBar(QWidget):
    """Barra di ricerca sottile, nascosta finché non serve (Ctrl+F)."""

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(6, 2, 6, 2)
        layout.setSpacing(6)
        self.edit = QLineEdit(self)
        self.edit.setPlaceholderText("Cerca…  (Invio: avanti, Maiusc+Invio: indietro, Esc: chiudi)")
        self.count_label = QLabel("", self)
        close_btn = QToolButton(self)
        close_btn.setText("✕")
        close_btn.setAutoRaise(True)
        close_btn.clicked.connect(self.hide)
        layout.addWidget(self.edit, 1)
        layout.addWidget(self.count_label)
        layout.addWidget(close_btn)
        self.setMaximumHeight(30)


class MainWindow(QMainWindow):
    def __init__(self, path: str | None = None):
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.resize(900, 1000)
        self.setAcceptDrops(True)

        self.view = PdfView(self)
        self.search_bar = SearchBar(self)
        self.search_bar.hide()

        central = QWidget(self)
        layout = QVBoxLayout(central)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addWidget(self.search_bar)
        layout.addWidget(self.view, 1)
        self.setCentralWidget(central)

        # Statusbar: modalità, pagina e zoom
        self.mode_label = QLabel(MODE_NAMES[self.view.mode] + "  ")
        self.page_label = QLabel("—")
        self.zoom_label = QLabel("—")
        self.statusBar().addPermanentWidget(self.mode_label)
        self.statusBar().addPermanentWidget(self.zoom_label)
        self.statusBar().addPermanentWidget(self.page_label)
        self.view.pageChanged.connect(
            lambda cur, tot: self.page_label.setText(f"Pagina {cur} / {tot}"))
        self.view.zoomChanged.connect(
            lambda z: self.zoom_label.setText(f"{round(z * 100)}%  "))
        self.view.modeChanged.connect(
            lambda name: self.mode_label.setText(name + "  "))

        # Stato ricerca
        self._search_signals = SearchSignals()
        self._search_signals.finished.connect(self._on_search_finished)
        self._search_generation = 0
        self._last_query = ""

        self._setup_menu()
        self._setup_search_bar_keys()

        if path:
            self.open_path(path)
        else:
            self.statusBar().showMessage("Ctrl+O per aprire un PDF, o trascina qui un file")

    # ------------------------------------------------------------------ menu

    def _setup_menu(self):
        def act(menu, text, slot, shortcut=None, checkable=False, group=None):
            action = QAction(text, self)
            if shortcut is not None:
                action.setShortcut(QKeySequence(shortcut))
                action.setShortcutContext(Qt.ShortcutContext.WindowShortcut)
            action.setCheckable(checkable)
            if group is not None:
                group.addAction(action)
            # lambda: le slot non devono ricevere il bool `checked` di triggered
            action.triggered.connect(lambda checked=False, s=slot: s())
            menu.addAction(action)
            return action

        bar = self.menuBar()

        m_file = bar.addMenu("&File")
        act(m_file, "&Apri…", self.open_dialog, QKeySequence.StandardKey.Open)
        m_file.addSeparator()
        act(m_file, "&Esci", self.close, QKeySequence.StandardKey.Quit)

        m_view = bar.addMenu("&Visualizza")
        mode_group = QActionGroup(self)
        self._mode_actions = {}
        for mode, label, seq in (
                (MODE_SINGLE, "Pagina &singola", "Ctrl+6"),
                (MODE_CONTINUOUS, "S&corrimento continuo", "Ctrl+7"),
                (MODE_BOOK, "&Libro (pagine affiancate)", "Ctrl+8")):
            self._mode_actions[mode] = act(
                m_view, label, lambda m=mode: self.view.set_mode(m),
                seq, checkable=True, group=mode_group)
        self._mode_actions[self.view.mode].setChecked(True)
        self.view.modeChanged.connect(
            lambda _: self._mode_actions[self.view.mode].setChecked(True))
        m_view.addSeparator()
        act(m_view, "&Ingrandisci", self.view.zoom_in, "Ctrl++")
        act(m_view, "&Riduci", self.view.zoom_out, "Ctrl+-")
        act(m_view, "Zoom &100%", lambda: self.view.set_zoom(1.0), "Ctrl+1")
        act(m_view, "Adatta &larghezza", self.view.fit_width, "Ctrl+2")
        act(m_view, "Adatta &pagina", self.view.fit_page, "Ctrl+0")

        m_go = bar.addMenu("V&ai")
        act(m_go, "Pagina &successiva", self.view.next_page)
        act(m_go, "Pagina &precedente", self.view.prev_page)
        m_go.addSeparator()
        act(m_go, "P&rima pagina", lambda: self.view.goto_page(0))
        act(m_go, "&Ultima pagina", self._goto_last_page)
        m_go.addSeparator()
        act(m_go, "&Vai a pagina…", self.goto_page_dialog, "Ctrl+G")

        m_search = bar.addMenu("&Cerca")
        act(m_search, "&Cerca nel documento…", self.show_search,
            QKeySequence.StandardKey.Find)
        act(m_search, "Risultato &successivo", lambda: self._jump_hit(1),
            QKeySequence.StandardKey.FindNext)
        act(m_search, "Risultato &precedente", lambda: self._jump_hit(-1),
            QKeySequence.StandardKey.FindPrevious)

    def _goto_last_page(self):
        if self.view.doc is not None:
            self.view.goto_page(self.view.doc.page_count - 1)

    # ------------------------------------------------------------- shortcuts

    def _setup_search_bar_keys(self):
        self.search_bar.edit.returnPressed.connect(self._search_or_next)
        esc = QShortcut(QKeySequence(Qt.Key.Key_Escape), self.search_bar.edit)
        esc.setContext(Qt.ShortcutContext.WidgetShortcut)
        esc.activated.connect(self.hide_search)
        shift_ret = QShortcut(QKeySequence("Shift+Return"), self.search_bar.edit)
        shift_ret.setContext(Qt.ShortcutContext.WidgetShortcut)
        shift_ret.activated.connect(lambda: self._jump_hit(-1))

    # ------------------------------------------------------------- documento

    def open_dialog(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "Apri PDF", "", "Documenti PDF (*.pdf);;Tutti i file (*)")
        if path:
            self.open_path(path)

    def open_path(self, path: str):
        try:
            self.view.load(path)
        except DocumentError as exc:
            QMessageBox.critical(self, APP_NAME, f"Impossibile aprire il file:\n{exc}")
            return
        self.hide_search()
        self.setWindowTitle(f"{os.path.basename(path)} — {APP_NAME}")
        self.statusBar().showMessage(path)
        self.view.setFocus()

    # ----------------------------------------------------------- drag & drop

    @staticmethod
    def _dropped_pdf(event) -> str | None:
        for url in event.mimeData().urls():
            if url.isLocalFile() and url.toLocalFile().lower().endswith(".pdf"):
                return url.toLocalFile()
        return None

    def dragEnterEvent(self, event):
        if self._dropped_pdf(event) is not None:
            event.acceptProposedAction()

    def dropEvent(self, event):
        path = self._dropped_pdf(event)
        if path is not None:
            event.acceptProposedAction()
            self.open_path(path)

    def goto_page_dialog(self):
        if self.view.doc is None:
            return
        total = self.view.doc.page_count
        page, ok = QInputDialog.getInt(
            self, "Vai a pagina", f"Pagina (1–{total}):",
            self.view.current_page() + 1, 1, total)
        if ok:
            self.view.goto_page(page - 1)

    # --------------------------------------------------------------- ricerca

    def show_search(self):
        if self.view.doc is None:
            return
        self.search_bar.show()
        self.search_bar.edit.setFocus()
        self.search_bar.edit.selectAll()

    def hide_search(self):
        self._search_generation += 1  # annulla ricerche in corso
        self._last_query = ""
        self.search_bar.hide()
        self.search_bar.count_label.setText("")
        self.view.clear_search()
        self.view.setFocus()

    def _search_or_next(self):
        text = self.search_bar.edit.text()
        if not text or self.view.doc is None:
            return
        if text == self._last_query and self.view.hit_count() > 0:
            self._jump_hit(1)
            return
        self._last_query = text
        self._search_generation += 1
        generation = self._search_generation
        self.search_bar.count_label.setText("…")
        task = SearchTask(
            self.view.doc, text,
            cancelled=lambda: generation != self._search_generation,
            signals=self._search_signals)
        QThreadPool.globalInstance().start(task)

    def _on_search_finished(self, text: str, results: dict):
        if text != self._last_query:
            return  # risultato di una ricerca ormai superata
        self.view.set_search_results(results)
        if self.view.hit_count() == 0:
            self.search_bar.count_label.setText("0 risultati")
        else:
            self._jump_hit(1)

    def _jump_hit(self, direction: int):
        index = self.view.goto_hit(direction)
        if index >= 0:
            self.search_bar.count_label.setText(
                f"{index + 1} / {self.view.hit_count()}")

    # ------------------------------------------------------------------ misc

    def closeEvent(self, event):
        if self.view.doc is not None:
            self.view.doc.close()
        super().closeEvent(event)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv if argv is None else argv)
    app = QApplication(argv)
    app.setApplicationName(APP_NAME)
    path = argv[1] if len(argv) > 1 else None
    window = MainWindow(path)
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
