"""Pannello laterale: indice/segnalibri e miniature delle pagine.

Entrambi i pannelli sono passivi: emettono `pageRequested` quando l'utente
sceglie una voce/miniatura, e la MainWindow li tiene sincronizzati con la
vista principale. Le miniature usano la stessa infrastruttura di rendering
lazy della vista principale (RenderTask + LRUImageCache), ma con una cache e
un thread pool propri per non contendere risorse col rendering a piena
risoluzione.
"""

from __future__ import annotations

from PySide6.QtCore import QSize, Qt, QThreadPool, QTimer, Signal
from PySide6.QtGui import QIcon, QPainter, QPixmap
from PySide6.QtWidgets import (
    QAbstractItemView, QListView, QListWidget, QListWidgetItem, QMenu,
    QTreeWidget, QTreeWidgetItem,
)

from .render import LRUImageCache, RenderSignals, RenderTask, make_key

THUMB_W = 118


class OutlinePanel(QTreeWidget):
    """Indice/segnalibri del PDF, letto da Document.outline()."""

    pageRequested = Signal(int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setHeaderHidden(True)
        self.itemClicked.connect(self._on_item_clicked)

    def populate(self, outline: list[tuple[int, str, int]]) -> None:
        self.clear()
        if not outline:
            placeholder = QTreeWidgetItem(["Nessun indice in questo documento"])
            placeholder.setFlags(Qt.ItemFlag.NoItemFlags)
            self.addTopLevelItem(placeholder)
            return
        # Ricostruisce l'albero da una lista piatta (livello, titolo, pagina)
        stack: list[tuple[int, QTreeWidgetItem]] = [(0, self.invisibleRootItem())]
        for level, title, page in outline:
            item = QTreeWidgetItem([title])
            item.setData(0, Qt.ItemDataRole.UserRole, page)
            while len(stack) > 1 and stack[-1][0] >= level:
                stack.pop()
            stack[-1][1].addChild(item)
            stack.append((level, item))
        self.expandToDepth(0)

    def _on_item_clicked(self, item: QTreeWidgetItem, _column: int) -> None:
        page = item.data(0, Qt.ItemDataRole.UserRole)
        if isinstance(page, int) and page >= 0:
            self.pageRequested.emit(page)


class ThumbnailPanel(QListWidget):
    """Elenco verticale di miniature, renderizzate in modo lazy.

    Le pagine si possono riordinare trascinando le miniature e eliminare dal
    menu contestuale: non lo fa Qt in autonomia (il drop viene intercettato
    e tradotto in un segnale) perché il riordino va applicato al PDF vero
    tramite `Document.move_page`, non solo alla lista visuale.
    """

    pageRequested = Signal(int)
    pageMoveRequested = Signal(int, int)    # da, a (indici 0-based)
    pageDeleteRequested = Signal(int)       # indice 0-based

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setViewMode(QListView.ViewMode.IconMode)
        self.setFlow(QListView.Flow.TopToBottom)
        self.setWrapping(False)
        self.setMovement(QListView.Movement.Static)
        self.setSelectionMode(QListWidget.SelectionMode.SingleSelection)
        self.setSpacing(8)
        self.setStyleSheet(
            "QListWidget { background: #46474e; border: none; }"
            "QListWidget::item { color: #ddd; padding: 4px; }"
            "QListWidget::item:selected { background: #3a6ea5; border-radius: 4px; }"
        )
        self.setDragDropMode(QAbstractItemView.DragDropMode.InternalMove)
        self.setDefaultDropAction(Qt.DropAction.MoveAction)
        self.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.customContextMenuRequested.connect(self._show_context_menu)

        self.doc = None
        self._scale = 1.0
        self._thumb_h = THUMB_W

        self._pool = QThreadPool(self)
        self._pool.setMaxThreadCount(1)
        self._cache = LRUImageCache(max_bytes=24 * 1024 * 1024)
        self._pending: set = set()
        self._signals = RenderSignals()
        self._signals.done.connect(self._on_render_done)

        self.itemClicked.connect(lambda item: self.pageRequested.emit(self.row(item)))
        self.verticalScrollBar().valueChanged.connect(self._schedule_visible)

    def dropEvent(self, event) -> None:
        # Non lasciamo che Qt sposti l'item da solo: il riordino vero
        # avviene sul documento (Document.move_page) e la lista viene
        # ripopolata da lì, così resta sempre sincronizzata col PDF.
        if self.doc is None:
            event.ignore()
            return
        source_row = self.currentRow()
        target_item = self.itemAt(event.position().toPoint())
        target_row = self.row(target_item) if target_item is not None else self.count() - 1
        event.ignore()
        if 0 <= source_row < self.count() and target_row != source_row:
            self.pageMoveRequested.emit(source_row, target_row)

    def _show_context_menu(self, pos) -> None:
        item = self.itemAt(pos)
        if item is None or self.doc is None:
            return
        menu = QMenu(self)
        delete_action = menu.addAction("Elimina pagina")
        chosen = menu.exec(self.viewport().mapToGlobal(pos))
        if chosen == delete_action:
            self.pageDeleteRequested.emit(self.row(item))

    # ------------------------------------------------------------ documento

    def clear_document(self) -> None:
        self.clear()
        self.doc = None
        self._cache.clear()
        self._pending.clear()

    def populate(self, doc) -> None:
        self.clear_document()
        self.doc = doc
        if doc is None or doc.page_count == 0:
            return
        max_w = max(w for w, _ in doc.page_sizes)
        max_h = max(h for _, h in doc.page_sizes)
        self._scale = THUMB_W / max_w
        self._thumb_h = max(1, round(max_h * self._scale))
        self.setIconSize(QSize(THUMB_W, self._thumb_h))
        blank = self._blank_pixmap()
        for i in range(doc.page_count):
            item = QListWidgetItem(QIcon(blank), str(i + 1))
            item.setTextAlignment(Qt.AlignmentFlag.AlignHCenter)
            self.addItem(item)
        QTimer.singleShot(0, self._schedule_visible)

    def set_current_page(self, index: int) -> None:
        if 0 <= index < self.count() and self.currentRow() != index:
            self.setCurrentRow(index)
            self.scrollToItem(self.item(index), QAbstractItemView.ScrollHint.EnsureVisible)

    # ------------------------------------------------------------- rendering

    def _blank_pixmap(self) -> QPixmap:
        pix = QPixmap(THUMB_W, self._thumb_h)
        pix.fill(Qt.GlobalColor.white)
        return pix

    def _schedule_visible(self) -> None:
        if self.doc is None or self.count() == 0:
            return
        top = self.indexAt(self.viewport().rect().topLeft())
        bottom = self.indexAt(self.viewport().rect().bottomLeft())
        first = top.row() if top.isValid() else 0
        last = bottom.row() if bottom.isValid() else self.count() - 1
        if last < 0:
            last = self.count() - 1
        first = max(0, first - 4)
        last = min(self.count() - 1, last + 4)
        for i in range(first, last + 1):
            key = make_key(i, self._scale)
            if self._cache.get(key) is None and key not in self._pending:
                self._pending.add(key)
                task = RenderTask(self.doc, i, self._scale, key,
                                   lambda k: True, self._signals)
                self._pool.start(task)

    def _on_render_done(self, page: int, key, image) -> None:
        self._pending.discard(key)
        self._cache.put(key, image)
        if self.doc is None or page >= self.count():
            return
        pix = self._blank_pixmap()
        painter = QPainter(pix)
        painter.drawImage((THUMB_W - image.width()) // 2,
                          (self._thumb_h - image.height()) // 2, image)
        painter.end()
        self.item(page).setIcon(QIcon(pix))

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        self._schedule_visible()
