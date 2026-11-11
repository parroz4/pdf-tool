// Store minimale (nessuna dipendenza): stato immutabile + useSyncExternalStore.
import { useSyncExternalStore } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export interface Source {
  id: string;
  name: string;
  /** File originale: riletto solo all'esportazione (nessuna copia in RAM). */
  file: Blob;
  pdf: PDFDocumentProxy;
  numPages: number;
  hasForm: boolean;
}

/** Una pagina del documento corrente: rimanda a una pagina di una sorgente. */
export interface PageRef {
  id: string;
  srcId: string;
  /** Indice 0-based nella sorgente. */
  index: number;
  /** Dimensioni in punti PDF, rotazione inclusa (viewport a scala 1). */
  w: number;
  h: number;
}

// Tutte le coordinate delle annotazioni sono in punti, origine in alto a
// sinistra della pagina così come viene mostrata.
export interface ImageAnnot {
  id: string;
  type: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  assetId: string;
}
export interface TextAnnot {
  id: string;
  type: 'text';
  x: number;
  y: number;
  text: string;
  size: number;
  color: string;
}
export interface InkAnnot {
  id: string;
  type: 'ink';
  /** x0,y0,x1,y1,… */
  points: number[];
  color: string;
  width: number;
}
export interface RectAnnot {
  id: string;
  type: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  width: number;
}
export interface HighlightAnnot {
  id: string;
  type: 'highlight';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}
export type Annot = ImageAnnot | TextAnnot | InkAnnot | RectAnnot | HighlightAnnot;
export type BoxAnnot = ImageAnnot | RectAnnot | HighlightAnnot;

export interface Asset {
  id: string;
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
  url: string;
  w: number;
  h: number;
}

export type FormValue = string | string[];
export type Tool = 'select' | 'text' | 'draw' | 'highlight' | 'rect';
export type ZoomMode = 'fit-width' | 'fit-page' | 'custom';

export interface SearchHit {
  /** Posizione globale nell'elenco dei risultati. */
  n: number;
  rects: [number, number, number, number][];
}

/** La parte dello stato coperta da annulla/ripristina. */
export interface DocState {
  pages: PageRef[];
  annots: Record<string, Annot[]>;
  forms: Record<string, Record<string, FormValue>>;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

export interface State extends DocState {
  sources: Record<string, Source>;
  assets: Record<string, Asset>;
  fileName: string;
  dirty: boolean;
  undo: DocState[];
  redo: DocState[];

  tool: Tool;
  /** Diventa true al primo uso di uno strumento: fa caricare il chunk editor. */
  editorOn: boolean;
  style: { color: string; hlColor: string; width: number; size: number };
  selected: { pageId: string; id: string } | null;
  editingText: string | null;
  pageSel: string[];

  zoomMode: ZoomMode;
  zoom: number;
  /** Scala effettiva in px CSS per punto, calcolata dal viewer. */
  scale: number;
  currentPage: number;
  sidebar: boolean;

  searchOpen: boolean;
  search: {
    query: string;
    running: boolean;
    total: number;
    active: number;
    order: { pageId: string; y: number }[];
    byPage: Record<string, SearchHit[]>;
  };

  busy: string | null;
  toasts: Toast[];
}

export const EMPTY_SEARCH: State['search'] = {
  query: '',
  running: false,
  total: 0,
  active: -1,
  order: [],
  byPage: {},
};

const initial: State = {
  pages: [],
  annots: {},
  forms: {},
  sources: {},
  assets: {},
  fileName: '',
  dirty: false,
  undo: [],
  redo: [],
  tool: 'select',
  editorOn: false,
  style: { color: '#dc2626', hlColor: '#fde047', width: 2, size: 14 },
  selected: null,
  editingText: null,
  pageSel: [],
  zoomMode: 'fit-width',
  zoom: 1,
  scale: 1,
  currentPage: 0,
  sidebar: true,
  searchOpen: false,
  search: EMPTY_SEARCH,
  busy: null,
  toasts: [],
};

let state: State = initial;
const listeners = new Set<() => void>();

export const getState = (): State => state;

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

let uidCounter = 0;
export const uid = (prefix: string): string => `${prefix}${++uidCounter}`;

// ---------------------------------------------------------------- cronologia

const HISTORY_LIMIT = 100;
const snapshot = (s: State): DocState => ({ pages: s.pages, annots: s.annots, forms: s.forms });

/** Da chiamare PRIMA di una modifica: salva lo stato per l'annulla. */
export function checkpoint(): void {
  setState((s) => ({
    undo: [...s.undo.slice(-HISTORY_LIMIT + 1), snapshot(s)],
    redo: [],
    dirty: true,
  }));
}

export function undo(): void {
  const s = state;
  const prev = s.undo[s.undo.length - 1];
  if (!prev) return;
  setState({
    ...prev,
    undo: s.undo.slice(0, -1),
    redo: [...s.redo, snapshot(s)],
    selected: null,
    editingText: null,
    pageSel: [],
    dirty: true,
  });
}

export function redo(): void {
  const s = state;
  const next = s.redo[s.redo.length - 1];
  if (!next) return;
  setState({
    ...next,
    redo: s.redo.slice(0, -1),
    undo: [...s.undo, snapshot(s)],
    selected: null,
    editingText: null,
    pageSel: [],
    dirty: true,
  });
}

// ------------------------------------------------------------------- avvisi

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  setTimeout(
    () => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    kind === 'error' ? 8000 : 4000,
  );
}

// -------------------------------------------------------------- annotazioni

export function addAnnot(pageId: string, annot: Annot): void {
  setState((s) => ({
    annots: { ...s.annots, [pageId]: [...(s.annots[pageId] ?? []), annot] },
  }));
}

export function updateAnnot(pageId: string, id: string, patch: Partial<Annot>): void {
  setState((s) => ({
    annots: {
      ...s.annots,
      [pageId]: (s.annots[pageId] ?? []).map((a) =>
        a.id === id ? ({ ...a, ...patch } as Annot) : a,
      ),
    },
  }));
}

export function removeAnnot(pageId: string, id: string): void {
  setState((s) => ({
    annots: { ...s.annots, [pageId]: (s.annots[pageId] ?? []).filter((a) => a.id !== id) },
    selected: s.selected?.id === id ? null : s.selected,
    editingText: s.editingText === id ? null : s.editingText,
  }));
}

export function findAnnot(sel: State['selected']): Annot | undefined {
  if (!sel) return undefined;
  return state.annots[sel.pageId]?.find((a) => a.id === sel.id);
}

export function setTool(tool: Tool): void {
  setState({ tool, editorOn: true, selected: null, editingText: null });
}

// ------------------------------------------------------------------- pagine

export function deletePages(ids: string[]): void {
  const s = state;
  const set = new Set(ids);
  const pages = s.pages.filter((p) => !set.has(p.id));
  if (pages.length === s.pages.length) return;
  if (pages.length === 0) {
    toast('Il documento deve contenere almeno una pagina.', 'error');
    return;
  }
  checkpoint();
  setState({ pages, pageSel: [], selected: null });
}

/** Sposta le pagine `ids` (mantenendone l'ordine relativo) prima dell'indice `to`. */
export function movePages(ids: string[], to: number): void {
  const s = state;
  const set = new Set(ids);
  const moving = s.pages.filter((p) => set.has(p.id));
  if (moving.length === 0) return;
  const before = s.pages.slice(0, to).filter((p) => !set.has(p.id));
  const after = s.pages.slice(to).filter((p) => !set.has(p.id));
  const pages = [...before, ...moving, ...after];
  if (pages.every((p, i) => p === s.pages[i])) return;
  checkpoint();
  setState({ pages });
}

export function setFormValue(srcId: string, name: string, value: FormValue): void {
  setState((s) => ({
    forms: { ...s.forms, [srcId]: { ...s.forms[srcId], [name]: value } },
  }));
}

export function resetAll(patch: Partial<State>): void {
  setState({
    ...initial,
    // preferenze dell'utente che sopravvivono all'apertura di un altro file
    sidebar: state.sidebar,
    style: state.style,
    toasts: state.toasts,
    ...patch,
  });
}
