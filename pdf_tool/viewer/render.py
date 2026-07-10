"""Rendering asincrono delle pagine: cache LRU + task su QThreadPool.

Il thread UI non renderizza mai: chiede pagine alla cache e, se mancano,
accoda un RenderTask. Al completamento il task emette un segnale e la
view ridipinge solo se il risultato è ancora attuale.
"""

from __future__ import annotations

from collections import OrderedDict

from PySide6.QtCore import QObject, QRunnable, Signal

# Chiave di cache: (indice_pagina, scala_arrotondata, rotazione)
CacheKey = tuple[int, float, int]


def make_key(page: int, scale: float, rotation: int = 0) -> CacheKey:
    return (page, round(scale, 3), rotation)


class LRUImageCache:
    """Cache LRU di QImage con budget in byte (non in numero di voci)."""

    def __init__(self, max_bytes: int = 96 * 1024 * 1024):
        self.max_bytes = max_bytes
        self._bytes = 0
        self._data: OrderedDict[CacheKey, object] = OrderedDict()

    def get(self, key: CacheKey):
        image = self._data.get(key)
        if image is not None:
            self._data.move_to_end(key)
        return image

    def put(self, key: CacheKey, image) -> None:
        old = self._data.pop(key, None)
        if old is not None:
            self._bytes -= old.sizeInBytes()
        self._data[key] = image
        self._bytes += image.sizeInBytes()
        while self._bytes > self.max_bytes and len(self._data) > 1:
            _, evicted = self._data.popitem(last=False)
            self._bytes -= evicted.sizeInBytes()

    def clear(self) -> None:
        self._data.clear()
        self._bytes = 0


class RenderSignals(QObject):
    # page, key, QImage — emesso dal thread worker, consegnato al thread UI
    done = Signal(int, tuple, object)


class RenderTask(QRunnable):
    """Renderizza una singola pagina in un thread del pool."""

    def __init__(self, document, page: int, scale: float,
                 key: CacheKey, still_needed, signals: RenderSignals,
                 rotation: int = 0):
        super().__init__()
        self.setAutoDelete(True)
        self._document = document
        self._page = page
        self._scale = scale
        self._key = key
        self._still_needed = still_needed  # callable(key) -> bool
        self._signals = signals
        self._rotation = rotation

    def run(self):
        # Se nel frattempo l'utente ha scrollato/zoomato altrove, non
        # sprecare CPU: il task viene semplicemente scartato.
        if not self._still_needed(self._key):
            return
        try:
            image = self._document.render(self._page, self._scale, self._rotation)
        except Exception:
            return  # pagina corrotta o documento chiuso: ignora
        self._signals.done.emit(self._page, self._key, image)


class SearchSignals(QObject):
    # testo cercato, dict {pagina: [Rect, ...]}
    finished = Signal(str, object)


class SearchTask(QRunnable):
    """Ricerca full-text in un thread del pool (non blocca la UI)."""

    def __init__(self, document, text: str, cancelled, signals: SearchSignals):
        super().__init__()
        self.setAutoDelete(True)
        self._document = document
        self._text = text
        self._cancelled = cancelled  # callable() -> bool
        self._signals = signals

    def run(self):
        try:
            results = self._document.search(self._text, cancelled=self._cancelled)
        except Exception:
            results = {}
        if not self._cancelled():
            self._signals.finished.emit(self._text, results)
