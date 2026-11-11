// Modifica del testo già presente nella pagina (chunk lazy): un doppio clic su
// una riga di testo la trasforma in una casella modificabile. Vale sia per il
// testo vero del PDF sia per quello riconosciuto dall'OCR. L'originale non
// viene tolto dal contenuto del PDF: è coperto da un rettangolo del colore di
// fondo e la casella ci viene disegnata sopra, anche nel file esportato.
import { Util } from 'pdfjs-dist';
import { getCached, getPage } from '../pdf/pdfjs';
import {
  addAnnot,
  checkpoint,
  getState,
  setState,
  toast,
  uid,
  type PageRef,
  type Source,
  type TextAnnot,
} from '../state/store';

/** Come in export.ts: distanza della linea di base dal bordo alto, in em. */
const BASELINE = 0.9465;
/** Altezza delle maiuscole di Helvetica, in em. */
const CAP_HEIGHT = 0.72;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Run {
  text: string;
  /** Inizio della linea di base, in punti pagina (origine in alto a sinistra). */
  x: number;
  base: number;
  size: number;
  angle: number;
  /** Area occupata dal testo: serve per il clic e per coprire l'originale. */
  box: Box;
}

/** Il testo vero della pagina (non quello dell'OCR). */
export async function pdfTextRuns(src: Source, index: number): Promise<Run[]> {
  const page = await getPage(src, index);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const runs: Run[] = [];
  for (const item of content.items) {
    if (!('str' in item) || item.str.trim() === '') continue;
    const m = Util.transform(viewport.transform, item.transform) as number[];
    const size = Math.hypot(m[2], m[3]);
    if (!(size > 0)) continue;
    runs.push({
      text: item.str,
      x: m[4],
      base: m[5],
      size,
      angle: Math.atan2(m[1], m[0]),
      // fino ai discendenti e non oltre: sotto c'è spesso la riga di un modulo
      box: { x: m[4] - 1, y: m[5] - size * 0.9, w: item.width + 2, h: size * 1.12 },
    });
  }
  return runs;
}

function ocrTextRuns(page: PageRef): Run[] {
  const runs = getState().ocr[`${page.srcId}:${page.index}`] ?? [];
  return runs.map((r) => ({
    text: r.text,
    x: r.x,
    base: r.base,
    // l'altezza sopra la linea di base è quella di maiuscole e ascendenti
    size: Math.max(4, (r.base - r.y) / CAP_HEIGHT),
    angle: 0,
    box: { x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 },
  }));
}

/** Colore di fondo attorno al riquadro: mediana dei pixel lungo il bordo. */
function backgroundAt(src: Source, page: PageRef, box: Box): string {
  try {
    const cached = getCached(src, page.index);
    if (!cached) return '#ffffff';
    const k = cached.canvas.width / page.w;
    const pad = 2;
    const x0 = Math.max(0, Math.floor((box.x - pad) * k));
    const y0 = Math.max(0, Math.floor((box.y - pad) * k));
    const x1 = Math.min(cached.canvas.width, Math.ceil((box.x + box.w + pad) * k));
    const y1 = Math.min(cached.canvas.height, Math.ceil((box.y + box.h + pad) * k));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 2 || h < 2) return '#ffffff';
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext('2d', { willReadFrequently: true });
    if (!ctx) return '#ffffff';
    ctx.drawImage(cached.canvas, x0, y0, w, h, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const ch: number[][] = [[], [], []];
    const take = (x: number, y: number): void => {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) ch[c].push(px[i + c]);
    };
    for (let x = 0; x < w; x++) {
      take(x, 0);
      take(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      take(0, y);
      take(w - 1, y);
    }
    const med = ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
    return `#${med.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return '#ffffff';
  }
}

const inside = (b: Box, x: number, y: number): boolean =>
  x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

/**
 * Doppio clic nel punto (x, y) della pagina, in punti. Se lì c'è del testo
 * stampato lo trasforma in una casella modificabile e restituisce true.
 */
export async function editTextAt(page: PageRef, src: Source, x: number, y: number): Promise<boolean> {
  // Testo già trasformato in casella: si riapre quella.
  const existing = (getState().annots[page.id] ?? []).find(
    (a) => a.type === 'text' && a.cover && inside(a.cover, x, y),
  );
  if (existing) {
    setState({
      editorOn: true,
      tool: 'select',
      selected: { pageId: page.id, id: existing.id },
      editingText: existing.id,
    });
    return true;
  }

  const runs = [...(await pdfTextRuns(src, page.index)), ...ocrTextRuns(page)];
  const hit = runs.find((r) => inside(r.box, x, y));
  if (!hit) return false;
  if (Math.abs(hit.angle) > 0.02) {
    toast('Il testo ruotato non si può ancora modificare direttamente.');
    return false;
  }

  const a: TextAnnot = {
    id: uid('n'),
    type: 'text',
    x: hit.x,
    y: hit.base - hit.size * BASELINE,
    text: hit.text,
    size: Math.round(hit.size * 10) / 10,
    color: '#000000',
    cover: { ...hit.box, color: backgroundAt(src, page, hit.box) },
  };
  window.getSelection()?.removeAllRanges();
  checkpoint();
  addAnnot(page.id, a);
  setState({
    editorOn: true,
    tool: 'select',
    selected: { pageId: page.id, id: a.id },
    editingText: a.id,
  });
  return true;
}
