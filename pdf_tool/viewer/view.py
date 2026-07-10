"""Widget di visualizzazione PDF a scroll continuo.

Basato su QAbstractScrollArea: nessun widget per pagina, si dipinge
direttamente sul viewport solo ciò che è visibile. Le pagine vengono
renderizzate in modo lazy da un QThreadPool (visibili + prefetch delle
adiacenti) e tenute in una cache LRU.
"""

from __future__ import annotations

from bisect import bisect_right

from PySide6.QtCore import QRectF, Qt, QThreadPool, Signal
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QAbstractScrollArea

from .document import Document
from .render import LRUImageCache, RenderSignals, RenderTask, make_key

MARGIN = 12          # px attorno al documento
GAP = 12             # px tra una pagina e l'altra
PREFETCH = 2         # pagine pre-renderizzate sopra/sotto quelle visibili
MIN_ZOOM = 0.1
MAX_ZOOM = 8.0
ZOOM_STEP = 1.25

BG_COLOR = QColor(70, 74, 78)
PAGE_BORDER = QColor(40, 40, 40)
HIGHLIGHT = QColor(255, 210, 0, 110)
HIGHLIGHT_CURRENT = QColor(255, 120, 0, 150)

FIT_NONE = 0
FIT_WIDTH = 1
FIT_PAGE = 2


class PdfView(QAbstractScrollArea):
    """Vista a scroll continuo verticale con zoom e ricerca evidenziata."""

    pageChanged = Signal(int, int)      # pagina corrente (1-based), totale
    zoomChanged = Signal(float)         # fattore di zoom corrente

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.viewport().setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, True)

        self.doc: Document | None = None
        self.zoom = 1.0
        self.fit_mode = FIT_WIDTH

        # Layout verticale (coordinate "contenuto" alla scala corrente)
        self._offsets: list[int] = []   # y del bordo alto di ogni pagina
        self._pw: list[int] = []        # larghezze pagina in px
        self._ph: list[int] = []        # altezze pagina in px
        self._content_w = 0
        self._content_h = 0

        # Rendering asincrono
        self._pool = QThreadPool(self)
        self._pool.setMaxThreadCount(2)
        self._cache = LRUImageCache()
        self._pending: set = set()      # chiavi con render già in coda
        self._wanted: set = set()       # chiavi ancora utili (letto dai worker)
        self._fallback: dict[int, tuple[float, object]] = {}  # pagina -> (scala, QImage)
        self._render_signals = RenderSignals()
        self._render_signals.done.connect(self._on_render_done)

        # Risultati di ricerca: {pagina: [Rect,...]} + lista piatta ordinata
        self._hits: dict[int, list] = {}
        self._hit_list: list[tuple[int, object]] = []
        self._current_hit = -1

        self.verticalScrollBar().valueChanged.connect(self._emit_page_changed)
        self._last_emitted_page = -1

    # ------------------------------------------------------------ documento

    def load(self, path: str) -> None:
        """Apre un documento (solleva DocumentError in caso di problemi)."""
        new_doc = Document(path)
        if self.doc is not None:
            self.doc.close()
        self.doc = new_doc
        self._cache.clear()
        self._fallback.clear()
        self._wanted = set()
        self._pending.clear()
        self.clear_search()
        self._last_emitted_page = -1
        if self.fit_mode != FIT_NONE:
            self._apply_fit()
        self._relayout()
        self.verticalScrollBar().setValue(0)
        self.horizontalScrollBar().setValue(0)
        self.viewport().update()
        self._emit_page_changed()
        self.zoomChanged.emit(self.zoom)

    # --------------------------------------------------------------- layout

    def _relayout(self) -> None:
        """Ricalcola offset e range delle scrollbar alla scala corrente."""
        self._offsets, self._pw, self._ph = [], [], []
        if self.doc is None:
            self._content_w = self._content_h = 0
        else:
            y = MARGIN
            max_w = 0
            for (w_pt, h_pt) in self.doc.page_sizes:
                w = max(1, round(w_pt * self.zoom))
                h = max(1, round(h_pt * self.zoom))
                self._offsets.append(y)
                self._pw.append(w)
                self._ph.append(h)
                y += h + GAP
                max_w = max(max_w, w)
            self._content_h = y - GAP + MARGIN
            self._content_w = max_w + 2 * MARGIN

        vp = self.viewport()
        vbar, hbar = self.verticalScrollBar(), self.horizontalScrollBar()
        vbar.setRange(0, max(0, self._content_h - vp.height()))
        vbar.setPageStep(max(40, vp.height() - 24))
        vbar.setSingleStep(48)
        hbar.setRange(0, max(0, self._content_w - vp.width()))
        hbar.setPageStep(vp.width())
        hbar.setSingleStep(48)

    def _page_x(self, index: int) -> int:
        """Ascissa del bordo sinistro della pagina (coordinate contenuto)."""
        area_w = max(self._content_w, self.viewport().width())
        return (area_w - self._pw[index]) // 2

    def _visible_range(self) -> tuple[int, int]:
        """(prima, ultima) pagina almeno parzialmente visibile."""
        if not self._offsets:
            return (0, -1)
        top = self.verticalScrollBar().value()
        bottom = top + self.viewport().height()
        first = max(0, bisect_right(self._offsets, top) - 1)
        if self._offsets[first] + self._ph[first] <= top and first + 1 < len(self._offsets):
            first += 1
        last = first
        while last + 1 < len(self._offsets) and self._offsets[last + 1] < bottom:
            last += 1
        return (first, last)

    def current_page(self) -> int:
        """Indice (0-based) della pagina 'corrente' per la statusbar."""
        if not self._offsets:
            return 0
        probe = self.verticalScrollBar().value() + self.viewport().height() // 4
        i = max(0, bisect_right(self._offsets, probe) - 1)
        return min(i, len(self._offsets) - 1)

    # ----------------------------------------------------------------- zoom

    def set_zoom(self, zoom: float, anchor_vy: int | None = None,
                 fit_mode: int = FIT_NONE) -> None:
        zoom = max(MIN_ZOOM, min(MAX_ZOOM, zoom))
        self.fit_mode = fit_mode
        if self.doc is None:
            self.zoom = zoom
            self.zoomChanged.emit(self.zoom)
            return
        if anchor_vy is None:
            anchor_vy = self.viewport().height() // 2
        anchor = self._anchor_before(anchor_vy)
        self.zoom = zoom
        self._relayout()
        self._anchor_restore(anchor, anchor_vy)
        self.viewport().update()
        self.zoomChanged.emit(self.zoom)

    def zoom_in(self, anchor_vy: int | None = None) -> None:
        self.set_zoom(self.zoom * ZOOM_STEP, anchor_vy)

    def zoom_out(self, anchor_vy: int | None = None) -> None:
        self.set_zoom(self.zoom / ZOOM_STEP, anchor_vy)

    def fit_width(self) -> None:
        self._apply_fit(FIT_WIDTH)

    def fit_page(self) -> None:
        self._apply_fit(FIT_PAGE)

    def _apply_fit(self, mode: int | None = None) -> None:
        if mode is None:
            mode = self.fit_mode
        if self.doc is None:
            self.fit_mode = mode
            return
        max_w = max(w for w, _ in self.doc.page_sizes)
        max_h = max(h for _, h in self.doc.page_sizes)
        vp = self.viewport()
        avail_w = max(50, vp.width() - 2 * MARGIN)
        avail_h = max(50, vp.height() - 2 * MARGIN)
        if mode == FIT_PAGE:
            zoom = min(avail_w / max_w, avail_h / max_h)
        else:
            zoom = avail_w / max_w
        self.set_zoom(zoom, fit_mode=mode)

    def _anchor_before(self, vy: int):
        """Punto del documento sotto la y `vy` del viewport, in punti PDF.

        Restituisce None se si è in cima al documento: in quel caso, dopo
        lo zoom/fit si resta semplicemente in cima (evita derive quando il
        layout precedente era calcolato su un viewport non ancora definitivo).
        """
        if not self._offsets or self.verticalScrollBar().value() == 0:
            return None
        y = self.verticalScrollBar().value() + vy
        i = max(0, bisect_right(self._offsets, y) - 1)
        offset_pt = (y - self._offsets[i]) / self.zoom
        # Clamp dentro la pagina: un anchor fuori scala non deve mai
        # proiettare lo scroll lontano dal punto reale.
        offset_pt = max(0.0, min(offset_pt, self.doc.page_sizes[i][1]))
        return (i, offset_pt)

    def _anchor_restore(self, anchor, vy: int) -> None:
        if not self._offsets:
            return
        if anchor is None:
            self.verticalScrollBar().setValue(0)
            return
        i, offset_pt = anchor
        i = min(i, len(self._offsets) - 1)
        y = self._offsets[i] + offset_pt * self.zoom - vy
        self.verticalScrollBar().setValue(round(y))

    # ----------------------------------------------------------- navigazione

    def goto_page(self, index: int) -> None:
        if not self._offsets:
            return
        index = max(0, min(index, len(self._offsets) - 1))
        self.verticalScrollBar().setValue(self._offsets[index] - MARGIN)

    # -------------------------------------------------------------- ricerca

    def set_search_results(self, hits: dict[int, list]) -> None:
        self._hits = hits
        self._hit_list = [(page, rect) for page in sorted(hits) for rect in hits[page]]
        self._current_hit = -1
        self.viewport().update()

    def clear_search(self) -> None:
        self._hits = {}
        self._hit_list = []
        self._current_hit = -1
        self.viewport().update()

    def hit_count(self) -> int:
        return len(self._hit_list)

    def current_hit_index(self) -> int:
        return self._current_hit

    def goto_hit(self, direction: int = 1) -> int:
        """Passa al risultato successivo (+1) o precedente (-1).

        Restituisce l'indice del risultato corrente (0-based, -1 se nessuno).
        """
        if not self._hit_list:
            return -1
        if self._current_hit < 0:
            # primo salto: parti dal primo risultato dalla pagina corrente in poi
            cur = self.current_page()
            self._current_hit = next(
                (n for n, (page, _) in enumerate(self._hit_list) if page >= cur), 0)
        else:
            self._current_hit = (self._current_hit + direction) % len(self._hit_list)
        page, rect = self._hit_list[self._current_hit]
        target = self._offsets[page] + rect.y0 * self.zoom - self.viewport().height() // 3
        self.verticalScrollBar().setValue(round(target))
        self.viewport().update()
        return self._current_hit

    # ------------------------------------------------------------- painting

    def paintEvent(self, event) -> None:
        painter = QPainter(self.viewport())
        painter.fillRect(event.rect(), BG_COLOR)
        if self.doc is None:
            painter.setPen(QColor(200, 200, 200))
            painter.drawText(self.viewport().rect(), Qt.AlignmentFlag.AlignCenter,
                             "Nessun documento aperto\nCtrl+O per aprire un PDF")
            painter.end()
            return

        xoff = self.horizontalScrollBar().value()
        yoff = self.verticalScrollBar().value()
        first, last = self._visible_range()
        self._schedule_renders(first, last)

        for i in range(first, last + 1):
            x = self._page_x(i) - xoff
            y = self._offsets[i] - yoff
            w, h = self._pw[i], self._ph[i]

            key = make_key(i, self.zoom)
            image = self._cache.get(key)
            if image is not None:
                painter.drawImage(x, y, image)
            else:
                # Placeholder: bianco, oppure il render precedente riscalato
                painter.fillRect(x, y, w, h, Qt.GlobalColor.white)
                fallback = self._fallback.get(i)
                if fallback is not None:
                    painter.drawImage(QRectF(x, y, w, h), fallback[1])

            painter.setPen(QPen(PAGE_BORDER))
            painter.drawRect(x, y, w - 1, h - 1)

            # Evidenziazione risultati di ricerca
            rects = self._hits.get(i)
            if rects:
                current = (self._hit_list[self._current_hit]
                           if 0 <= self._current_hit < len(self._hit_list) else None)
                for rect in rects:
                    color = (HIGHLIGHT_CURRENT
                             if current is not None and current[0] == i and current[1] is rect
                             else HIGHLIGHT)
                    painter.fillRect(
                        QRectF(x + rect.x0 * self.zoom, y + rect.y0 * self.zoom,
                               (rect.x1 - rect.x0) * self.zoom,
                               (rect.y1 - rect.y0) * self.zoom),
                        color)
        painter.end()

    # ---------------------------------------------------- rendering asincrono

    def _schedule_renders(self, first: int, last: int) -> None:
        """Accoda i render mancanti per le pagine visibili + prefetch."""
        lo = max(0, first - PREFETCH)
        hi = min(len(self._offsets) - 1, last + PREFETCH)
        wanted = set()
        order = []  # prima le visibili, poi il prefetch
        for i in list(range(first, last + 1)) + \
                [j for j in range(lo, hi + 1) if j < first or j > last]:
            key = make_key(i, self.zoom)
            wanted.add(key)
            order.append((i, key))
        self._wanted = wanted  # sostituzione atomica, letta dai worker

        for i, key in order:
            if self._cache.get(key) is None and key not in self._pending:
                self._pending.add(key)
                task = RenderTask(self.doc, i, self.zoom, key,
                                  self._still_needed, self._render_signals)
                self._pool.start(task)

    def _still_needed(self, key) -> bool:
        return key in self._wanted

    def _on_render_done(self, page: int, key, image) -> None:
        self._pending.discard(key)
        self._cache.put(key, image)
        self._fallback[page] = (key[1], image)
        # Tieni i fallback solo per poche pagine (memoria limitata sul Pi)
        if len(self._fallback) > 8:
            first, last = self._visible_range()
            visible = set(range(first, last + 1)) | {page}
            for stale in [p for p in self._fallback if p not in visible][:4]:
                del self._fallback[stale]
        if key[1] == round(self.zoom, 3):
            self.viewport().update()

    # ---------------------------------------------------------------- eventi

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        if self.fit_mode != FIT_NONE and self.doc is not None:
            self._apply_fit()
        else:
            self._relayout()

    def scrollContentsBy(self, dx: int, dy: int) -> None:
        self.viewport().update()

    def wheelEvent(self, event) -> None:
        if event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            steps = event.angleDelta().y() / 120.0
            if steps:
                factor = ZOOM_STEP ** steps
                self.set_zoom(self.zoom * factor,
                              anchor_vy=int(event.position().y()))
            event.accept()
            return
        super().wheelEvent(event)

    def keyPressEvent(self, event) -> None:
        vbar = self.verticalScrollBar()
        key = event.key()
        ctrl = bool(event.modifiers() & Qt.KeyboardModifier.ControlModifier)

        if ctrl and key in (Qt.Key.Key_Plus, Qt.Key.Key_Equal):
            self.zoom_in()
        elif ctrl and key == Qt.Key.Key_Minus:
            self.zoom_out()
        elif ctrl and key == Qt.Key.Key_1:
            self.set_zoom(1.0)
        elif ctrl and key == Qt.Key.Key_2:
            self.fit_width()
        elif ctrl and key == Qt.Key.Key_0:
            self.fit_page()
        elif key == Qt.Key.Key_PageDown:
            vbar.setValue(vbar.value() + vbar.pageStep())
        elif key == Qt.Key.Key_PageUp:
            vbar.setValue(vbar.value() - vbar.pageStep())
        elif key == Qt.Key.Key_Home and not ctrl:
            vbar.setValue(0)
        elif key == Qt.Key.Key_End and not ctrl:
            vbar.setValue(vbar.maximum())
        elif key == Qt.Key.Key_Down:
            vbar.setValue(vbar.value() + vbar.singleStep())
        elif key == Qt.Key.Key_Up:
            vbar.setValue(vbar.value() - vbar.singleStep())
        else:
            super().keyPressEvent(event)
            return
        event.accept()

    # ------------------------------------------------------------------ util

    def _emit_page_changed(self) -> None:
        if self.doc is None:
            return
        page = self.current_page()
        if page != self._last_emitted_page:
            self._last_emitted_page = page
            self.pageChanged.emit(page + 1, self.doc.page_count)
