"""Wrapper thread-safe attorno a PyMuPDF.

Tiene tutto il codice MuPDF in un punto solo: il resto dell'app parla
solo con questa classe. Il rendering/ricerca (sezioni sopra) restano
operazioni di sola lettura chiamabili da thread worker; le operazioni di
editing (sezione sotto) mutano il documento in memoria e vanno chiamate
dal thread UI — dopo vanno sempre seguite da un refresh della vista
(cache/layout) perché le pagine coinvolte sono cambiate.

Undo/redo: ogni operazione di editing chiama `_checkpoint()` prima di
mutare, che salva un'istantanea del documento (bytes in memoria, via
`Document.tobytes`). Annullare/ripristinare significa riaprire da
un'istantanea invece di invertire ogni singola operazione: più semplice e
robusto di un undo "chirurgico" per-operazione (specie per operazioni
strutturali come inserimento/eliminazione pagine), al costo di un po' di
memoria — limitata da `MAX_UNDO`.
"""

from __future__ import annotations

import os
import threading

import pymupdf

MAX_UNDO = 20


class DocumentError(Exception):
    """Errore di apertura/lettura del documento."""


class Document:
    """Documento PDF accessibile da più thread, con editing in memoria.

    MuPDF non è thread-safe sullo stesso documento: tutte le operazioni
    che toccano l'handle nativo sono serializzate da un lock. I metadati
    usati dal thread UI (numero e dimensioni pagine) vengono cache-ati e
    ricalcolati esplicitamente (`_refresh_metadata`) dopo ogni modifica
    che cambia il numero o l'ordine delle pagine.
    """

    def __init__(self, path: str):
        self._lock = threading.Lock()
        self._closed = False
        self._undo_stack: list[bytes] = []
        self._redo_stack: list[bytes] = []
        try:
            self._doc = pymupdf.open(path)
        except Exception as exc:  # file mancante, corrotto, non PDF...
            raise DocumentError(str(exc)) from exc
        if self._doc.needs_pass:
            self._doc.close()
            raise DocumentError("Il PDF è protetto da password (non supportato in Fase 1).")

        self.path = path
        self.dirty = False  # True se ci sono modifiche non salvate
        self.page_count = 0
        self.page_sizes: list[tuple[float, float]] = []
        self._refresh_metadata()
        if self.page_count == 0:
            self._doc.close()
            raise DocumentError("Il documento non contiene pagine.")

    def _ensure_open(self) -> None:
        """Da chiamare mentre si tiene il lock: impedisce di toccare l'handle
        MuPDF dopo close(). Senza questa guardia, un RenderTask in background
        potrebbe accedere all'handle appena chiuso da un altro thread (crash
        o blocco a livello nativo, non un'eccezione Python pulita)."""
        if self._closed:
            raise DocumentError("Il documento è stato chiuso.")

    def _refresh_metadata(self) -> None:
        """Ricalcola numero e dimensioni pagina dopo una modifica strutturale."""
        with self._lock:
            self._ensure_open()
            self.page_count = self._doc.page_count
            self.page_sizes = [(self._doc[i].rect.width, self._doc[i].rect.height)
                                for i in range(self.page_count)]

    # ------------------------------------------------------------ undo/redo

    def _checkpoint(self) -> None:
        """Salva un'istantanea PRIMA di una modifica, per poterla annullare."""
        with self._lock:
            self._ensure_open()
            snapshot = self._doc.tobytes(garbage=1, deflate=True)
        self._undo_stack.append(snapshot)
        del self._undo_stack[:-MAX_UNDO]
        self._redo_stack.clear()

    def can_undo(self) -> bool:
        return bool(self._undo_stack)

    def can_redo(self) -> bool:
        return bool(self._redo_stack)

    def undo(self) -> None:
        if self._undo_stack:
            self._swap_snapshot(self._undo_stack, self._redo_stack)

    def redo(self) -> None:
        if self._redo_stack:
            self._swap_snapshot(self._redo_stack, self._undo_stack)

    def _swap_snapshot(self, pop_from: list[bytes], push_to: list[bytes]) -> None:
        with self._lock:
            self._ensure_open()
            current = self._doc.tobytes(garbage=1, deflate=True)
            snapshot = pop_from.pop()
            self._doc.close()
            self._doc = pymupdf.open(stream=snapshot, filetype="pdf")
        push_to.append(current)
        self.dirty = True
        self._refresh_metadata()

    # ------------------------------------------------------------------ render

    def render(self, index: int, scale: float, rotation: int = 0):
        """Renderizza una pagina e restituisce una QImage RGB.

        `rotation` è una rotazione a scelta dell'utente (0/90/180/270),
        indipendente da quella eventualmente incorporata nel PDF stesso.
        Pensato per essere chiamato da un thread worker (mai dal thread UI).
        """
        from PySide6.QtGui import QImage

        with self._lock:
            self._ensure_open()
            page = self._doc[index]
            matrix = pymupdf.Matrix(scale, scale).prerotate(rotation)
            pix = page.get_pixmap(matrix=matrix, alpha=False)

        image = QImage(
            pix.samples, pix.width, pix.height, pix.stride,
            QImage.Format.Format_RGB888,
        ).copy()  # copy(): stacca la QImage dal buffer di MuPDF
        return image

    # ------------------------------------------------------------------ search

    def search(self, text: str, cancelled=None) -> dict[int, list]:
        """Cerca `text` in tutto il documento.

        Restituisce {indice_pagina: [pymupdf.Rect, ...]}. Il lock viene
        preso pagina per pagina, così il rendering non resta bloccato per
        tutta la durata della ricerca. `cancelled` è un callable opzionale
        che permette di interrompere la ricerca tra una pagina e l'altra.
        """
        results: dict[int, list] = {}
        for i in range(self.page_count):
            if cancelled is not None and cancelled():
                return results
            with self._lock:
                if self._closed:
                    return results
                rects = self._doc[i].search_for(text)
            if rects:
                results[i] = rects
        return results

    def _render_matrix_and_origin(self, index: int, scale: float, rotation: int):
        """Matrice di render e origine del pixmap risultante.

        Con `prerotate`, MuPDF trasla l'origine del pixmap (es. a 90/270°
        parte dei punti trasformati cadono in coordinate negative): il
        pixel (0,0) dell'immagine NON è la matrice applicata al punto
        (0,0) della pagina, ma al bordo del bounding box trasformato.
        Le conversioni pixel<->punto PDF devono tenerne conto.
        """
        with self._lock:
            self._ensure_open()
            page_rect = self._doc[index].rect
        matrix = pymupdf.Matrix(scale, scale).prerotate(rotation)
        bbox = (page_rect * matrix)
        bbox.normalize()
        return matrix, bbox.x0, bbox.y0

    def to_page_point(self, index: int, x_px: float, y_px: float,
                       scale: float, rotation: int = 0) -> tuple[float, float]:
        """Converte un pixel del render (a `scale`/`rotation`) in punto PDF.

        Inverte la stessa matrice usata da `render()` (con l'origine
        corretta), quindi un clic sull'immagine mostrata a schermo torna
        al punto esatto sulla pagina.
        """
        matrix, ox, oy = self._render_matrix_and_origin(index, scale, rotation)
        point = pymupdf.Point(x_px + ox, y_px + oy) * ~matrix
        return (point.x, point.y)

    def to_pixel_rect(self, index: int, rect_pt: tuple[float, float, float, float],
                       scale: float, rotation: int = 0) -> tuple[float, float, float, float]:
        """Converte un rettangolo PDF nel corrispondente rettangolo pixel del render."""
        matrix, ox, oy = self._render_matrix_and_origin(index, scale, rotation)
        rect = pymupdf.Rect(*rect_pt).transform(matrix)
        rect.normalize()
        return (rect.x0 - ox, rect.y0 - oy, rect.x1 - ox, rect.y1 - oy)

    # ----------------------------------------------------------------- indice

    def outline(self) -> list[tuple[int, str, int]]:
        """Indice/segnalibri: lista di (livello, titolo, pagina 0-based).

        pagina è -1 se la voce non punta a una pagina valida.
        """
        with self._lock:
            self._ensure_open()
            toc = self._doc.get_toc(simple=True)
        return [(level, title, (page - 1) if page and page > 0 else -1)
                for level, title, page in toc]

    # ----------------------------------------------------------------- form

    def widgets(self, index: int) -> list[dict]:
        """Campi modulo della pagina: nome, tipo, rettangolo (punti PDF), valore."""
        with self._lock:
            self._ensure_open()
            page = self._doc[index]
            return [
                {"name": w.field_name, "type": w.field_type_string,
                 "rect": (w.rect.x0, w.rect.y0, w.rect.x1, w.rect.y1),
                 "value": w.field_value}
                for w in (page.widgets() or [])
            ]

    def set_widget_value(self, index: int, field_name: str, value) -> bool:
        """Imposta il valore di un campo modulo. Restituisce False se non trovato."""
        self._checkpoint()
        with self._lock:
            self._ensure_open()
            page = self._doc[index]
            for w in (page.widgets() or []):
                if w.field_name == field_name:
                    w.field_value = value
                    w.update()
                    self.dirty = True
                    return True
        self._undo_stack.pop()  # nessuna modifica fatta: annulla il checkpoint
        return False

    # --------------------------------------------------------------- editing

    def add_freetext(self, index: int, rect_pt: tuple[float, float, float, float],
                      text: str, fontsize: float = 12, color=(0, 0, 0)) -> int:
        """Inserisce una casella di testo (annotazione FreeText). Restituisce l'xref."""
        self._checkpoint()
        with self._lock:
            self._ensure_open()
            page = self._doc[index]
            annot = page.add_freetext_annot(
                pymupdf.Rect(*rect_pt), text, fontsize=fontsize, text_color=color)
            annot.update()
            xref = annot.xref
        self.dirty = True
        return xref

    def text_annots(self, index: int) -> list[dict]:
        """Annotazioni di testo (FreeText) della pagina: xref e rettangolo."""
        with self._lock:
            self._ensure_open()
            page = self._doc[index]
            result = []
            annot = page.first_annot
            while annot is not None:
                if annot.type[1] == "FreeText":
                    r = annot.rect
                    result.append({"xref": annot.xref, "rect": (r.x0, r.y0, r.x1, r.y1)})
                annot = annot.next
            return result

    def move_annotation(self, index: int, xref: int,
                         rect_pt: tuple[float, float, float, float],
                         checkpoint: bool = True) -> None:
        """Sposta/ridimensiona un'annotazione esistente (identificata da xref).

        `checkpoint=False` durante un trascinamento continuo: un solo
        checkpoint all'inizio del gesto, non uno per ogni movimento del
        mouse (altrimenti la pila di undo si riempirebbe di micro-passi).
        """
        if checkpoint:
            self._checkpoint()
        with self._lock:
            self._ensure_open()
            page = self._doc[index]
            annot = page.load_annot(xref)
            annot.set_rect(pymupdf.Rect(*rect_pt))
            annot.update()
        self.dirty = True

    def add_image(self, index: int, rect_pt: tuple[float, float, float, float],
                   image_path: str) -> None:
        """Inserisce un'immagine sulla pagina (impressa nel contenuto, come un timbro).

        A differenza del testo, il formato PDF non offre un equivalente
        nativo di "annotazione immagine" spostabile: per questo l'app la
        tiene in un overlay trascinabile finché non viene confermata (vedi
        PdfView._pending_image in view.py), e la imprime solo a quel punto.
        """
        self._checkpoint()
        with self._lock:
            self._ensure_open()
            page = self._doc[index]
            page.insert_image(pymupdf.Rect(*rect_pt), filename=image_path)
        self.dirty = True

    def insert_pdf(self, other_path: str, at_index: int | None = None) -> None:
        """Inserisce tutte le pagine di un altro PDF.

        `at_index=None` accoda in fondo; altrimenti le pagine vengono
        inserite a partire da quella posizione (0-based).
        """
        self._checkpoint()
        with self._lock:
            self._ensure_open()
            other = pymupdf.open(other_path)
            try:
                self._doc.insert_pdf(other, start_at=-1 if at_index is None else at_index)
            finally:
                other.close()
        self.dirty = True
        self._refresh_metadata()

    def insert_pdf_bytes(self, data: bytes, at_index: int | None = None) -> None:
        """Come `insert_pdf`, ma da un PDF già in memoria (usato per "incolla")."""
        self._checkpoint()
        with self._lock:
            self._ensure_open()
            other = pymupdf.open(stream=data, filetype="pdf")
            try:
                self._doc.insert_pdf(other, start_at=-1 if at_index is None else at_index)
            finally:
                other.close()
        self.dirty = True
        self._refresh_metadata()

    def extract_pages_bytes(self, indices: list[int]) -> bytes:
        """Estrae le pagine indicate (nell'ordine dato) come PDF a sé, in memoria.

        Non modifica il documento: usato per "copia" (e come primo passo di
        "taglia", seguito da `delete_pages`). `select()` ricostruisce il
        documento sul posto, quindi si lavora su una copia leggera
        (round-trip in memoria via tobytes) piuttosto che sull'originale.
        """
        with self._lock:
            self._ensure_open()
            data = self._doc.tobytes(garbage=1, deflate=True)
        copy_doc = pymupdf.open(stream=data, filetype="pdf")
        try:
            copy_doc.select(indices)
            return copy_doc.tobytes(garbage=1, deflate=True)
        finally:
            copy_doc.close()

    def move_page(self, from_index: int, to_index: int) -> None:
        """Sposta una pagina: `to_index` è la posizione finale (0-based)."""
        self._checkpoint()
        with self._lock:
            self._ensure_open()
            self._doc.move_page(from_index, to_index)
        self.dirty = True
        self._refresh_metadata()

    def delete_page(self, index: int) -> None:
        self.delete_pages([index])

    def delete_pages(self, indices: list[int]) -> None:
        """Elimina più pagine in un colpo solo (un solo checkpoint di undo)."""
        if self.page_count - len(set(indices)) < 1:
            raise DocumentError("Non è possibile eliminare tutte le pagine del documento.")
        self._checkpoint()
        with self._lock:
            self._ensure_open()
            for i in sorted(set(indices), reverse=True):
                self._doc.delete_page(i)
        self.dirty = True
        self._refresh_metadata()

    def save(self, path: str | None = None) -> None:
        """Salva il documento (sul file originale, o su un nuovo percorso).

        Scrive su un file temporaneo e poi sostituisce, per non lasciare un
        file a metà in caso di errore durante la scrittura.
        """
        target = path or self.path
        tmp = target + ".tmp"
        with self._lock:
            self._ensure_open()
            self._doc.save(tmp, garbage=1, deflate=True)
        os.replace(tmp, target)
        self.path = target
        self.dirty = False

    # ------------------------------------------------------------------ misc

    def close(self):
        with self._lock:
            if not self._closed:
                self._doc.close()
                self._closed = True
