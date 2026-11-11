import { useEffect, useState } from 'react';
import { exportPdf, handleFiles, isImage, PDF_ACCEPT, pickFiles } from './state/actions';
import {
  checkpoint,
  getState,
  redo,
  removeAnnot,
  setState,
  undo,
  useStore,
} from './state/store';
import { Toolbar } from './ui/Toolbar';
import { viewerApi } from './viewer/api';
import SearchBar from './viewer/SearchBar';
import Thumbnails from './viewer/Thumbnails';
import Viewer from './viewer/Viewer';

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');

function onKeyDown(e: KeyboardEvent): void {
  const s = getState();
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'o') {
    e.preventDefault();
    void pickFiles(PDF_ACCEPT, false).then((f) => handleFiles(f));
    return;
  }
  if (s.pages.length === 0) return;
  if (mod && key === 's') {
    e.preventDefault();
    void exportPdf();
  } else if (mod && key === 'f') {
    e.preventDefault();
    setState({ searchOpen: true });
    document.querySelector<HTMLInputElement>('[data-testid="search-input"]')?.select();
  } else if (mod && (key === '+' || key === '=')) {
    e.preventDefault();
    viewerApi.zoomBy(1.2);
  } else if (mod && key === '-') {
    e.preventDefault();
    viewerApi.zoomBy(1 / 1.2);
  } else if (mod && key === '0') {
    e.preventDefault();
    setState({ zoomMode: 'fit-page' });
  } else if (mod && key === '1') {
    e.preventDefault();
    setState({ zoomMode: 'custom', zoom: 1 });
  } else if (mod && key === '2') {
    e.preventDefault();
    setState({ zoomMode: 'fit-width' });
  } else if (e.key === 'F4') {
    e.preventDefault();
    setState({ sidebar: !s.sidebar });
  } else if (isTyping(e.target)) {
    return; // da qui in poi: scorciatoie che non devono interferire con la scrittura
  } else if (mod && key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
    e.preventDefault();
    redo();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selected) {
    e.preventDefault();
    checkpoint();
    removeAnnot(s.selected.pageId, s.selected.id);
  } else if (e.key === 'Escape') {
    if (s.selected) setState({ selected: null });
    else if (s.tool !== 'select') setState({ tool: 'select' });
    else if (s.searchOpen) setState({ searchOpen: false });
  }
}

function onPaste(e: ClipboardEvent): void {
  if (isTyping(e.target) || getState().pages.length === 0) return;
  const images = Array.from(e.clipboardData?.files ?? []).filter(isImage);
  if (images.length > 0) {
    e.preventDefault();
    void handleFiles(images);
  }
}

function Welcome() {
  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-200 p-6 dark:bg-zinc-800">
      <div className="max-w-md rounded-xl border-2 border-dashed border-zinc-400 px-10 py-12 text-center text-zinc-600 dark:border-zinc-500 dark:text-zinc-300">
        <h1 className="mb-2 text-xl font-semibold text-zinc-800 dark:text-zinc-100">PDF Tool</h1>
        <p className="mb-5">
          Trascina qui un PDF per aprirlo. Tutto avviene nel tuo browser: nessun file viene caricato
          su un server.
        </p>
        <button
          type="button"
          data-testid="welcome-open"
          className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
          onClick={() => void pickFiles(PDF_ACCEPT, false).then((f) => handleFiles(f))}
        >
          Apri un PDF
        </button>
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2" role="status">
      {toasts.map((t) => (
        <div
          key={t.id}
          data-testid={`toast-${t.kind}`}
          className={`max-w-sm rounded px-3 py-2 text-white shadow-lg ${
            t.kind === 'error' ? 'bg-red-600' : 'bg-zinc-800 dark:bg-zinc-600'
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const hasDoc = useStore((s) => s.pages.length > 0);
  const sidebar = useStore((s) => s.sidebar);
  const searchOpen = useStore((s) => s.searchOpen);
  const busy = useStore((s) => s.busy);
  const fileName = useStore((s) => s.fileName);
  const dirty = useStore((s) => s.dirty);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    document.title = fileName ? `${dirty ? '• ' : ''}${fileName} — PDF Tool` : 'PDF Tool';
  }, [fileName, dirty]);

  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent): void => {
      if (getState().dirty) e.preventDefault();
    };
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files');
    const dragOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const dragLeave = (e: DragEvent): void => {
      if (!e.relatedTarget) setDragging(false);
    };
    const drop = (e: DragEvent): void => {
      setDragging(false);
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      void handleFiles(Array.from(e.dataTransfer?.files ?? []));
    };
    // In fase di cattura: l'indicatore si spegne anche se il rilascio viene
    // gestito (e fermato) da viewer o miniature.
    const dropCapture = (): void => setDragging(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('paste', onPaste);
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('dragover', dragOver);
    window.addEventListener('dragleave', dragLeave);
    window.addEventListener('drop', drop);
    window.addEventListener('drop', dropCapture, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('dragover', dragOver);
      window.removeEventListener('dragleave', dragLeave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('drop', dropCapture, true);
    };
  }, []);

  return (
    <div className="flex h-full flex-col text-zinc-900 dark:text-zinc-100">
      <Toolbar />
      <div className="relative flex min-h-0 flex-1">
        {hasDoc ? (
          <>
            {sidebar && <Thumbnails />}
            <Viewer />
            {searchOpen && <SearchBar />}
          </>
        ) : (
          <Welcome />
        )}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-30 border-4 border-dashed border-blue-500 bg-blue-500/10" />
        )}
      </div>
      {busy && (
        <div
          data-testid="busy"
          className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded bg-zinc-800 px-4 py-2 text-white shadow-lg"
        >
          {busy}
        </div>
      )}
      <Toasts />
    </div>
  );
}
