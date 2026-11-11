// OCR delle pagine scansionate (chunk lazy): Tesseract gira in un worker del
// browser, con motore e dati della lingua serviti da public/tesseract/. Il
// risultato finisce nello store (`ocr`) e alimenta selezione, ricerca e
// modifica del testo con doppio clic.
import type { Worker } from 'tesseract.js';
import { getPage } from '../pdf/pdfjs';
import { getState, setState, type OcrRun, type PageRef, type Source } from '../state/store';
import { pdfTextRuns } from './editText';

/** Risoluzione di riconoscimento e tetto di pixel per pagina. */
const DPI = 300;
const MAX_PX = 12e6;
const MIN_CONFIDENCE = 30;

let progress: (fraction: number, status: string) => void = () => {};
let workerP: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  workerP ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    const base = new URL('tesseract/', document.baseURI).href;
    return createWorker('ita', 1, {
      workerPath: `${base}worker.min.js`,
      corePath: base.replace(/\/$/, ''),
      langPath: base.replace(/\/$/, ''),
      gzip: true,
      logger: (m: { status: string; progress: number }) => progress(m.progress, m.status),
    });
  })();
  workerP.catch(() => {
    workerP = null; // al prossimo tentativo si riparte da capo
  });
  return workerP;
}

async function pageImage(src: Source, index: number): Promise<{ blob: Blob; k: number }> {
  const page = await getPage(src, index);
  const base = page.getViewport({ scale: 1 });
  let k = DPI / 72;
  const px = base.width * base.height * k * k;
  if (px > MAX_PX) k *= Math.sqrt(MAX_PX / px);
  const viewport = page.getViewport({ scale: k });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  // intent "print": il rendering non dipende da requestAnimationFrame, quindi
  // l'OCR prosegue anche con la scheda in secondo piano.
  await page.render({ canvas, viewport, intent: 'print' }).promise;
  // Copia su un canvas 2D ordinario: quello di pdf.js può essere fuori schermo.
  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height;
  const ctx = flat.getContext('2d');
  if (!ctx) throw new Error('canvas 2D non disponibile');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(canvas, 0, 0);
  const blob = await new Promise<Blob | null>((res) => flat.toBlob(res, 'image/png'));
  canvas.width = 0;
  flat.width = 0;
  if (!blob) throw new Error('immagine della pagina non creata');
  return { blob, k };
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface OcrWord {
  text: string;
  confidence: number;
  bbox: Box;
}
interface OcrLine {
  words: OcrWord[];
  bbox: Box;
  baseline?: Box;
}

/** Spezza le righe in tratti: parole separate da molto spazio (colonne di una
 *  tabella, campi di un modulo) diventano caselle distinte. */
function toRuns(lines: OcrLine[], k: number): OcrRun[] {
  const runs: OcrRun[] = [];
  for (const line of lines) {
    const lineH = line.bbox.y1 - line.bbox.y0;
    const words = line.words.filter(
      (w) => w.text.trim() !== '' && w.confidence >= MIN_CONFIDENCE && w.bbox.x1 > w.bbox.x0,
    );
    let group: OcrWord[] = [];
    const flush = (): void => {
      if (group.length === 0) return;
      const x0 = group[0].bbox.x0;
      const x1 = group[group.length - 1].bbox.x1;
      const y0 = Math.min(...group.map((w) => w.bbox.y0));
      const y1 = Math.max(...group.map((w) => w.bbox.y1));
      const b = line.baseline;
      let base = y1;
      if (b && b.x1 > b.x0) {
        const xm = (x0 + x1) / 2;
        base = b.y0 + ((b.y1 - b.y0) * (xm - b.x0)) / (b.x1 - b.x0);
      }
      base = Math.min(y1, Math.max(y0 + (y1 - y0) * 0.5, base));
      runs.push({
        text: group.map((w) => w.text).join(' '),
        x: x0 / k,
        y: y0 / k,
        w: (x1 - x0) / k,
        h: (y1 - y0) / k,
        base: base / k,
      });
      group = [];
    };
    for (const w of words) {
      const prev = group[group.length - 1];
      if (prev && w.bbox.x0 - prev.bbox.x1 > lineH * 1.2) flush();
      group.push(w);
    }
    flush();
  }
  return runs;
}

const overlaps = (a: OcrRun, b: { x: number; y: number; w: number; h: number }): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

async function recognizePage(src: Source, index: number): Promise<OcrRun[]> {
  const { blob, k } = await pageImage(src, index);
  const worker = await getWorker();
  const { data } = await worker.recognize(blob, {}, { blocks: true, text: false });
  const lines: OcrLine[] = [];
  for (const block of data.blocks ?? []) {
    for (const par of block.paragraphs) lines.push(...(par.lines as unknown as OcrLine[]));
  }
  // Dove la pagina ha già testo vero, quello dell'OCR sarebbe un doppione.
  const real = await pdfTextRuns(src, index);
  return toRuns(lines, k).filter((r) => !real.some((t) => overlaps(r, t.box)));
}

export const ocrKey = (page: PageRef): string => `${page.srcId}:${page.index}`;

/**
 * Riconosce il testo delle pagine indicate (quelle già fatte vengono saltate).
 * Restituisce il numero di tratti di testo trovati.
 */
export async function ocrPages(
  pages: PageRef[],
  onProgress: (message: string) => void,
): Promise<number> {
  const todo = pages.filter((p) => !getState().ocr[ocrKey(p)]);
  let found = 0;
  for (let i = 0; i < todo.length; i++) {
    const page = todo[i];
    const src = getState().sources[page.srcId];
    if (!src) continue;
    const label = todo.length > 1 ? `OCR pagina ${i + 1} di ${todo.length}` : 'OCR';
    onProgress(`${label}: preparazione…`);
    progress = (fraction, status) =>
      onProgress(
        status === 'recognizing text'
          ? `${label}: riconoscimento ${Math.round(fraction * 100)}%`
          : `${label}: caricamento del motore…`,
      );
    const runs = await recognizePage(src, page.index);
    found += runs.length;
    setState((s) => ({ ocr: { ...s.ocr, [ocrKey(page)]: runs } }));
  }
  progress = () => {};
  return found;
}
