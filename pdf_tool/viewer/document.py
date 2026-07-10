"""Wrapper thread-safe attorno a PyMuPDF.

Tiene tutto il codice MuPDF in un punto solo: il resto dell'app parla
solo con questa classe. In Fase 2 (annotazioni, form, firma) basterà
estendere questo modulo senza toccare il viewer.
"""

from __future__ import annotations

import threading

import pymupdf


class DocumentError(Exception):
    """Errore di apertura/lettura del documento."""


class Document:
    """Documento PDF in sola lettura, accessibile da più thread.

    MuPDF non è thread-safe sullo stesso documento: tutte le operazioni
    che toccano l'handle nativo sono serializzate da un lock. I metadati
    usati dal thread UI (numero e dimensioni pagine) vengono letti una
    volta sola all'apertura, così la UI non prende mai il lock.
    """

    def __init__(self, path: str):
        self._lock = threading.Lock()
        try:
            self._doc = pymupdf.open(path)
        except Exception as exc:  # file mancante, corrotto, non PDF...
            raise DocumentError(str(exc)) from exc
        if self._doc.needs_pass:
            self._doc.close()
            raise DocumentError("Il PDF è protetto da password (non supportato in Fase 1).")

        self.path = path
        self.page_count = self._doc.page_count
        if self.page_count == 0:
            self._doc.close()
            raise DocumentError("Il documento non contiene pagine.")

        # Dimensioni pagina in punti PDF (1 pt = 1/72"), cache per la UI.
        self.page_sizes: list[tuple[float, float]] = []
        for i in range(self.page_count):
            rect = self._doc[i].rect
            self.page_sizes.append((rect.width, rect.height))

    # ------------------------------------------------------------------ render

    def render(self, index: int, scale: float):
        """Renderizza una pagina e restituisce una QImage RGB.

        Pensato per essere chiamato da un thread worker (mai dal thread UI).
        """
        from PySide6.QtGui import QImage

        with self._lock:
            page = self._doc[index]
            matrix = pymupdf.Matrix(scale, scale)
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
                rects = self._doc[i].search_for(text)
            if rects:
                results[i] = rects
        return results

    # ----------------------------------------------------------------- indice

    def outline(self) -> list[tuple[int, str, int]]:
        """Indice/segnalibri: lista di (livello, titolo, pagina 0-based).

        pagina è -1 se la voce non punta a una pagina valida.
        """
        with self._lock:
            toc = self._doc.get_toc(simple=True)
        return [(level, title, (page - 1) if page and page > 0 else -1)
                for level, title, page in toc]

    # ------------------------------------------------------------------ misc

    def close(self):
        with self._lock:
            self._doc.close()
