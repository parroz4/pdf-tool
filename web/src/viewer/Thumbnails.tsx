// Pannello miniature virtualizzato; è anche l'organizzatore di pagine:
// trascinamento per riordinare, selezione multipla, eliminazione, e rilascio
// di file PDF per inserirli in un punto preciso.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getCachedThumb, renderThumb, THUMB_W } from '../pdf/pdfjs';
import { mergeFiles } from '../state/actions';
import { deletePages, getState, movePages, setState, useStore, type PageRef } from '../state/store';
import { Icon } from '../ui/Icon';
import { viewerApi } from './api';

const LABEL_H = 18;
const GAP = 10;
const PAD = 10;

const Thumb = memo(function Thumb(props: {
  page: PageRef;
  index: number;
  top: number;
  height: number;
  selected: boolean;
  current: boolean;
}) {
  const { page, index, top, height, selected, current } = props;
  const src = useStore((s) => s.sources[page.srcId]);
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!src) return;
    const show = (c: HTMLCanvasElement): void => {
      // La miniatura in cache può essere già montata altrove: se ne usa una copia.
      const copy = document.createElement('canvas');
      copy.width = c.width;
      copy.height = c.height;
      copy.getContext('2d')?.drawImage(c, 0, 0);
      copy.className = 'block h-full w-full';
      holder.current?.replaceChildren(copy);
    };
    const hit = getCachedThumb(src, page.index);
    if (hit) {
      show(hit);
      return;
    }
    let job: ReturnType<typeof renderThumb> | null = null;
    const timer = setTimeout(() => {
      job = renderThumb(src, page.index);
      job.promise.then(
        (c) => c && show(c),
        () => {},
      );
    }, 80);
    return () => {
      clearTimeout(timer);
      job?.cancel();
    };
  }, [src, page.index]);

  return (
    <div
      data-thumb={index}
      data-thumb-id={page.id}
      draggable
      aria-selected={selected}
      className="absolute left-0 right-0 mx-auto cursor-pointer"
      style={{ top, width: THUMB_W, height: height + LABEL_H }}
    >
      <div
        ref={holder}
        className={`overflow-hidden bg-white shadow ${
          selected
            ? 'outline-2 outline-offset-1 outline-blue-500'
            : current
              ? 'outline-2 outline-offset-1 outline-zinc-400'
              : ''
        }`}
        style={{ height }}
      />
      <div
        className={`text-center text-[11px] leading-[18px] ${
          selected ? 'font-semibold text-blue-700 dark:text-blue-300' : 'text-zinc-600 dark:text-zinc-400'
        }`}
      >
        {index + 1}
      </div>
    </div>
  );
});

export default function Thumbnails() {
  const pages = useStore((s) => s.pages);
  const pageSel = useStore((s) => s.pageSel);
  const current = useStore((s) => s.currentPage);
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const lastClicked = useRef<string | null>(null);

  const layout = useMemo(() => {
    const tops = new Float64Array(pages.length);
    const heights = new Float64Array(pages.length);
    let y = PAD;
    for (let i = 0; i < pages.length; i++) {
      const h = Math.min(THUMB_W * 2.2, (THUMB_W * pages[i].h) / pages[i].w);
      tops[i] = y;
      heights[i] = h;
      y += h + LABEL_H + GAP;
    }
    return { tops, heights, total: y - GAP + PAD };
  }, [pages]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const find = (y: number): number => {
    const { tops } = layoutRef.current;
    let lo = 0;
    let hi = tops.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const update = (): void => {
    const el = ref.current;
    if (!el || pages.length === 0) return;
    const a = Math.max(0, find(el.scrollTop) - 2);
    const b = Math.min(pages.length - 1, find(el.scrollTop + el.clientHeight) + 2);
    setRange((r) => (r[0] === a && r[1] === b ? r : [a, b]));
  };
  useLayoutEffect(update, [layout]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // La miniatura della pagina corrente resta visibile nel pannello.
  useEffect(() => {
    const el = ref.current;
    const { tops, heights } = layoutRef.current;
    if (!el || current >= tops.length) return;
    const top = tops[current];
    const bottom = top + heights[current] + LABEL_H;
    if (top < el.scrollTop) el.scrollTop = top - PAD;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight + PAD;
  }, [current]);

  /** Indice di inserimento corrispondente a una posizione verticale del puntatore. */
  const insertionIndex = (clientY: number): number => {
    const el = ref.current!;
    const y = clientY - el.getBoundingClientRect().top + el.scrollTop;
    const { tops, heights } = layoutRef.current;
    if (tops.length === 0) return 0;
    const i = find(y);
    return y > tops[i] + (heights[i] + LABEL_H) / 2 ? i + 1 : i;
  };

  const onClick = (e: React.MouseEvent): void => {
    const el = (e.target as Element).closest<HTMLElement>('[data-thumb-id]');
    if (!el) {
      setState({ pageSel: [] });
      return;
    }
    const id = el.dataset.thumbId!;
    const index = Number(el.dataset.thumb);
    const s = getState();
    if (e.shiftKey && lastClicked.current) {
      const from = s.pages.findIndex((p) => p.id === lastClicked.current);
      if (from >= 0) {
        const [a, b] = from < index ? [from, index] : [index, from];
        setState({ pageSel: s.pages.slice(a, b + 1).map((p) => p.id) });
        return;
      }
    }
    lastClicked.current = id;
    if (e.ctrlKey || e.metaKey) {
      setState({
        pageSel: s.pageSel.includes(id) ? s.pageSel.filter((x) => x !== id) : [...s.pageSel, id],
      });
    } else {
      setState({ pageSel: [id] });
      viewerApi.scrollToPage(index);
    }
  };

  const onDragStart = (e: React.DragEvent): void => {
    const el = (e.target as Element).closest<HTMLElement>('[data-thumb-id]');
    if (!el) return;
    const id = el.dataset.thumbId!;
    if (!getState().pageSel.includes(id)) setState({ pageSel: [id] });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-pdf-tool-pages', id);
  };

  const accepts = (e: React.DragEvent): boolean =>
    e.dataTransfer.types.includes('application/x-pdf-tool-pages') ||
    e.dataTransfer.types.includes('Files');

  const onDrop = (e: React.DragEvent): void => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const at = insertionIndex(e.clientY);
    setDropAt(null);
    if (e.dataTransfer.types.includes('application/x-pdf-tool-pages')) {
      movePages(getState().pageSel, at);
    } else {
      void mergeFiles(Array.from(e.dataTransfer.files), at);
    }
  };

  const visible: React.ReactNode[] = [];
  const end = Math.min(range[1], pages.length - 1);
  for (let i = Math.max(0, range[0]); i <= end; i++) {
    const p = pages[i];
    visible.push(
      <Thumb
        key={p.id}
        page={p}
        index={i}
        top={layout.tops[i]}
        height={layout.heights[i]}
        selected={pageSel.includes(p.id)}
        current={i === current}
      />,
    );
  }
  const lineY =
    dropAt === null || pages.length === 0
      ? null
      : dropAt >= pages.length
        ? layout.total - PAD + GAP / 2 - 1
        : layout.tops[dropAt] - GAP / 2 - 1;

  return (
    <aside className="flex w-44 shrink-0 flex-col border-r border-zinc-300 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-zinc-300 px-2 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
        <span>{pageSel.length > 1 ? `${pageSel.length} selezionate` : `${pages.length} pagine`}</span>
        <button
          type="button"
          title="Elimina le pagine selezionate (Canc)"
          aria-label="Elimina le pagine selezionate"
          data-testid="delete-pages"
          disabled={pageSel.length === 0}
          className="rounded p-1 hover:bg-zinc-200 disabled:opacity-30 dark:hover:bg-zinc-700"
          onClick={() => deletePages(pageSel)}
        >
          <Icon name="trash" size={15} />
        </button>
      </div>
      <div
        ref={ref}
        data-testid="thumbs"
        tabIndex={0}
        className="thumbs relative flex-1 overflow-y-auto outline-none"
        onScroll={update}
        onClick={onClick}
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && pageSel.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            deletePages(pageSel);
          } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            setState({ pageSel: pages.map((p) => p.id) });
          }
        }}
        onDragStart={onDragStart}
        onDragOver={(e) => {
          if (!accepts(e)) return;
          e.preventDefault();
          e.stopPropagation();
          const at = insertionIndex(e.clientY);
          if (at !== dropAt) setDropAt(at);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
        }}
        onDrop={onDrop}
      >
        <div className="relative" style={{ height: layout.total }}>
          {visible}
          {lineY !== null && (
            <div
              className="pointer-events-none absolute right-2 left-2 h-0.5 rounded bg-blue-500"
              style={{ top: lineY }}
            />
          )}
        </div>
      </div>
    </aside>
  );
}
