// Azioni di alto livello sul documento: apri, unisci, esporta, inserisci immagine.
// Il codice dell'editor (pdf-lib, gestione immagini) è importato in modo
// dinamico: non entra nel bundle iniziale del viewer.
import { dropSourceFromCache, openPdf, PasswordCancelled } from '../pdf/pdfjs';
import { viewerApi } from '../viewer/api';
import { cancelSearch } from '../viewer/search';
import {
  checkpoint,
  getState,
  resetAll,
  setState,
  toast,
  uid,
  type PageRef,
  type Source,
} from './store';

const isPdf = (f: File): boolean =>
  f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
export const isImage = (f: File): boolean =>
  f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name);

async function loadSource(file: File): Promise<{ source: Source; pages: PageRef[] }> {
  const pdf = await openPdf(file);
  const id = uid('s');
  // Per aprire subito anche documenti enormi si legge solo la prima pagina:
  // le dimensioni delle altre vengono corrette in background.
  const first = await pdf.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  let hasForm = false;
  try {
    hasForm = !!(await pdf.getFieldObjects());
  } catch {
    hasForm = false;
  }
  const source: Source = { id, name: file.name, file, pdf, numPages: pdf.numPages, hasForm };
  const pages: PageRef[] = Array.from({ length: pdf.numPages }, (_, index) => ({
    id: uid('p'),
    srcId: id,
    index,
    w: vp.width,
    h: vp.height,
  }));
  return { source, pages };
}

async function refineSizes(source: Source, pages: PageRef[]): Promise<void> {
  let patch = new Map<string, { w: number; h: number }>();
  const flush = (): void => {
    if (patch.size === 0) return;
    const p = patch;
    patch = new Map();
    const fix = (list: PageRef[]): PageRef[] =>
      list.map((pg) => {
        const d = p.get(pg.id);
        return d ? { ...pg, ...d } : pg;
      });
    // Le dimensioni non fanno parte della cronologia: si correggono ovunque.
    setState((s) => ({
      pages: fix(s.pages),
      undo: s.undo.map((u) => ({ ...u, pages: fix(u.pages) })),
      redo: s.redo.map((u) => ({ ...u, pages: fix(u.pages) })),
    }));
  };
  for (let i = 1; i < pages.length; i++) {
    if (!getState().sources[source.id]) return; // documento chiuso nel frattempo
    try {
      const page = await source.pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      const ref = pages[i];
      if (Math.abs(vp.width - ref.w) > 0.01 || Math.abs(vp.height - ref.h) > 0.01) {
        patch.set(ref.id, { w: vp.width, h: vp.height });
      }
    } catch {
      /* pagina illeggibile: resta la stima */
    }
    if (i % 200 === 0) flush();
  }
  flush();
}

function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg || 'errore sconosciuto';
}

export async function openFile(file: File): Promise<void> {
  const prev = getState();
  if (prev.dirty && !window.confirm('Ci sono modifiche non esportate. Aprire comunque un altro file?')) {
    return;
  }
  setState({ busy: 'Apertura…' });
  try {
    const { source, pages } = await loadSource(file);
    cancelSearch();
    for (const s of Object.values(prev.sources)) {
      dropSourceFromCache(s.id);
      void s.pdf.loadingTask.destroy();
    }
    for (const a of Object.values(prev.assets)) URL.revokeObjectURL(a.url);
    resetAll({ sources: { [source.id]: source }, pages, fileName: file.name });
    viewerApi.scrollToPage(0); // un nuovo documento parte sempre dall'inizio
    void refineSizes(source, pages);
  } catch (e) {
    if (!(e instanceof PasswordCancelled)) {
      toast(`Impossibile aprire «${file.name}»: ${describeError(e)}`, 'error');
    }
  } finally {
    setState({ busy: null });
  }
}

/** Inserisce le pagine di altri PDF prima dell'indice `at` (default: in fondo). */
export async function mergeFiles(files: File[], at?: number): Promise<void> {
  const pdfs = files.filter(isPdf);
  if (pdfs.length === 0) return;
  if (getState().pages.length === 0) {
    await openFile(pdfs[0]);
    if (getState().pages.length === 0) return;
    pdfs.shift();
    if (pdfs.length === 0) return;
  }
  setState({ busy: 'Unione…' });
  try {
    const loaded: { source: Source; pages: PageRef[] }[] = [];
    for (const f of pdfs) {
      try {
        loaded.push(await loadSource(f));
      } catch (e) {
        if (!(e instanceof PasswordCancelled)) {
          toast(`Impossibile unire «${f.name}»: ${describeError(e)}`, 'error');
        }
      }
    }
    if (loaded.length === 0) return;
    checkpoint();
    setState((s) => {
      const pos = at === undefined ? s.pages.length : Math.max(0, Math.min(at, s.pages.length));
      const added = loaded.flatMap((l) => l.pages);
      const sources = { ...s.sources };
      for (const l of loaded) sources[l.source.id] = l.source;
      return {
        sources,
        pages: [...s.pages.slice(0, pos), ...added, ...s.pages.slice(pos)],
        pageSel: added.map((p) => p.id),
      };
    });
    for (const l of loaded) void refineSizes(l.source, l.pages);
    const n = loaded.reduce((a, l) => a + l.pages.length, 0);
    toast(`${n} ${n === 1 ? 'pagina aggiunta' : 'pagine aggiunte'}.`);
  } finally {
    setState({ busy: null });
  }
}

/** Smista i file trascinati o scelti: PDF → apri/unisci, immagini → inserisci. */
export async function handleFiles(
  files: File[],
  opts: { merge?: boolean; at?: number; pageId?: string; x?: number; y?: number } = {},
): Promise<void> {
  const pdfs = files.filter(isPdf);
  const images = files.filter((f) => !isPdf(f) && isImage(f));
  if (pdfs.length > 0) {
    if (opts.merge || getState().pages.length === 0) await mergeFiles(pdfs, opts.at);
    else {
      await openFile(pdfs[0]);
      if (pdfs.length > 1) await mergeFiles(pdfs.slice(1));
    }
  }
  if (images.length > 0) {
    if (getState().pages.length === 0) {
      toast('Apri prima un PDF, poi trascina l’immagine sulla pagina.', 'error');
      return;
    }
    const { insertImage } = await import('../editor/images');
    let i = 0;
    for (const f of images) {
      try {
        await insertImage(f, opts.pageId, opts.x, opts.y, i++ * 12);
      } catch (e) {
        toast(`Immagine non leggibile «${f.name}»: ${describeError(e)}`, 'error');
      }
    }
  }
  if (pdfs.length === 0 && images.length === 0 && files.length > 0) {
    toast('Formato non supportato: servono PDF o immagini.', 'error');
  }
}

export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.dataset.testid = 'file-input';
    document.body.appendChild(input);
    const done = (): void => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    };
    input.addEventListener('change', done);
    input.addEventListener('cancel', done);
    input.click();
  });
}

export const PDF_ACCEPT = 'application/pdf,.pdf';
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml';

export async function exportPdf(): Promise<void> {
  const s = getState();
  if (s.pages.length === 0 || s.busy) return;
  // Conferma un'eventuale casella di testo ancora in modifica.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  setState({ busy: 'Esportazione…' });
  try {
    const { buildPdf } = await import('../editor/export');
    const { bytes, warnings } = await buildPdf(getState());
    const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = s.fileName.replace(/\.pdf$/i, '') + '-modificato.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setState({ dirty: false });
    for (const w of warnings) toast(w, 'error');
    toast('PDF esportato.');
  } catch (e) {
    toast(`Esportazione non riuscita: ${describeError(e)}`, 'error');
  } finally {
    setState({ busy: null });
  }
}
