"""Widget di visualizzazione PDF con più modalità di visualizzazione.

Basato su QAbstractScrollArea: nessun widget per pagina, si dipinge
direttamente sul viewport solo ciò che è visibile. Le pagine vengono
renderizzate in modo lazy da un QThreadPool (visibili + prefetch delle
adiacenti) e tenute in una cache LRU.

Il layout è organizzato in "righe" di pagine, sempre calcolato per l'intero
documento (indipendentemente dalla modalità), così la barra di scorrimento
verticale copre sempre tutto il documento e permette di saltare rapidamente
tra le pagine anche in Pagina singola/Libro, non solo scorrendo con la
rotella:
- Scorrimento (default): una pagina per riga;
- Pagina singola: una pagina per riga (a zoom "adatta pagina" ne è visibile
  una alla volta, ma si può scorrere liberamente col mouse/scrollbar);
- Libro: copertina da sola, poi coppie affiancate.
"""

from __future__ import annotations

from bisect import bisect_right

from PySide6.QtCore import QRectF, Qt, QThreadPool, Signal
from PySide6.QtGui import QColor, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QAbstractScrollArea, QTextEdit

from .document import Document
from .render import LRUImageCache, RenderSignals, RenderTask, make_key

MARGIN = 12          # px attorno al documento
GAP = 12             # px tra una pagina e l'altra
PREFETCH = 2         # righe pre-renderizzate prima/dopo quelle visibili
MIN_ZOOM = 0.1
MAX_ZOOM = 8.0
ZOOM_STEP = 1.25

BG_COLOR = QColor(70, 74, 78)
PAGE_BORDER = QColor(40, 40, 40)
HIGHLIGHT = QColor(255, 210, 0, 110)
HIGHLIGHT_CURRENT = QColor(255, 120, 0, 150)
WIDGET_HINT = QColor(60, 140, 220, 70)
WIDGET_HINT_BORDER = QColor(40, 110, 190)
DRAG_OUTLINE = QColor(230, 150, 20)
DRAG_FILL = QColor(230, 150, 20, 40)

TOOL_FORM = "form"
TOOL_ADD_TEXT = "add_text"
TOOL_ADD_IMAGE = "add_image"

ADD_TEXT_SIZE_PT = (240, 50)  # dimensione di default della casella di testo
ADD_IMAGE_WIDTH_PT = 140.0    # larghezza di default delle immagini inserite


class _InlineTextEdit(QTextEdit):
    """Editor di testo fluttuante per "Aggiungi testo": si scrive direttamente
    sopra la pagina invece che in un popup. Si conferma perdendo il focus o
    con Ctrl+Invio (Invio da solo va a capo, essendo il testo multi-riga);
    si annulla con Esc."""

    committed = Signal()
    cancelled = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAcceptRichText(False)
        self._closing = False

    def keyPressEvent(self, event) -> None:
        if event.key() == Qt.Key.Key_Escape:
            self._emit_once(self.cancelled)
            return
        if (event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter)
                and event.modifiers() & Qt.KeyboardModifier.ControlModifier):
            self._emit_once(self.committed)
            return
        super().keyPressEvent(event)

    def focusOutEvent(self, event) -> None:
        super().focusOutEvent(event)
        self._emit_once(self.committed)

    def _emit_once(self, signal) -> None:
        # Sia Esc sia il focus-out possono arrivare più volte durante la
        # chiusura (deleteLater non è immediato): il segnale va emesso una
        # sola volta, altrimenti si rischia un doppio commit.
        if not self._closing:
            self._closing = True
            signal.emit()

FIT_NONE = 0
FIT_WIDTH = 1
FIT_PAGE = 2

MODE_SINGLE = 0      # una pagina per riga, in genere a zoom "adatta pagina"
MODE_CONTINUOUS = 1  # scorrimento continuo verticale (default)
MODE_BOOK = 2        # copertina sola, poi coppie di pagine affiancate

MODE_NAMES = {
    MODE_SINGLE: "Pagina singola",
    MODE_CONTINUOUS: "Scorrimento",
    MODE_BOOK: "Libro",
}


class PdfView(QAbstractScrollArea):
    """Vista PDF con zoom, ricerca evidenziata e tre modalità di layout."""

    pageChanged = Signal(int, int)      # pagina corrente (1-based), totale
    zoomChanged = Signal(float)         # fattore di zoom corrente
    modeChanged = Signal(str)           # nome della modalità corrente
    editRequested = Signal(str, int, object)  # tool, pagina, (x_pt, y_pt)
    documentChanged = Signal()          # una modifica è stata applicata al documento
    toolChanged = Signal(object)        # str (TOOL_*) o None; anche quando si autodisattiva

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.viewport().setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, True)

        self.doc: Document | None = None
        self.zoom = 1.0
        self.fit_mode = FIT_WIDTH
        self.mode = MODE_CONTINUOUS
        self.rotation = 0   # 0/90/180/270, in senso orario
        self.tool: str | None = None    # None o uno dei TOOL_*
        self._widget_cache: dict[int, list] = {}  # pagina -> widgets() (per hint)

        # Editing diretto sulla pagina: immagine in attesa di conferma
        # (trascinabile prima di essere impressa), trascinamento in corso
        # (di un'annotazione di testo esistente o dell'immagine pendente),
        # ed editor di testo fluttuante per "Aggiungi testo".
        self._pending_image: dict | None = None
        self._drag: dict | None = None
        self._text_editor: _InlineTextEdit | None = None
        self._text_editor_page: int | None = None
        self._text_editor_rect_pt: tuple | None = None

        # Raggruppamento pagine -> righe (dipende dalla modalità)
        self._rows: list[list[int]] = []
        self._row_of: dict[int, int] = {}

        # Layout di tutte le righe (coordinate "contenuto" alla scala
        # corrente): sempre l'intero documento, in ogni modalità.
        self._laid: list[int] = []      # indici globali delle righe nel layout
        self._row_y: list[int] = []     # y del bordo alto di ogni riga
        self._row_w: list[int] = []
        self._row_h: list[int] = []
        # pagina -> (indice riga nel layout, x nella riga, y, w, h)
        self._page_geo: dict[int, tuple[int, int, int, int, int]] = {}
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
        self._widget_cache.clear()
        # Nulla di "in sospeso" sopravvive al cambio di documento: non c'è
        # più un documento a cui applicarlo.
        self._pending_image = None
        self._drag = None
        if self._text_editor is not None:
            self._text_editor.deleteLater()
            self._text_editor = None
        self.clear_search()
        self._last_emitted_page = -1
        self.rotation = 0
        self._build_rows()
        self._relayout()  # layout provvisorio: dà a current_page() uno stato valido
        self.verticalScrollBar().setValue(0)
        self.horizontalScrollBar().setValue(0)
        if self.fit_mode != FIT_NONE:
            self._apply_fit()
        else:
            self._relayout()
        self.viewport().update()
        self._emit_page_changed()
        self.zoomChanged.emit(self.zoom)

    # ------------------------------------------------------------- modalità

    def _paged(self) -> bool:
        return self.mode != MODE_CONTINUOUS

    def _build_rows(self) -> None:
        n = self.doc.page_count if self.doc else 0
        if self.mode == MODE_BOOK and n > 0:
            rows = [[0]]                # copertina da sola, come in un libro
            i = 1
            while i < n:
                rows.append([i] if i + 1 >= n else [i, i + 1])
                i += 2
        else:
            rows = [[i] for i in range(n)]
        self._rows = rows
        self._row_of = {p: r for r, pages in enumerate(rows) for p in pages}

    def set_mode(self, mode: int) -> None:
        if mode == self.mode:
            return
        cur = self.current_page()
        self.mode = mode
        self.modeChanged.emit(MODE_NAMES[mode])
        if self.doc is None:
            return
        self._build_rows()
        if self.fit_mode != FIT_NONE:
            self._apply_fit()
        else:
            self._relayout()
        self.goto_page(cur)
        self.viewport().update()
        self._emit_page_changed()

    # --------------------------------------------------------------- layout

    def _dims(self, page: int) -> tuple[float, float]:
        """Dimensioni (largh, alt) in punti PDF, scambiate se ruotata di 90/270."""
        w_pt, h_pt = self.doc.page_sizes[page]
        if self.rotation % 180 == 90:
            w_pt, h_pt = h_pt, w_pt
        return w_pt, h_pt

    def _relayout(self) -> None:
        """Ricalcola geometria delle righe e range delle scrollbar."""
        self._laid, self._row_y, self._row_w, self._row_h = [], [], [], []
        self._page_geo = {}
        if self.doc is None:
            self._content_w = self._content_h = 0
        else:
            laid = list(range(len(self._rows)))
            y = MARGIN
            max_w = 0
            for li, r in enumerate(laid):
                pages = self._rows[r]
                dims = [self._dims(p) for p in pages]
                widths = [max(1, round(w * self.zoom)) for w, _ in dims]
                heights = [max(1, round(h * self.zoom)) for _, h in dims]
                row_w = sum(widths) + GAP * (len(pages) - 1)
                row_h = max(heights)
                self._laid.append(r)
                self._row_y.append(y)
                self._row_w.append(row_w)
                self._row_h.append(row_h)
                x = 0
                for p, w, h in zip(pages, widths, heights):
                    self._page_geo[p] = (li, x, y, w, h)
                    x += w + GAP
                y += row_h + GAP
                max_w = max(max_w, row_w)
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

    def _row_x(self, li: int) -> int:
        """Ascissa del bordo sinistro della riga (coordinate contenuto)."""
        area_w = max(self._content_w, self.viewport().width())
        return (area_w - self._row_w[li]) // 2

    def _visible_rows(self) -> tuple[int, int]:
        """(prima, ultima) riga del layout almeno parzialmente visibile."""
        if not self._row_y:
            return (0, -1)
        top = self.verticalScrollBar().value()
        bottom = top + self.viewport().height()
        first = max(0, bisect_right(self._row_y, top) - 1)
        if self._row_y[first] + self._row_h[first] <= top and first + 1 < len(self._row_y):
            first += 1
        last = first
        while last + 1 < len(self._row_y) and self._row_y[last + 1] < bottom:
            last += 1
        return (first, last)

    def _visible_pages(self) -> list[int]:
        first, last = self._visible_rows()
        pages: list[int] = []
        for li in range(first, last + 1):
            pages.extend(self._rows[self._laid[li]])
        return pages

    def current_page(self) -> int:
        """Indice (0-based) della pagina 'corrente' per la statusbar."""
        if self.doc is None or not self._laid:
            return 0
        probe = self.verticalScrollBar().value() + self.viewport().height() // 4
        li = max(0, bisect_right(self._row_y, probe) - 1)
        li = min(li, len(self._laid) - 1)
        return self._rows[self._laid[li]][0]

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

    # ------------------------------------------------------------- rotazione

    def rotate_right(self) -> None:
        self._set_rotation((self.rotation + 90) % 360)

    def rotate_left(self) -> None:
        self._set_rotation((self.rotation - 90) % 360)

    def _set_rotation(self, degrees: int) -> None:
        if self.doc is None:
            self.rotation = degrees
            return
        cur = self.current_page()
        self.rotation = degrees
        self._fallback.clear()  # evita un fotogramma con l'orientamento vecchio
        if self.fit_mode != FIT_NONE:
            self._apply_fit()
        else:
            self._relayout()
        self.goto_page(cur)
        self.viewport().update()

    def _apply_fit(self, mode: int | None = None) -> None:
        if mode is None:
            mode = self.fit_mode
        if self.doc is None:
            self.fit_mode = mode
            return
        vp = self.viewport()
        avail_w = max(50, vp.width() - 2 * MARGIN)
        avail_h = max(50, vp.height() - 2 * MARGIN)
        # Il fit si calcola sulle righe (in modalità libro una riga è larga
        # due pagine); nelle modalità paginate conta solo la riga corrente,
        # in scorrimento continuo tutte (uno zoom uniforme per il documento).
        if self._paged():
            rows = [self._rows[self._row_of[self.current_page()]]]
        else:
            rows = self._rows
        zoom = MAX_ZOOM
        for pages in rows:
            dims = [self._dims(p) for p in pages]
            w_pt = sum(w for w, _ in dims)
            h_pt = max(h for _, h in dims)
            gaps = GAP * (len(pages) - 1)
            z = (avail_w - gaps) / w_pt
            if mode == FIT_PAGE:
                z = min(z, avail_h / h_pt)
            zoom = min(zoom, z)
        self.set_zoom(zoom, fit_mode=mode)

    def _anchor_before(self, vy: int):
        """Punto del documento sotto la y `vy` del viewport, in punti PDF.

        Restituisce None se si è in cima al documento: in quel caso, dopo
        lo zoom/fit si resta semplicemente in cima (evita derive quando il
        layout precedente era calcolato su un viewport non ancora definitivo).
        """
        if not self._row_y or self.verticalScrollBar().value() == 0:
            return None
        y = self.verticalScrollBar().value() + vy
        li = max(0, min(bisect_right(self._row_y, y) - 1, len(self._laid) - 1))
        offset_pt = (y - self._row_y[li]) / self.zoom
        # Clamp dentro la riga: un anchor fuori scala non deve mai
        # proiettare lo scroll lontano dal punto reale.
        row_h_pt = max(self._dims(p)[1] for p in self._rows[self._laid[li]])
        offset_pt = max(0.0, min(offset_pt, row_h_pt))
        return (li, offset_pt)

    def _anchor_restore(self, anchor, vy: int) -> None:
        if not self._row_y:
            return
        if anchor is None:
            self.verticalScrollBar().setValue(0)
            return
        li, offset_pt = anchor
        li = min(li, len(self._row_y) - 1)
        y = self._row_y[li] + offset_pt * self.zoom - vy
        self.verticalScrollBar().setValue(round(y))

    # ----------------------------------------------------------- navigazione

    def goto_page(self, index: int) -> None:
        if self.doc is None or not self._rows:
            return
        index = max(0, min(index, self.doc.page_count - 1))
        row = self._row_of[index]
        self.verticalScrollBar().setValue(self._row_y[row] - MARGIN)

    def state(self) -> dict:
        """Istantanea (pagina, zoom, fit, modalità, rotazione) per la persistenza."""
        return {"page": self.current_page(), "zoom": self.zoom,
                "fit_mode": self.fit_mode, "mode": self.mode,
                "rotation": self.rotation}

    def restore_state(self, state: dict) -> None:
        """Ripristina un'istantanea prodotta da `state()` sul documento aperto."""
        if self.doc is None:
            return
        rotation = state.get("rotation")
        if rotation is not None and rotation != self.rotation:
            self.rotation = rotation % 360
            self._fallback.clear()
        mode = state.get("mode")
        if mode is not None and mode != self.mode:
            self.set_mode(mode)
        fit_mode = state.get("fit_mode", FIT_NONE)
        if fit_mode != FIT_NONE:
            self._apply_fit(fit_mode)
        else:
            zoom = state.get("zoom")
            if zoom:
                self.set_zoom(zoom)
        page = state.get("page")
        if page is not None:
            self.goto_page(page)

    def next_page(self) -> None:
        # Salta di riga (non di pagina): in modalità libro una riga vale
        # due pagine, quindi "pagina successiva" non deve fermarsi a metà.
        row = self._row_of.get(self.current_page(), 0)
        if row + 1 < len(self._rows):
            self.goto_page(self._rows[row + 1][0])

    def prev_page(self) -> None:
        row = self._row_of.get(self.current_page(), 0)
        if row - 1 >= 0:
            self.goto_page(self._rows[row - 1][0])

    # -------------------------------------------------------------- editing

    def set_tool(self, tool: str | None) -> None:
        """Attiva uno strumento (TOOL_*) o torna alla sola visualizzazione (None)."""
        self.commit_pending_edits()
        self.tool = tool
        self._widget_cache.clear()
        self.viewport().setCursor(
            Qt.CursorShape.CrossCursor if tool else Qt.CursorShape.ArrowCursor)
        self.viewport().update()
        self.toolChanged.emit(tool)

    def commit_pending_edits(self) -> None:
        """Converte in modifiche reali ciò che è ancora "in sospeso": va
        chiamato prima di cambiare strumento/pagina/documento o di salvare."""
        self._commit_pending_image()
        self._close_text_editor(commit=True)

    def refresh_after_edit(self) -> None:
        """Invalida la cache di rendering dopo un edit che non cambia le pagine."""
        self._cache.clear()
        self._fallback.clear()
        self._pending.clear()
        self._widget_cache.clear()
        self.viewport().update()
        self.documentChanged.emit()

    def reload_structure(self) -> None:
        """Ricostruisce righe/layout dopo un edit che cambia numero/ordine pagine."""
        if self.doc is None:
            return
        cur = min(self.current_page(), self.doc.page_count - 1)
        self.refresh_after_edit()
        self._build_rows()
        if self.fit_mode != FIT_NONE:
            self._apply_fit()
        else:
            self._relayout()
        self.goto_page(cur)
        self.viewport().update()
        self._emit_page_changed()

    def _page_at(self, content_x: float, content_y: float):
        """Pagina sotto una coordinata di contenuto, con la sua origine (x, y)."""
        for li in range(len(self._laid)):
            row_x = self._row_x(li)
            for p in self._rows[self._laid[li]]:
                _, x_rel, gy, w, h = self._page_geo[p]
                x, y = row_x + x_rel, gy
                if x <= content_x < x + w and y <= content_y < y + h:
                    return p, x, y, w, h
        return None

    def _page_origin(self, page: int) -> tuple[float, float] | None:
        """Origine (x, y) di una pagina in coordinate di contenuto, per indice."""
        geo = self._page_geo.get(page)
        if geo is None:
            return None
        li, x_rel, y, _, _ = geo
        return self._row_x(li) + x_rel, y

    def _hit_test(self, viewport_pos) -> tuple[int, tuple[float, float]] | None:
        """Pagina e punto PDF sotto una posizione del viewport, se presenti."""
        if self.doc is None:
            return None
        content_x = viewport_pos.x() + self.horizontalScrollBar().value()
        content_y = viewport_pos.y() + self.verticalScrollBar().value()
        hit = self._page_at(content_x, content_y)
        if hit is None:
            return None
        p, x, y, _, _ = hit
        point = self.doc.to_page_point(p, content_x - x, content_y - y, self.zoom, self.rotation)
        return p, point

    def _pixel_rect_to_page_rect(self, page: int, x0: float, y0: float,
                                  x1: float, y1: float) -> tuple[float, float, float, float]:
        """Converte un rettangolo in pixel (relativo all'origine della pagina)
        nel corrispondente rettangolo PDF — l'inverso di `Document.to_pixel_rect`."""
        px0, py0 = self.doc.to_page_point(page, x0, y0, self.zoom, self.rotation)
        px1, py1 = self.doc.to_page_point(page, x1, y1, self.zoom, self.rotation)
        return (min(px0, px1), min(py0, py1), max(px0, px1), max(py0, py1))

    def _widgets_for(self, page: int) -> list:
        if page not in self._widget_cache:
            self._widget_cache[page] = self.doc.widgets(page) if self.doc else []
        return self._widget_cache[page]

    # ---------------------------------------------------- immagine in sospeso

    def start_image_placement(self, page: int, point_pt: tuple[float, float],
                               image_path: str) -> None:
        """Avvia il posizionamento di un'immagine: resta trascinabile finché
        non viene confermata (clic altrove, cambio strumento, salvataggio)."""
        if self.doc is None:
            return
        self._commit_pending_image()
        pixmap = QPixmap(image_path)
        if pixmap.isNull():
            return
        w_pt = ADD_IMAGE_WIDTH_PT
        h_pt = w_pt * pixmap.height() / pixmap.width()
        page_w, page_h = self.doc.page_sizes[page]
        x0 = max(0.0, min(point_pt[0], max(0.0, page_w - w_pt)))
        y0 = max(0.0, min(point_pt[1], max(0.0, page_h - h_pt)))
        rx0, ry0, rx1, ry1 = self.doc.to_pixel_rect(
            page, (x0, y0, x0 + w_pt, y0 + h_pt), self.zoom, self.rotation)
        origin = self._page_origin(page)
        if origin is None:
            return
        ox, oy = origin
        self._pending_image = {
            "path": image_path, "page": page, "pixmap": pixmap,
            "x": ox + min(rx0, rx1), "y": oy + min(ry0, ry1),
            "w": abs(rx1 - rx0), "h": abs(ry1 - ry0),
        }
        self.viewport().update()

    def _commit_pending_image(self) -> None:
        pi = self._pending_image
        if pi is None or self.doc is None:
            return
        self._pending_image = None
        origin = self._page_origin(pi["page"])
        if origin is not None:
            ox, oy = origin
            rect_pt = self._pixel_rect_to_page_rect(
                pi["page"], pi["x"] - ox, pi["y"] - oy,
                pi["x"] - ox + pi["w"], pi["y"] - oy + pi["h"])
            self.doc.add_image(pi["page"], rect_pt, pi["path"])
            self.refresh_after_edit()
            if self.tool == TOOL_ADD_IMAGE:
                # Strumento "a un colpo": inserita l'immagine si torna alla
                # sola visualizzazione, così il clic successivo la sposta
                # invece di aprirne un'altra.
                self.set_tool(None)

    def _cancel_pending_image(self) -> None:
        if self._pending_image is not None:
            self._pending_image = None
            self.viewport().update()

    # -------------------------------------------------------- editor inline

    def _open_text_editor(self, page: int, point_pt: tuple[float, float]) -> None:
        if self.doc is None:
            return
        self.commit_pending_edits()
        w_pt, h_pt = ADD_TEXT_SIZE_PT
        page_w, page_h = self.doc.page_sizes[page]
        x0 = max(0.0, min(point_pt[0], max(0.0, page_w - w_pt)))
        y0 = max(0.0, min(point_pt[1], max(0.0, page_h - h_pt)))
        rect_pt = (x0, y0, x0 + w_pt, y0 + h_pt)
        rx0, ry0, rx1, ry1 = self.doc.to_pixel_rect(page, rect_pt, self.zoom, self.rotation)
        origin = self._page_origin(page)
        if origin is None:
            return
        ox, oy = origin
        xoff, yoff = self.horizontalScrollBar().value(), self.verticalScrollBar().value()
        vx = ox + min(rx0, rx1) - xoff
        vy = oy + min(ry0, ry1) - yoff
        vw, vh = abs(rx1 - rx0), abs(ry1 - ry0)

        editor = _InlineTextEdit(self.viewport())
        editor.setGeometry(round(vx), round(vy), round(vw), round(vh))
        editor.setStyleSheet(
            "QTextEdit { background: white; color: black; border: 2px solid #2b6cb0; }")
        editor.setPlaceholderText("Scrivi qui… (Esc annulla, clic fuori conferma)")
        editor.committed.connect(lambda: self._close_text_editor(commit=True))
        editor.cancelled.connect(lambda: self._close_text_editor(commit=False))
        editor.show()
        editor.setFocus()
        self._text_editor = editor
        self._text_editor_page = page
        self._text_editor_rect_pt = rect_pt

    def _close_text_editor(self, commit: bool) -> None:
        editor = self._text_editor
        if editor is None:
            return
        self._text_editor = None
        text = editor.toPlainText()
        page, rect_pt = self._text_editor_page, self._text_editor_rect_pt
        self._text_editor_page = self._text_editor_rect_pt = None
        editor.hide()
        editor.deleteLater()
        if commit and text.strip() and self.doc is not None:
            self.doc.add_freetext(page, rect_pt, text)
            self.refresh_after_edit()
            if self.tool == TOOL_ADD_TEXT:
                # Strumento "a un colpo": come per le immagini, dopo
                # l'inserimento si torna alla sola visualizzazione.
                self.set_tool(None)
        self.setFocus()

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
        geo = self._page_geo.get(page)
        if geo is not None:
            _, _, y, _, _ = geo
            target = y + rect.y0 * self.zoom - self.viewport().height() // 3
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
                             "Nessun documento aperto\nCtrl+O per aprire un PDF"
                             "\n(o trascina qui un file PDF)")
            painter.end()
            return

        xoff = self.horizontalScrollBar().value()
        yoff = self.verticalScrollBar().value()
        first, last = self._visible_rows()
        self._schedule_renders()

        current = (self._hit_list[self._current_hit]
                   if 0 <= self._current_hit < len(self._hit_list) else None)
        for li in range(first, last + 1):
            row_x = self._row_x(li)
            for p in self._rows[self._laid[li]]:
                _, x_rel, gy, w, h = self._page_geo[p]
                x = row_x + x_rel - xoff
                y = gy - yoff

                key = make_key(p, self.zoom, self.rotation)
                image = self._cache.get(key)
                if image is not None:
                    painter.drawImage(x, y, image)
                else:
                    # Placeholder: bianco, oppure il render precedente riscalato
                    painter.fillRect(x, y, w, h, Qt.GlobalColor.white)
                    fallback = self._fallback.get(p)
                    if fallback is not None:
                        painter.drawImage(QRectF(x, y, w, h), fallback[1])

                painter.setPen(QPen(PAGE_BORDER))
                painter.drawRect(x, y, w - 1, h - 1)

                # In modalità "compila modulo", evidenzia i campi cliccabili
                if self.tool == TOOL_FORM:
                    for widget in self._widgets_for(p):
                        rx0, ry0, rx1, ry1 = self.doc.to_pixel_rect(
                            p, widget["rect"], self.zoom, self.rotation)
                        painter.fillRect(QRectF(x + rx0, y + ry0, rx1 - rx0, ry1 - ry0),
                                         WIDGET_HINT)
                        painter.setPen(QPen(WIDGET_HINT_BORDER))
                        painter.drawRect(QRectF(x + rx0, y + ry0, rx1 - rx0, ry1 - ry0))

                # Evidenziazione risultati di ricerca
                rects = self._hits.get(p)
                if rects:
                    for rect in rects:
                        color = (HIGHLIGHT_CURRENT
                                 if current is not None and current[0] == p
                                 and current[1] is rect
                                 else HIGHLIGHT)
                        painter.fillRect(
                            QRectF(x + rect.x0 * self.zoom, y + rect.y0 * self.zoom,
                                   (rect.x1 - rect.x0) * self.zoom,
                                   (rect.y1 - rect.y0) * self.zoom),
                            color)

        # Immagine in attesa di conferma (segue il trascinamento se in corso)
        if self._pending_image is not None:
            pi = self._pending_image
            if self._drag is not None and self._drag["kind"] == "pending_image":
                px, py = self._drag["x"], self._drag["y"]
            else:
                px, py = pi["x"], pi["y"]
            rect = QRectF(px - xoff, py - yoff, pi["w"], pi["h"])
            painter.drawPixmap(rect, pi["pixmap"], QRectF(pi["pixmap"].rect()))
            painter.setPen(QPen(DRAG_OUTLINE, 2, Qt.PenStyle.DashLine))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawRect(rect)

        # Anteprima del trascinamento di un'annotazione di testo esistente
        if self._drag is not None and self._drag["kind"] == "annot":
            d = self._drag
            rect = QRectF(d["x"] - xoff, d["y"] - yoff, d["w"], d["h"])
            painter.setPen(QPen(DRAG_OUTLINE, 2, Qt.PenStyle.DashLine))
            painter.setBrush(DRAG_FILL)
            painter.drawRect(rect)

        painter.end()

    # ---------------------------------------------------- rendering asincrono

    def _schedule_renders(self) -> None:
        """Accoda i render mancanti per le righe visibili + prefetch.

        Il prefetch lavora sugli indici globali delle righe: pre-renderizza
        anche le pagine appena fuori dal viewport, così scorrendo (con
        rotella, tasti o trascinando la barra di scorrimento) le si trova
        già pronte.
        """
        first, last = self._visible_rows()
        if last < first:
            return
        pages = []
        for li in range(first, last + 1):
            pages.extend(self._rows[self._laid[li]])
        gfirst, glast = self._laid[first], self._laid[last]
        for r in (list(range(gfirst - 1, gfirst - PREFETCH - 1, -1))
                  + list(range(glast + 1, glast + PREFETCH + 1))):
            if 0 <= r < len(self._rows):
                pages.extend(self._rows[r])

        wanted = set()
        order = []  # prima le visibili, poi il prefetch
        for p in pages:
            key = make_key(p, self.zoom, self.rotation)
            if key not in wanted:
                wanted.add(key)
                order.append((p, key))
        self._wanted = wanted  # sostituzione atomica, letta dai worker

        for p, key in order:
            if self._cache.get(key) is None and key not in self._pending:
                self._pending.add(key)
                task = RenderTask(self.doc, p, self.zoom, key,
                                  self._still_needed, self._render_signals,
                                  rotation=self.rotation)
                self._pool.start(task)

    def _still_needed(self, key) -> bool:
        return key in self._wanted

    def _on_render_done(self, page: int, key, image) -> None:
        self._pending.discard(key)
        self._cache.put(key, image)
        self._fallback[page] = (key[1], image)
        # Tieni i fallback solo per poche pagine (memoria limitata sul Pi)
        if len(self._fallback) > 8:
            visible = set(self._visible_pages()) | {page}
            for stale in [p for p in self._fallback if p not in visible][:4]:
                del self._fallback[stale]
        if key[1] == round(self.zoom, 3) and key[2] == self.rotation:
            self.viewport().update()

    # ---------------------------------------------------------------- eventi

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        # La geometria dell'editor di testo fluttuante è fissata alla
        # posizione dell'apertura: un resize la renderebbe disallineata.
        self._close_text_editor(commit=True)
        if self.fit_mode != FIT_NONE and self.doc is not None:
            self._apply_fit()
        else:
            self._relayout()

    def scrollContentsBy(self, dx: int, dy: int) -> None:
        # Idem per lo scroll: l'editor non segue la pagina, quindi si
        # committa prima che si disallinei.
        self._close_text_editor(commit=True)
        self.viewport().update()

    def mousePressEvent(self, event) -> None:
        if event.button() != Qt.MouseButton.LeftButton or self.doc is None:
            super().mousePressEvent(event)
            return
        pos = event.position().toPoint()
        content_x = pos.x() + self.horizontalScrollBar().value()
        content_y = pos.y() + self.verticalScrollBar().value()

        # Un'immagine in attesa di conferma: un clic al suo interno la
        # trascina, uno fuori la conferma prima di valutare il resto.
        if self._pending_image is not None:
            pi = self._pending_image
            if pi["x"] <= content_x <= pi["x"] + pi["w"] and \
                    pi["y"] <= content_y <= pi["y"] + pi["h"]:
                self._drag = {
                    "kind": "pending_image",
                    "x": pi["x"], "y": pi["y"], "w": pi["w"], "h": pi["h"],
                    "grab_dx": content_x - pi["x"], "grab_dy": content_y - pi["y"],
                }
                self.viewport().setCursor(Qt.CursorShape.SizeAllCursor)
                event.accept()
                return
            self._commit_pending_image()

        if self.tool is not None:
            hit = self._hit_test(pos)
            if hit is not None:
                page, point = hit
                if self.tool == TOOL_ADD_TEXT:
                    self._open_text_editor(page, point)
                else:
                    self.editRequested.emit(self.tool, page, point)
                event.accept()
                return
            super().mousePressEvent(event)
            return

        # Nessuno strumento attivo: un clic su un'annotazione di testo
        # esistente la rende trascinabile, senza bisogno di uno strumento
        # dedicato ("sposta ciò che clicchi", come nella maggior parte
        # degli editor).
        hit = self._page_at(content_x, content_y)
        if hit is not None:
            page, px, py, _, _ = hit
            for annot in self.doc.text_annots(page):
                rx0, ry0, rx1, ry1 = self.doc.to_pixel_rect(
                    page, annot["rect"], self.zoom, self.rotation)
                ax0, ay0 = px + min(rx0, rx1), py + min(ry0, ry1)
                ax1, ay1 = px + max(rx0, rx1), py + max(ry0, ry1)
                if ax0 <= content_x <= ax1 and ay0 <= content_y <= ay1:
                    self._drag = {
                        "kind": "annot", "page": page, "xref": annot["xref"],
                        "x": ax0, "y": ay0, "w": ax1 - ax0, "h": ay1 - ay0,
                        "grab_dx": content_x - ax0, "grab_dy": content_y - ay0,
                    }
                    self.viewport().setCursor(Qt.CursorShape.SizeAllCursor)
                    event.accept()
                    return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:
        if self._drag is not None:
            pos = event.position().toPoint()
            content_x = pos.x() + self.horizontalScrollBar().value()
            content_y = pos.y() + self.verticalScrollBar().value()
            self._drag["x"] = content_x - self._drag["grab_dx"]
            self._drag["y"] = content_y - self._drag["grab_dy"]
            self.viewport().update()
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:
        if self._drag is not None:
            drag = self._drag
            self._drag = None
            self.viewport().setCursor(
                Qt.CursorShape.CrossCursor if self.tool else Qt.CursorShape.ArrowCursor)
            if drag["kind"] == "annot":
                origin = self._page_origin(drag["page"])
                if origin is not None and self.doc is not None:
                    ox, oy = origin
                    rect_pt = self._pixel_rect_to_page_rect(
                        drag["page"], drag["x"] - ox, drag["y"] - oy,
                        drag["x"] - ox + drag["w"], drag["y"] - oy + drag["h"])
                    self.doc.move_annotation(drag["page"], drag["xref"], rect_pt)
                    self.refresh_after_edit()
            elif drag["kind"] == "pending_image" and self._pending_image is not None:
                self._pending_image["x"] = drag["x"]
                self._pending_image["y"] = drag["y"]
                self.viewport().update()
            event.accept()
            return
        super().mouseReleaseEvent(event)

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
        has_doc = self.doc is not None

        if key == Qt.Key.Key_Escape and self._pending_image is not None:
            self._cancel_pending_image()
        elif ctrl and key in (Qt.Key.Key_Plus, Qt.Key.Key_Equal):
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
        elif key == Qt.Key.Key_Right and has_doc:
            self.next_page()
        elif key == Qt.Key.Key_Left and has_doc:
            self.prev_page()
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
