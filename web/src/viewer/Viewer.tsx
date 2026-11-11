// Vista a scorrimento continuo virtualizzata: nel DOM esistono solo le pagine
// visibili (più una di margine sopra e sotto), posizionate in modo assoluto
// dentro un contenitore alto quanto l'intero documento.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { handleFiles } from '../state/actions';
import { getState, setState, useStore, type PageRef } from '../state/store';
import { MAX_SCALE, MIN_SCALE, PT_TO_PX, viewerApi } from './api';
import { PageView } from './PageView';

const GAP = 10;
const PAD = 12;
const OVERSCAN = 1;

interface Layout {
  pages: PageRef[];
  scale: number;
  tops: Float64Array;
  total: number;
  width: number;
}

interface Anchor {
  idx: number;
  /** Frazione dell'altezza della pagina `idx`… */
  frac: number;
  /** …che deve trovarsi a questa distanza dal bordo alto della vista. */
  vy: number;
  vx: number;
}

/** Ultimo indice con tops[i] <= y (0 se nessuno). */
function pageAt(tops: Float64Array, y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export default function Viewer() {
  const pages = useStore((s) => s.pages);
  const zoomMode = useStore((s) => s.zoomMode);
  const zoom = useStore((s) => s.zoom);
  const tool = useStore((s) => s.tool);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [range, setRange] = useState<[number, number]>([0, 0]);

  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = (): void => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [maxW, maxH] = useMemo(() => {
    let w = 1;
    let h = 1;
    for (const p of pages) {
      if (p.w > w) w = p.w;
      if (p.h > h) h = p.h;
    }
    return [w, h];
  }, [pages]);

  const scale = useMemo(() => {
    if (zoomMode === 'custom' || box.w === 0) return clampScale(zoom * PT_TO_PX);
    const fitW = (box.w - 2 * PAD) / maxW;
    if (zoomMode === 'fit-width') return clampScale(fitW);
    return clampScale(Math.min(fitW, (box.h - 2 * PAD) / maxH));
  }, [zoomMode, zoom, box, maxW, maxH]);

  const layout = useMemo<Layout>(() => {
    const tops = new Float64Array(pages.length);
    let y = PAD;
    for (let i = 0; i < pages.length; i++) {
      tops[i] = y;
      y += pages[i].h * scale + GAP;
    }
    return { pages, scale, tops, total: y - GAP + PAD, width: maxW * scale + 2 * PAD };
  }, [pages, scale, maxW]);

  const layoutRef = useRef(layout);
  const prevWidth = useRef(layout.width);
  const anchor = useRef<Anchor | null>(null);

  /** Ricalcola l'intervallo di pagine visibili e l'ancora di scorrimento. */
  const update = useCallback((trackAnchor: boolean) => {
    const el = ref.current;
    const l = layoutRef.current;
    if (!el || l.pages.length === 0) return;
    const top = el.scrollTop;
    const first = pageAt(l.tops, top);
    const last = pageAt(l.tops, top + el.clientHeight);
    const a = Math.max(0, first - OVERSCAN);
    const b = Math.min(l.pages.length - 1, last + OVERSCAN);
    setRange((r) => (r[0] === a && r[1] === b ? r : [a, b]));
    if (trackAnchor) {
      anchor.current = {
        idx: first,
        frac: (top - l.tops[first]) / (l.pages[first].h * l.scale),
        vy: 0,
        vx: el.clientWidth / 2,
      };
    }
    const current = pageAt(l.tops, top + el.clientHeight / 3);
    if (getState().currentPage !== current) setState({ currentPage: current });
  }, []);

  const applyAnchor = useCallback(() => {
    const el = ref.current;
    const l = layoutRef.current;
    const a = anchor.current;
    if (!el || !a || l.pages.length === 0) return;
    const i = Math.min(a.idx, l.pages.length - 1);
    el.scrollTop = l.tops[i] + a.frac * l.pages[i].h * l.scale - a.vy;
  }, []);

  // Al cambio di layout (zoom, dimensioni reali delle pagine, riordino) si
  // ripristina la posizione: il punto ancorato resta fermo sullo schermo.
  useLayoutEffect(() => {
    const el = ref.current!;
    layoutRef.current = layout;
    const a = anchor.current;
    if (a && prevWidth.current > 0 && layout.width !== prevWidth.current) {
      el.scrollLeft = ((el.scrollLeft + a.vx) * layout.width) / prevWidth.current - a.vx;
    }
    prevWidth.current = layout.width;
    applyAnchor();
    update(false);
  }, [layout, applyAnchor, update]);

  useEffect(() => {
    if (getState().scale !== scale) setState({ scale });
  }, [scale]);

  useEffect(() => update(false), [box, update]);

  const anchorAt = useCallback((vy: number, vx: number) => {
    const el = ref.current!;
    const l = layoutRef.current;
    if (l.pages.length === 0) return;
    const y = el.scrollTop + vy;
    const idx = pageAt(l.tops, y);
    anchor.current = { idx, frac: (y - l.tops[idx]) / (l.pages[idx].h * l.scale), vy, vx };
  }, []);

  useEffect(() => {
    const el = ref.current!;
    const zoomTo = (factor: number, vy: number, vx: number): void => {
      anchorAt(vy, vx);
      const next = clampScale(layoutRef.current.scale * factor);
      setState({ zoomMode: 'custom', zoom: next / PT_TO_PX });
    };
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-e.deltaY * 0.002)));
      zoomTo(factor, e.clientY - r.top, e.clientX - r.left);
    };
    el.addEventListener('wheel', onWheel, { passive: false });

    viewerApi.zoomBy = (factor) => zoomTo(factor, el.clientHeight / 2, el.clientWidth / 2);
    viewerApi.scrollToPage = (index) => {
      anchor.current = { idx: Math.max(0, index), frac: 0, vy: PAD / 2, vx: el.clientWidth / 2 };
      applyAnchor();
      update(false);
    };
    viewerApi.scrollToMatch = (pageId, y) => {
      const l = layoutRef.current;
      const idx = l.pages.findIndex((p) => p.id === pageId);
      if (idx < 0) return;
      const abs = l.tops[idx] + y * l.scale;
      const rel = abs - el.scrollTop;
      if (rel > el.clientHeight * 0.1 && rel < el.clientHeight * 0.8) return;
      anchor.current = {
        idx,
        frac: y / l.pages[idx].h,
        vy: el.clientHeight / 3,
        vx: el.clientWidth / 2,
      };
      applyAnchor();
      update(false);
    };
    viewerApi.visibleCenter = (pageId) => {
      const l = layoutRef.current;
      const idx = l.pages.findIndex((p) => p.id === pageId);
      if (idx < 0) return null;
      const p = l.pages[idx];
      const top = Math.max(el.scrollTop, l.tops[idx]);
      const bottom = Math.min(el.scrollTop + el.clientHeight, l.tops[idx] + p.h * l.scale);
      const y = bottom > top ? ((top + bottom) / 2 - l.tops[idx]) / l.scale : p.h / 2;
      return { x: p.w / 2, y };
    };
    return () => {
      el.removeEventListener('wheel', onWheel);
      viewerApi.zoomBy = () => {};
      viewerApi.scrollToPage = () => {};
      viewerApi.scrollToMatch = () => {};
      viewerApi.visibleCenter = () => null;
    };
  }, [anchorAt, applyAnchor, update]);

  const onDrop = (e: React.DragEvent): void => {
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const pageEl = (e.target as Element).closest<HTMLElement>('[data-page-id]');
    if (pageEl) {
      const r = pageEl.getBoundingClientRect();
      const s = layoutRef.current.scale;
      void handleFiles(files, {
        pageId: pageEl.dataset.pageId,
        x: (e.clientX - r.left) / s,
        y: (e.clientY - r.top) / s,
      });
    } else {
      void handleFiles(files);
    }
  };

  const visible: React.ReactNode[] = [];
  const end = Math.min(range[1], pages.length - 1);
  for (let i = Math.max(0, range[0]); i <= end; i++) {
    const p = pages[i];
    visible.push(<PageView key={p.id} page={p} scale={scale} top={layout.tops[i]} />);
  }

  return (
    <div
      ref={ref}
      data-testid="viewer"
      className={`viewer relative min-w-0 flex-1 overflow-auto bg-zinc-200 dark:bg-zinc-800 ${
        tool === 'select' ? '' : 'select-none'
      }`}
      onScroll={() => update(true)}
      onPointerDown={(e) => {
        if (!(e.target as Element).closest('[data-annot]') && getState().selected) {
          setState({ selected: null });
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={onDrop}
    >
      <div
        className="relative"
        style={{ height: layout.total, width: layout.width, minWidth: '100%' }}
      >
        {visible}
      </div>
    </div>
  );
}
