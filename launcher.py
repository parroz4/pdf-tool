"""Entry point per PyInstaller (il packaging di `python -m pdf_tool` è macchinoso)."""

from pdf_tool.app import main

raise SystemExit(main())
