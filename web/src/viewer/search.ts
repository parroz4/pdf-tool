// Ricerca testo: estrae il testo pagina per pagina (con cache), in modo
// incrementale e annullabile, e calcola i rettangoli da evidenziare.
import { getPage } from '../pdf/pdfjs';
import { EMPTY_SEARCH, getState, setState, type SearchHit, type Source } from '../state/store';
import { viewerApi } from './api';

interface TextRun {
  start: number;
  str: string;
  /** Matrice del testo nello spazio PDF. */
  tx: number[];
  width: number;
  height: number;
}
interface PageText {
  text: string;
  runs: TextRun[];
  /** Trasformazione PDF → viewport a scala 1. */
  vt: number[];
}

const textCache = new Map<string, Promise<PageText>>();

function loadPageText(src: Source, index: number): Promise<PageText> {
  const k = `${src.id}:${index}`;
  let p = textCache.get(k);
  if (!p) {
    p = (async () => {
      const page = await getPage(src, index);
      const content = await page.getTextContent();
      const runs: TextRun[] = [];
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        if (item.str) {
          runs.push({
            start: text.length,
            str: item.str,
            tx: item.transform as number[],
            width: item.width,
            height: item.height,
          });
          text += item.str;
        }
        if (item.hasEOL) text += ' ';
      }
      return { text: text.toLowerCase(), runs, vt: page.getViewport({ scale: 1 }).transform };
    })();
    textCache.set(k, p);
    if (textCache.size > 3000) {
      const oldest = textCache.keys().next().value;
      if (oldest !== undefined) textCache.delete(oldest);
    }
  }
  return p;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function fraction(str: string, n: number): number {
  if (n <= 0) return 0;
  if (n >= str.length) return 1;
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return n / str.length;
  measureCtx.font = '20px sans-serif';
  const total = measureCtx.measureText(str).width;
  return total > 0 ? measureCtx.measureText(str.slice(0, n)).width / total : n / str.length;
}

function runRect(run: TextRun, from: number, to: number, vt: number[]): [number, number, number, number] {
  const [a, b, c, d, e, f] = run.tx;
  const ul = Math.hypot(a, b) || 1;
  const nl = Math.hypot(c, d) || 1;
  const ux = a / ul;
  const uy = b / ul;
  const nx = c / nl;
  const ny = d / nl;
  const h = run.height || nl;
  const s0 = run.width * fraction(run.str, from);
  const s1 = run.width * fraction(run.str, to);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of [s0, s1]) {
    for (const t of [-0.22 * h, 0.88 * h]) {
      const px = e + ux * s + nx * t;
      const py = f + uy * s + ny * t;
      const vx = vt[0] * px + vt[2] * py + vt[4];
      const vy = vt[1] * px + vt[3] * py + vt[5];
      x0 = Math.min(x0, vx);
      y0 = Math.min(y0, vy);
      x1 = Math.max(x1, vx);
      y1 = Math.max(y1, vy);
    }
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

function findInPage(pt: PageText, query: string): [number, number, number, number][][] {
  const out: [number, number, number, number][][] = [];
  let pos = pt.text.indexOf(query);
  let ri = 0;
  while (pos !== -1) {
    const end = pos + query.length;
    const rects: [number, number, number, number][] = [];
    while (ri > 0 && pt.runs[ri].start > pos) ri--;
    while (ri < pt.runs.length - 1 && pt.runs[ri].start + pt.runs[ri].str.length <= pos) ri++;
    for (let i = ri; i < pt.runs.length && pt.runs[i].start < end; i++) {
      const r = pt.runs[i];
      const from = Math.max(0, pos - r.start);
      const to = Math.min(r.str.length, end - r.start);
      if (to > from) rects.push(runRect(r, from, to, pt.vt));
    }
    if (rects.length > 0) out.push(rects);
    pos = pt.text.indexOf(query, pos + Math.max(1, query.length));
  }
  return out;
}

let generation = 0;

export function cancelSearch(): void {
  generation++;
  textCache.clear();
}

export async function runSearch(rawQuery: string): Promise<void> {
  const gen = ++generation;
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    setState({ search: EMPTY_SEARCH });
    return;
  }
  setState({ search: { ...EMPTY_SEARCH, query: rawQuery, running: true } });
  const { pages, sources } = getState();
  let order: { pageId: string; y: number }[] = [];
  let byPage: Record<string, SearchHit[]> = {};
  let dirty = false;
  let lastFlush = performance.now();
  let jumped = false;
  const flush = (running: boolean): void => {
    setState((s) => ({
      search: {
        ...s.search,
        running,
        total: order.length,
        order,
        byPage,
        active: s.search.active < 0 && order.length > 0 ? 0 : s.search.active,
      },
    }));
    dirty = false;
    lastFlush = performance.now();
    if (!jumped && order.length > 0) {
      jumped = true;
      viewerApi.scrollToMatch(order[0].pageId, order[0].y);
    }
  };
  for (const page of pages) {
    if (gen !== generation) return;
    const src = sources[page.srcId];
    if (!src) continue;
    let found: [number, number, number, number][][] = [];
    try {
      found = findInPage(await loadPageText(src, page.index), query);
    } catch {
      /* pagina senza testo estraibile */
    }
    if (gen !== generation) return;
    if (found.length > 0) {
      const hits = found.map((rects, i) => ({ n: order.length + i, rects }));
      byPage = { ...byPage, [page.id]: hits };
      order = [...order, ...found.map((rects) => ({ pageId: page.id, y: rects[0][1] }))];
      dirty = true;
    }
    if (dirty && performance.now() - lastFlush > 150) flush(true);
  }
  flush(false);
}

export function stepSearch(delta: number): void {
  const { search } = getState();
  if (search.total === 0) return;
  const active = (search.active + delta + search.total) % search.total;
  setState({ search: { ...search, active } });
  const m = search.order[active];
  viewerApi.scrollToMatch(m.pageId, m.y);
}
