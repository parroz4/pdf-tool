# PyInstaller spec per la build portatile Windows.
# Uso (da Windows, nella root del progetto):
#   pip install -r requirements.txt pyinstaller
#   pyinstaller packaging/pdf_tool_win.spec
# Risultato: dist/PDFTool/ — cartella portatile, si avvia con PDFTool.exe
#
# Modalità onedir (cartella) e non onefile: onefile si auto-estrae a ogni
# avvio e costa secondi — contro l'obiettivo "veloce come SumatraPDF".

from PySide6 import __file__ as _pyside_file  # noqa: F401 - fail fast se manca

a = Analysis(
    ["../launcher.py"],
    pathex=[".."],
    excludes=[
        # Moduli Qt pesanti che il viewer non usa
        "PySide6.QtWebEngineCore",
        "PySide6.QtWebEngineWidgets",
        "PySide6.QtMultimedia",
        "PySide6.Qt3DCore",
        "PySide6.QtCharts",
        "PySide6.QtQml",
        "PySide6.QtQuick",
        "PySide6.QtNetwork",
        "PySide6.QtSql",
        "PySide6.QtTest",
        "tkinter",
    ],
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    name="PDFTool",
    console=False,
    upx=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    name="PDFTool",
)
