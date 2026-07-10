"""Genera l'icona dell'app (assets/icon.png e assets/icon.ico).

Uso: venv/bin/python packaging/make_icon.py

Disegnata con QPainter (nessuna dipendenza extra): una pagina bianca con
angolo piegato e una fascia blu con "PDF", nello stile minimale del resto
dell'app.
"""

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QFont, QGuiApplication, QImage, QPainter, QPainterPath

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")

PAGE = QColor(250, 250, 250)
BORDER = QColor(120, 122, 128)
FOLD = QColor(214, 216, 220)
ACCENT = QColor(43, 108, 176)  # stesso blu della selezione nella sidebar
TEXT = QColor(255, 255, 255)


def draw_icon(size: int) -> QImage:
    image = QImage(size, size, QImage.Format.Format_ARGB32_Premultiplied)
    image.fill(Qt.GlobalColor.transparent)
    painter = QPainter(image)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)

    m = size * 0.10       # margine
    fold = size * 0.22    # angolo piegato in alto a destra
    w = size - 2 * m
    h = size - 2 * m

    path = QPainterPath()
    path.moveTo(m, m)
    path.lineTo(m + w - fold, m)
    path.lineTo(m + w, m + fold)
    path.lineTo(m + w, m + h)
    path.lineTo(m, m + h)
    path.closeSubpath()
    painter.setPen(BORDER)
    painter.setBrush(PAGE)
    painter.drawPath(path)

    fold_path = QPainterPath()
    fold_path.moveTo(m + w - fold, m)
    fold_path.lineTo(m + w, m + fold)
    fold_path.lineTo(m + w - fold, m + fold)
    fold_path.closeSubpath()
    painter.setBrush(FOLD)
    painter.drawPath(fold_path)

    band_h = h * 0.34
    band_y = m + h - band_h
    painter.setPen(Qt.PenStyle.NoPen)
    painter.setBrush(ACCENT)
    painter.drawRect(QRectF(m, band_y, w, band_h))

    font = QFont("DejaVu Sans", round(band_h * 0.5), QFont.Weight.Bold)
    painter.setFont(font)
    painter.setPen(TEXT)
    painter.drawText(QRectF(m, band_y, w, band_h),
                     Qt.AlignmentFlag.AlignCenter, "PDF")

    painter.end()
    return image


def main():
    QGuiApplication([])
    os.makedirs(ASSETS, exist_ok=True)

    png_path = os.path.join(ASSETS, "icon.png")
    draw_icon(256).save(png_path, "PNG")
    print(f"scritto {png_path}")

    ico_path = os.path.join(ASSETS, "icon.ico")
    draw_icon(256).save(ico_path, "ICO")
    print(f"scritto {ico_path}")


if __name__ == "__main__":
    main()
