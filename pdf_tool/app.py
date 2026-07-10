"""PDF Tool — visualizzatore PDF leggero e veloce (Fase 1).

UI minimale: solo la vista, una barra di ricerca sottile (Ctrl+F) e la
statusbar. Tutto il resto passa dalle scorciatoie da tastiera.
L'editing (annotazioni, firma, form) arriverà in Fase 2 come layer
opzionale sopra `viewer.document`, senza appesantire il viewer.
"""

from __future__ import annotations

import json
import os
import sys

from PySide6.QtCore import QRect, QSettings, Qt, QThreadPool
from PySide6.QtGui import (
    QAction, QActionGroup, QIcon, QImage, QKeySequence, QPainter, QShortcut,
)
from PySide6.QtPrintSupport import QPrintDialog, QPrinter
from PySide6.QtWidgets import (
    QApplication, QDialog, QDockWidget, QFileDialog, QHBoxLayout, QInputDialog,
    QLabel, QLineEdit, QMainWindow, QMessageBox, QProgressDialog, QTabWidget,
    QToolButton, QVBoxLayout, QWidget,
)

from .viewer.document import DocumentError
from .viewer.render import SearchSignals, SearchTask
from .viewer.sidebar import OutlinePanel, ThumbnailPanel
from .viewer.view import (
    MODE_BOOK, MODE_CONTINUOUS, MODE_NAMES, MODE_SINGLE, PdfView,
    TOOL_ADD_IMAGE, TOOL_ADD_TEXT, TOOL_FORM,
)

APP_NAME = "PDF Tool"
MAX_RECENT_FILES = 10
MAX_REMEMBERED_DOCS = 50
CHECKBOX_OFF_VALUES = ("off", "", "0", "false", "none")
# _MEIPASS: radice dei dati bundled da PyInstaller (onedir e onefile);
# in sviluppo è semplicemente la root del progetto.
_ASSETS_ROOT = getattr(
    sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ICON_PATH = os.path.join(_ASSETS_ROOT, "assets", "icon.png")


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
        if os.path.isfile(ICON_PATH):
            self.setWindowIcon(QIcon(ICON_PATH))

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

        # Pannello laterale: indice/segnalibri e organizzatore pagine
        # (nascosto di default)
        self.outline_panel = OutlinePanel(self)
        self.thumb_panel = ThumbnailPanel(self)
        self._sidebar_tabs = QTabWidget(self)
        self._sidebar_tabs.addTab(self.outline_panel, "Indice")
        self._sidebar_tabs.addTab(self.thumb_panel, "Pagine")
        self._pages_tab_index = 1
        self.sidebar_dock = QDockWidget("Pannello", self)
        self.sidebar_dock.setWidget(self._sidebar_tabs)
        self.sidebar_dock.setFeatures(
            QDockWidget.DockWidgetFeature.DockWidgetClosable
            | QDockWidget.DockWidgetFeature.DockWidgetMovable)
        self.addDockWidget(Qt.DockWidgetArea.LeftDockWidgetArea, self.sidebar_dock)
        self.sidebar_dock.hide()
        self.outline_panel.pageRequested.connect(self.view.goto_page)
        self.thumb_panel.pageRequested.connect(self.view.goto_page)
        self.thumb_panel.pageMoveRequested.connect(self._move_page)
        self.thumb_panel.pagesDeleteRequested.connect(self._pages_delete)
        self.thumb_panel.pagesCopyRequested.connect(self._pages_copy)
        self.thumb_panel.pagesCutRequested.connect(self._pages_cut)
        self.thumb_panel.pagesPasteRequested.connect(self._pages_paste)
        self.thumb_panel.pdfInsertRequested.connect(self._insert_pdf_at)
        self.view.pageChanged.connect(
            lambda cur, tot: self.thumb_panel.set_current_page(cur - 1))
        self.view.editRequested.connect(self._on_edit_requested)
        self.view.documentChanged.connect(self._update_title)
        self.view.toolChanged.connect(self._on_tool_changed)
        self._page_clipboard: bytes | None = None  # copia/taglia pagine (tra sidebar e app)

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

        # Impostazioni persistenti: file .ini per-utente, niente registro di
        # Windows (coerente con lo spirito "portatile" del tool).
        self._settings = QSettings(
            QSettings.Format.IniFormat, QSettings.Scope.UserScope,
            "PDFTool", "PDFTool")
        self._recent_files = self._load_recent_files()
        self._doc_states = self._load_doc_states()

        self._setup_menu()
        self._rebuild_recent_menu()
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
        self._recent_menu = m_file.addMenu("Apri &recente")
        m_file.addSeparator()
        act(m_file, "&Stampa…", self.print_dialog, QKeySequence.StandardKey.Print)
        if sys.platform == "win32":
            m_file.addSeparator()
            act(m_file, "Imposta come app &predefinita per i PDF…",
                self.register_default_windows)
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
        m_view.addSeparator()
        act(m_view, "Ruota a &destra", self.view.rotate_right, "Ctrl+]")
        act(m_view, "Ruota a &sinistra", self.view.rotate_left, "Ctrl+[")
        m_view.addSeparator()
        sidebar_action = QAction("&Pannello laterale (indice/miniature)", self)
        sidebar_action.setCheckable(True)
        sidebar_action.setShortcut(QKeySequence("F9"))
        sidebar_action.setShortcutContext(Qt.ShortcutContext.WindowShortcut)
        sidebar_action.toggled.connect(self.sidebar_dock.setVisible)
        self.sidebar_dock.visibilityChanged.connect(sidebar_action.setChecked)
        m_view.addAction(sidebar_action)

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

        m_edit = bar.addMenu("&Modifica")
        self._undo_action = act(m_edit, "&Annulla", self.undo, QKeySequence.StandardKey.Undo)
        self._redo_action = act(m_edit, "&Ripristina", self.redo, QKeySequence.StandardKey.Redo)
        self._undo_action.setEnabled(False)
        self._redo_action.setEnabled(False)
        m_edit.addSeparator()
        self._tool_actions = {}
        for tool, label, short_label, seq in (
                (TOOL_FORM, "&Compila modulo (clic su un campo)", "Compila modulo",
                 "Ctrl+Shift+F"),
                (TOOL_ADD_TEXT, "Aggiungi &testo (clic sulla pagina)", "Aggiungi testo",
                 "Ctrl+Shift+T"),
                (TOOL_ADD_IMAGE, "Aggiungi &immagine (clic sulla pagina)", "Aggiungi immagine",
                 "Ctrl+Shift+I")):
            action = QAction(label, self)
            action.setIconText(short_label)  # etichetta breve per la toolbar
            action.setCheckable(True)
            action.setShortcut(QKeySequence(seq))
            action.setShortcutContext(Qt.ShortcutContext.WindowShortcut)
            action.toggled.connect(lambda checked, t=tool: self._toggle_tool(t, checked))
            m_edit.addAction(action)
            self._tool_actions[tool] = action

        m_doc = bar.addMenu("&Documento")
        self._organize_action = act(
            m_doc, "&Organizza pagine (miniature)…", self.open_page_organizer, "Ctrl+Shift+O")
        m_doc.addSeparator()
        self._merge_action = act(m_doc, "&Unisci PDF…", self.merge_pdf_dialog)
        act(m_doc, "Elimina pagina &corrente", self._delete_current_page)
        act(m_doc, "Incolla pagine in fondo", self._paste_at_end)
        m_doc.addSeparator()
        self._save_action = act(
            m_doc, "&Salva", self.save_document, QKeySequence.StandardKey.Save)
        act(m_doc, "Salva con &nome…", self.save_document_as,
            QKeySequence.StandardKey.SaveAs)

        self._setup_toolbar()

    def open_page_organizer(self) -> None:
        """Apre il pannello laterale sulla scheda "Pagine": qui si
        riordina/copia/taglia/incolla/elimina, e si inseriscono PDF tra due
        pagine (clic destro su una miniatura)."""
        self.sidebar_dock.show()
        self._sidebar_tabs.setCurrentIndex(self._pages_tab_index)
        self.thumb_panel.setFocus()

    def _setup_toolbar(self):
        # Riusa le stesse QAction del menu: stato (spuntato/abilitato) e
        # scorciatoie restano sincronizzati automaticamente in entrambi i
        # posti. Solo le azioni di editing, non l'intera superficie del
        # menu: la vista resta leggera, qui serve solo dare visibilità
        # immediata agli strumenti più usati.
        toolbar = self.addToolBar("Modifica")
        toolbar.setMovable(False)
        toolbar.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextOnly)
        toolbar.addAction(self._undo_action)
        toolbar.addAction(self._redo_action)
        toolbar.addSeparator()
        toolbar.addAction(self._tool_actions[TOOL_FORM])
        toolbar.addAction(self._tool_actions[TOOL_ADD_TEXT])
        toolbar.addAction(self._tool_actions[TOOL_ADD_IMAGE])
        toolbar.addSeparator()
        toolbar.addAction(self._organize_action)
        toolbar.addAction(self._merge_action)
        toolbar.addAction(self._save_action)

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
        if not self._confirm_discard_changes():
            return
        if self.view.doc is not None:
            self._remember_doc_state(self.view.doc.path)
        try:
            self.view.load(path)
        except DocumentError as exc:
            QMessageBox.critical(self, APP_NAME, f"Impossibile aprire il file:\n{exc}")
            return
        self.hide_search()
        self._deactivate_tools()
        self._update_title()
        self.statusBar().showMessage(path)
        self.outline_panel.populate(self.view.doc.outline())
        self.thumb_panel.populate(self.view.doc)
        state = self._doc_states.get(os.path.abspath(path))
        if state:
            self.view.restore_state(state)
        self._add_recent_file(path)
        self._save_settings()
        self.view.setFocus()

    def _update_title(self) -> None:
        doc = self.view.doc
        if doc is None:
            self.setWindowTitle(APP_NAME)
        else:
            dirty = "• " if doc.dirty else ""
            self.setWindowTitle(f"{dirty}{os.path.basename(doc.path)} — {APP_NAME}")
        self._undo_action.setEnabled(doc is not None and doc.can_undo())
        self._redo_action.setEnabled(doc is not None and doc.can_redo())

    def undo(self) -> None:
        if self.view.doc is not None and self.view.doc.can_undo():
            self.view.doc.undo()
            self._after_structural_edit()

    def redo(self) -> None:
        if self.view.doc is not None and self.view.doc.can_redo():
            self.view.doc.redo()
            self._after_structural_edit()

    def _confirm_discard_changes(self) -> bool:
        """Se ci sono modifiche non salvate, chiede conferma. False = annulla."""
        self.view.commit_pending_edits()
        doc = self.view.doc
        if doc is None or not doc.dirty:
            return True
        reply = QMessageBox.question(
            self, APP_NAME,
            f"'{os.path.basename(doc.path)}' ha modifiche non salvate. Salvarle?",
            QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Save)
        if reply == QMessageBox.StandardButton.Cancel:
            return False
        if reply == QMessageBox.StandardButton.Save:
            try:
                doc.save()
            except Exception as exc:
                QMessageBox.critical(self, APP_NAME, f"Salvataggio non riuscito:\n{exc}")
                return False
        return True

    # -------------------------------------------------------------- editing

    def _toggle_tool(self, tool: str, checked: bool) -> None:
        if checked:
            for t, action in self._tool_actions.items():
                if t != tool:
                    action.blockSignals(True)
                    action.setChecked(False)
                    action.blockSignals(False)
            self.view.set_tool(tool)
            hints = {
                TOOL_FORM: "Compila modulo: clicca su un campo per modificarlo.",
                TOOL_ADD_TEXT: "Aggiungi testo: clicca sulla pagina dove inserirlo.",
                TOOL_ADD_IMAGE: "Aggiungi immagine: clicca sulla pagina dove inserirla.",
            }
            self.statusBar().showMessage(hints[tool])
        elif self.view.tool == tool:
            self.view.set_tool(None)
            self.statusBar().clearMessage()

    def _on_tool_changed(self, tool) -> None:
        """Tiene i pulsanti allineati anche quando lo strumento si
        autodisattiva dopo un inserimento (non solo quando l'utente lo
        spegne a mano dal pulsante)."""
        if not hasattr(self, "_tool_actions"):
            return
        for t, action in self._tool_actions.items():
            should_check = (t == tool)
            if action.isChecked() != should_check:
                action.blockSignals(True)
                action.setChecked(should_check)
                action.blockSignals(False)
        if tool is None:
            self.statusBar().clearMessage()

    def _deactivate_tools(self) -> None:
        for action in self._tool_actions.values():
            action.setChecked(False)
        self.view.set_tool(None)

    def _on_edit_requested(self, tool: str, page: int, point: tuple) -> None:
        # TOOL_ADD_TEXT non passa di qui: PdfView apre l'editor inline
        # direttamente (si scrive sulla pagina, niente popup).
        if tool == TOOL_FORM:
            self._fill_form_field_at(page, point)
        elif tool == TOOL_ADD_IMAGE:
            self._add_image_at(page, point)

    def _fill_form_field_at(self, page: int, point: tuple) -> None:
        x, y = point
        doc = self.view.doc
        widget = next(
            (w for w in doc.widgets(page)
             if w["rect"][0] <= x <= w["rect"][2] and w["rect"][1] <= y <= w["rect"][3]),
            None)
        if widget is None:
            return
        if widget["type"] in ("CheckBox", "RadioButton"):
            is_on = str(widget["value"]).strip().lower() not in CHECKBOX_OFF_VALUES
            doc.set_widget_value(page, widget["name"], not is_on)
        else:
            text, ok = QInputDialog.getMultiLineText(
                self, "Compila campo", widget["name"] or "Valore", str(widget["value"] or ""))
            if not ok:
                return
            doc.set_widget_value(page, widget["name"], text)
        self.view.refresh_after_edit()
        self._update_title()

    def _add_image_at(self, page: int, point: tuple) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "Aggiungi immagine", "",
            "Immagini (*.png *.jpg *.jpeg *.bmp *.gif)")
        if not path:
            return
        if QImage(path).isNull():
            QMessageBox.warning(self, APP_NAME, "Impossibile leggere l'immagine scelta.")
            return
        # Non impressa subito: resta trascinabile finché non si conferma
        # (clic altrove, cambio strumento, salvataggio) — vedi
        # PdfView.start_image_placement/_commit_pending_image.
        self.view.start_image_placement(page, point, path)

    # -------------------------------------------------------- gestione pagine

    def _move_page(self, from_index: int, to_index: int) -> None:
        if self.view.doc is None:
            return
        self.view.doc.move_page(from_index, to_index)
        self._after_structural_edit()

    def _pages_delete(self, indices: list[int]) -> None:
        doc = self.view.doc
        if doc is None or not indices:
            return
        if doc.page_count - len(set(indices)) < 1:
            QMessageBox.warning(self, APP_NAME, "Non puoi eliminare tutte le pagine del documento.")
            return
        label = "la pagina" if len(indices) == 1 else f"le {len(indices)} pagine selezionate"
        reply = QMessageBox.question(
            self, APP_NAME, f"Eliminare {label}?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
        if reply != QMessageBox.StandardButton.Yes:
            return
        try:
            doc.delete_pages(indices)
        except DocumentError as exc:
            QMessageBox.warning(self, APP_NAME, str(exc))
            return
        self._after_structural_edit()

    def _delete_current_page(self) -> None:
        if self.view.doc is not None:
            self._pages_delete([self.view.current_page()])

    def _pages_copy(self, indices: list[int]) -> None:
        doc = self.view.doc
        if doc is None or not indices:
            return
        self._page_clipboard = doc.extract_pages_bytes(indices)
        self.thumb_panel.set_clipboard_available(True)
        label = "Pagina copiata" if len(indices) == 1 else f"{len(indices)} pagine copiate"
        self.statusBar().showMessage(f"{label}.", 3000)

    def _pages_cut(self, indices: list[int]) -> None:
        doc = self.view.doc
        if doc is None or not indices:
            return
        if doc.page_count - len(set(indices)) < 1:
            QMessageBox.warning(self, APP_NAME, "Non puoi tagliare tutte le pagine del documento.")
            return
        self._page_clipboard = doc.extract_pages_bytes(indices)
        self.thumb_panel.set_clipboard_available(True)
        try:
            doc.delete_pages(indices)
        except DocumentError as exc:
            QMessageBox.warning(self, APP_NAME, str(exc))
            return
        self._after_structural_edit()
        label = "Pagina tagliata" if len(indices) == 1 else f"{len(indices)} pagine tagliate"
        self.statusBar().showMessage(f"{label}.", 3000)

    def _pages_paste(self, at_index: int) -> None:
        doc = self.view.doc
        if doc is None or self._page_clipboard is None:
            return
        doc.insert_pdf_bytes(self._page_clipboard, at_index=at_index)
        self._after_structural_edit()
        self.statusBar().showMessage("Pagine incollate.", 3000)

    def _paste_at_end(self) -> None:
        if self.view.doc is not None:
            self._pages_paste(self.view.doc.page_count)

    def _insert_pdf_at(self, at_index: int) -> None:
        if self.view.doc is None:
            return
        path, _ = QFileDialog.getOpenFileName(
            self, "Inserisci PDF qui", "", "Documenti PDF (*.pdf)")
        if not path:
            return
        try:
            self.view.doc.insert_pdf(path, at_index=at_index)
        except Exception as exc:
            QMessageBox.critical(self, APP_NAME, f"Impossibile inserire il PDF:\n{exc}")
            return
        self._after_structural_edit()
        self.statusBar().showMessage("PDF inserito.", 3000)

    def _after_structural_edit(self) -> None:
        self.view.reload_structure()
        self.outline_panel.populate(self.view.doc.outline())
        self.thumb_panel.populate(self.view.doc)
        self._update_title()

    # ---------------------------------------------------------------- salva

    def merge_pdf_dialog(self) -> None:
        if self.view.doc is None:
            return
        path, _ = QFileDialog.getOpenFileName(
            self, "Unisci PDF (aggiunge in fondo)", "", "Documenti PDF (*.pdf)")
        if not path:
            return
        try:
            self.view.doc.insert_pdf(path)
        except Exception as exc:
            QMessageBox.critical(self, APP_NAME, f"Impossibile unire il PDF:\n{exc}")
            return
        self._after_structural_edit()
        self.statusBar().showMessage("PDF unito in fondo al documento.", 4000)

    def save_document(self) -> None:
        self.view.commit_pending_edits()
        doc = self.view.doc
        if doc is None:
            return
        try:
            doc.save()
        except Exception as exc:
            QMessageBox.critical(self, APP_NAME, f"Salvataggio non riuscito:\n{exc}")
            return
        self._update_title()
        self.statusBar().showMessage("Documento salvato.", 3000)

    def save_document_as(self) -> None:
        self.view.commit_pending_edits()
        doc = self.view.doc
        if doc is None:
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "Salva con nome", doc.path, "Documenti PDF (*.pdf)")
        if not path:
            return
        try:
            doc.save(path)
        except Exception as exc:
            QMessageBox.critical(self, APP_NAME, f"Salvataggio non riuscito:\n{exc}")
            return
        self._update_title()
        self._add_recent_file(path)
        self._save_settings()
        self.statusBar().showMessage(f"Salvato come {path}", 4000)

    # ------------------------------------------------------- file recenti

    def _load_recent_files(self) -> list[str]:
        value = self._settings.value("recent/files", [])
        if isinstance(value, str):
            value = [value] if value else []
        return [p for p in value if os.path.isfile(p)][:MAX_RECENT_FILES]

    def _add_recent_file(self, path: str) -> None:
        path = os.path.abspath(path)
        self._recent_files = [p for p in self._recent_files if p != path]
        self._recent_files.insert(0, path)
        del self._recent_files[MAX_RECENT_FILES:]
        self._rebuild_recent_menu()

    def _rebuild_recent_menu(self) -> None:
        self._recent_menu.clear()
        if not self._recent_files:
            empty = QAction("(nessuno)", self)
            empty.setEnabled(False)
            self._recent_menu.addAction(empty)
            return
        for recent_path in self._recent_files:
            action = QAction(os.path.basename(recent_path), self)
            action.setStatusTip(recent_path)
            action.triggered.connect(
                lambda checked=False, p=recent_path: self.open_path(p))
            self._recent_menu.addAction(action)
        self._recent_menu.addSeparator()
        clear_action = QAction("Cancella elenco", self)
        clear_action.triggered.connect(self._clear_recent_files)
        self._recent_menu.addAction(clear_action)

    def _clear_recent_files(self) -> None:
        self._recent_files = []
        self._rebuild_recent_menu()
        self._save_settings()

    # -------------------------------------------------- stato per documento

    def _load_doc_states(self) -> dict:
        raw = self._settings.value("documents/states", "")
        try:
            return json.loads(raw) if raw else {}
        except (TypeError, ValueError):
            return {}

    def _remember_doc_state(self, path: str) -> None:
        key = os.path.abspath(path)
        self._doc_states.pop(key, None)
        self._doc_states[key] = self.view.state()
        while len(self._doc_states) > MAX_REMEMBERED_DOCS:
            del self._doc_states[next(iter(self._doc_states))]

    def _save_settings(self) -> None:
        self._settings.setValue("recent/files", self._recent_files)
        self._settings.setValue("documents/states", json.dumps(self._doc_states))
        self._settings.sync()

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

    # --------------------------------------------------------------- stampa

    def print_dialog(self):
        if self.view.doc is None:
            return
        printer = QPrinter(QPrinter.PrinterMode.HighResolution)
        printer.setFromTo(1, self.view.doc.page_count)
        dialog = QPrintDialog(printer, self)
        dialog.setMinMax(1, self.view.doc.page_count)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        self._print(printer)

    def _print(self, printer: QPrinter):
        doc = self.view.doc
        if printer.printRange() == QPrinter.PrintRange.PageRange:
            first, last = printer.fromPage() - 1, printer.toPage() - 1
        else:
            first, last = 0, doc.page_count - 1
        rotation = self.view.rotation
        scale = printer.resolution() / 72.0

        progress = QProgressDialog("Stampa in corso…", "Annulla", first, last + 1, self)
        progress.setWindowModality(Qt.WindowModality.WindowModal)
        progress.setMinimumDuration(300)

        painter = QPainter(printer)
        target = painter.viewport()
        first_page = True
        for i in range(first, last + 1):
            progress.setValue(i)
            if progress.wasCanceled():
                break
            if not first_page:
                printer.newPage()
            first_page = False
            image = doc.render(i, scale, rotation)
            ratio = image.width() / image.height()
            target_ratio = target.width() / target.height()
            if ratio > target_ratio:
                w, h = target.width(), round(target.width() / ratio)
            else:
                h, w = target.height(), round(target.height() * ratio)
            x = target.x() + (target.width() - w) // 2
            y = target.y() + (target.height() - h) // 2
            painter.drawImage(QRect(x, y, w, h), image)
        painter.end()
        progress.setValue(last + 1)

    # -------------------------------------------- app predefinita (Windows)

    def register_default_windows(self):
        import subprocess
        import winreg

        exe = sys.executable if getattr(sys, "frozen", False) else None
        if exe is None:
            QMessageBox.information(
                self, APP_NAME,
                "Questa funzione è disponibile solo nella build Windows "
                "distribuita (PDFTool.exe), non in esecuzione da sorgente.")
            return
        prog_id = "PDFTool.Document"
        classes = winreg.HKEY_CURRENT_USER
        try:
            with winreg.CreateKey(classes, rf"Software\Classes\{prog_id}\shell\open\command") as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, f'"{exe}" "%1"')
            with winreg.CreateKey(classes, rf"Software\Classes\{prog_id}\DefaultIcon") as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, f'"{exe}",0')
            with winreg.CreateKey(classes, rf"Software\Classes\{prog_id}") as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "Documento PDF")
            with winreg.CreateKey(classes, r"Software\PDFTool\Capabilities") as k:
                winreg.SetValueEx(k, "ApplicationName", 0, winreg.REG_SZ, APP_NAME)
                winreg.SetValueEx(k, "ApplicationDescription", 0, winreg.REG_SZ,
                                   "Visualizzatore PDF leggero e veloce")
            with winreg.CreateKey(classes, r"Software\PDFTool\Capabilities\FileAssociations") as k:
                winreg.SetValueEx(k, ".pdf", 0, winreg.REG_SZ, prog_id)
            with winreg.CreateKey(classes, r"Software\RegisteredApplications") as k:
                winreg.SetValueEx(k, "PDFTool", 0, winreg.REG_SZ,
                                   r"Software\PDFTool\Capabilities")
        except OSError as exc:
            QMessageBox.critical(self, APP_NAME, f"Impossibile scrivere il registro:\n{exc}")
            return
        # Windows protegge la scelta effettiva dell'app predefinita (dal
        # tasto utente): possiamo solo registrarci come candidati e aprire
        # le impostazioni perché l'utente completi la scelta.
        subprocess.Popen(["cmd", "/c", "start", "", "ms-settings:defaultapps"])
        QMessageBox.information(
            self, APP_NAME,
            "PDF Tool è ora registrato tra le app disponibili per i PDF.\n\n"
            "Nelle Impostazioni di Windows che si sono aperte, scegli "
            "'PDF Tool' come app predefinita per i file .pdf.")

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
        if not self._confirm_discard_changes():
            event.ignore()
            return
        if self.view.doc is not None:
            self._remember_doc_state(self.view.doc.path)
            self.view.doc.close()
        self._save_settings()
        super().closeEvent(event)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv if argv is None else argv)
    app = QApplication(argv)
    app.setApplicationName(APP_NAME)
    if os.path.isfile(ICON_PATH):
        app.setWindowIcon(QIcon(ICON_PATH))
    path = argv[1] if len(argv) > 1 else None
    window = MainWindow(path)
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
