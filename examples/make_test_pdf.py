"""Genera examples/test.pdf: un PDF di prova di 6 pagine con testo e forme.

Uso: venv/bin/python examples/make_test_pdf.py
"""

import os

import pymupdf

LOREM = (
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod "
    "tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim "
    "veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea "
    "commodo consequat. Duis aute irure dolor in reprehenderit in voluptate "
    "velit esse cillum dolore eu fugiat nulla pariatur. "
)

PAGES = 6
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test.pdf")


def main():
    doc = pymupdf.open()
    for n in range(1, PAGES + 1):
        page = doc.new_page(width=595, height=842)  # A4 in punti
        page.insert_text((72, 80), f"Pagina di prova {n}",
                         fontsize=22, fontname="helv")
        page.insert_text((72, 100), "PDF Tool — viewer leggero e veloce",
                         fontsize=11, fontname="helv", color=(0.3, 0.3, 0.3))
        # Corpo del testo (la parola 'velocita' serve a testare la ricerca)
        body = (f"Questa e' la pagina {n} di {PAGES}. "
                "La priorita' del progetto e' la velocita': avvio rapido, "
                "scroll fluido e zoom reattivo, come SumatraPDF.\n\n") + LOREM * 6
        page.insert_textbox(pymupdf.Rect(72, 130, 523, 700), body,
                            fontsize=11, fontname="helv")
        # Qualche forma per rendere il rendering meno banale
        page.draw_rect(pymupdf.Rect(72, 710, 210, 770),
                       color=(0.1, 0.3, 0.8), fill=(0.85, 0.9, 1.0), width=1.5)
        page.draw_circle((300, 740), 30, color=(0.8, 0.2, 0.2),
                         fill=(1.0, 0.9, 0.9), width=1.5)
        page.insert_text((72, 800), f"— {n} / {PAGES} —",
                         fontsize=9, fontname="helv", color=(0.5, 0.5, 0.5))
    doc.save(OUT)
    doc.close()
    print(f"Creato {OUT} ({PAGES} pagine)")


if __name__ == "__main__":
    main()
