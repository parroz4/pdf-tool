// Livello di editing di una pagina (chunk lazy): mostra le annotazioni e
// gestisce creazione, selezione, spostamento e ridimensionamento.
// Vive dentro un contenitore già scalato: qui tutte le misure sono in punti.
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  addAnnot,
  checkpoint,
  getState,
  removeAnnot,
  setState,
  uid,
  updateAnnot,
  useStore,
  type Annot,
  type BoxAnnot,
  type InkAnnot,
  type PageRef,
  type TextAnnot,
} from '../state/store';

const EMPTY: Annot[] = [];
const MIN_BOX = 6;

/** Trascinamento generico: gli spostamenti arrivano in punti pagina. */
function drag(
  e: React.PointerEvent,
  scale: number,
  onMove: (dx: number, dy: number) => void,
): void {
  const x0 = e.clientX;
  const y0 = e.clientY;
  let moved = false;
  const move = (ev: PointerEvent): void => {
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!moved) {
      if (Math.hypot(dx, dy) < 3) return;
      moved = true;
      checkpoint(); // un solo passo di annulla per l'intero trascinamento
    }
    onMove(dx / scale, dy / scale);
  };
  const up = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

const HANDLES: [number, number, string][] = [
  [-1, -1, 'nwse-resize'],
  [0, -1, 'ns-resize'],
  [1, -1, 'nesw-resize'],
  [1, 0, 'ew-resize'],
  [1, 1, 'nwse-resize'],
  [0, 1, 'ns-resize'],
  [-1, 1, 'nesw-resize'],
  [-1, 0, 'ew-resize'],
];

function resized(o: BoxAnnot, hx: number, hy: number, dx: number, dy: number): Partial<BoxAnnot> {
  let { x, y, w, h } = o;
  if (hx < 0) w -= dx;
  if (hx > 0) w += dx;
  if (hy < 0) h -= dy;
  if (hy > 0) h += dy;
  w = Math.max(MIN_BOX, w);
  h = Math.max(MIN_BOX, h);
  // Dagli angoli le immagini mantengono le proporzioni.
  if (o.type === 'image' && hx !== 0 && hy !== 0) {
    const k = Math.max(w / o.w, h / o.h);
    w = o.w * k;
    h = o.h * k;
  }
  if (hx < 0) x = o.x + o.w - w;
  if (hy < 0) y = o.y + o.h - h;
  return { x, y, w, h };
}

function inkBounds(a: InkAnnot): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < a.points.length; i += 2) {
    x0 = Math.min(x0, a.points[i]);
    x1 = Math.max(x1, a.points[i]);
    y0 = Math.min(y0, a.points[i + 1]);
    y1 = Math.max(y1, a.points[i + 1]);
  }
  const m = a.width / 2;
  return { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
}

const inkPath = (pts: number[]): string => {
  let d = `M${pts[0]} ${pts[1]}`;
  for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
  if (pts.length === 2) d += `L${pts[0] + 0.01} ${pts[1]}`;
  return d;
};

function TextEditor({ a, pageId }: { a: TextAnnot; pageId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current!;
    el.textContent = a.text;
    try {
      el.contentEditable = 'plaintext-only';
    } catch {
      el.contentEditable = 'true';
    }
    el.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // Si monta una volta sola: il contenuto lo gestisce il browser, non React.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = (): void => {
    if (done.current) return;
    done.current = true;
    const text = (ref.current?.innerText ?? '').replace(/\r/g, '').replace(/\n$/, '');
    if (text.trim() === '') {
      if (a.text !== '') checkpoint();
      removeAnnot(pageId, a.id);
    } else if (text !== a.text) {
      if (a.text !== '') checkpoint();
      updateAnnot(pageId, a.id, { text });
    }
    if (getState().editingText === a.id) setState({ editingText: null });
  };

  return (
    <div
      ref={ref}
      data-annot={a.id}
      data-testid="text-editor"
      spellCheck={false}
      className="annot-text annot-selected pointer-events-auto absolute cursor-text bg-white/70 outline-none"
      style={{ left: a.x, top: a.y, fontSize: a.size, color: a.color }}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          ref.current?.blur();
        }
      }}
    />
  );
}

export default function EditorLayer({
  page,
  scale,
  blendEl,
}: {
  page: PageRef;
  scale: number;
  /** Livello "moltiplica" della pagina: ci finiscono i riempimenti degli evidenziatori. */
  blendEl: HTMLElement | null;
}) {
  const annots = useStore((s) => s.annots[page.id]) ?? EMPTY;
  const tool = useStore((s) => s.tool);
  const selectedId = useStore((s) => (s.selected?.pageId === page.id ? s.selected.id : null));
  const editingText = useStore((s) => s.editingText);
  const assets = useStore((s) => s.assets);
  const root = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Annot | null>(null);
  const draftRef = useRef<Annot | null>(null);
  const start = useRef({ x: 0, y: 0 });

  const toPt = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = root.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(page.w, (e.clientX - r.left) / scale)),
      y: Math.max(0, Math.min(page.h, (e.clientY - r.top) / scale)),
    };
  };
  const putDraft = (d: Annot | null): void => {
    draftRef.current = d;
    setDraft(d);
  };

  // ------------------------------------------------- creazione (strumenti)
  const onDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const p = toPt(e);
    const { style } = getState();
    if (tool === 'text') {
      // Lascia che un'eventuale casella in modifica si chiuda prima di crearne un'altra.
      e.preventDefault();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      const a: TextAnnot = {
        id: uid('n'),
        type: 'text',
        x: p.x,
        y: Math.max(0, p.y - style.size * 0.6),
        text: '',
        size: style.size,
        color: style.color,
      };
      checkpoint();
      addAnnot(page.id, a);
      setState({ tool: 'select', selected: { pageId: page.id, id: a.id }, editingText: a.id });
      return;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = p;
    if (tool === 'draw') {
      putDraft({ id: uid('n'), type: 'ink', points: [p.x, p.y], color: style.color, width: style.width });
    } else if (tool === 'highlight') {
      putDraft({ id: uid('n'), type: 'highlight', x: p.x, y: p.y, w: 0, h: 0, color: style.hlColor });
    } else if (tool === 'rect') {
      putDraft({ id: uid('n'), type: 'rect', x: p.x, y: p.y, w: 0, h: 0, color: style.color, width: style.width });
    }
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = draftRef.current;
    if (!d) return;
    if (d.type === 'ink') {
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
      const points = d.points.slice();
      const minDist = 0.8 / scale;
      for (const ev of events.length > 0 ? events : [e.nativeEvent]) {
        const p = toPt(ev);
        const n = points.length;
        if (Math.hypot(p.x - points[n - 2], p.y - points[n - 1]) >= minDist) points.push(p.x, p.y);
      }
      putDraft({ ...d, points });
    } else if (d.type === 'rect' || d.type === 'highlight') {
      const p = toPt(e);
      const s = start.current;
      putDraft({
        ...d,
        x: Math.min(s.x, p.x),
        y: Math.min(s.y, p.y),
        w: Math.abs(p.x - s.x),
        h: Math.abs(p.y - s.y),
      });
    }
  };

  const onUp = (): void => {
    const d = draftRef.current;
    if (!d) return;
    putDraft(null);
    if ((d.type === 'rect' || d.type === 'highlight') && d.w < 3 && d.h < 3) return;
    checkpoint();
    addAnnot(page.id, d);
  };

  // ------------------------------------------- selezione e spostamento
  const grab = (e: React.PointerEvent, a: Annot): void => {
    if (e.button !== 0) return;
    if (tool === 'text' && a.type === 'text') {
      e.stopPropagation();
      e.preventDefault();
      setState({ tool: 'select', selected: { pageId: page.id, id: a.id }, editingText: a.id });
      return;
    }
    if (tool !== 'select') return;
    e.stopPropagation();
    e.preventDefault();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setState({ selected: { pageId: page.id, id: a.id } });
    if (a.type === 'ink') {
      drag(e, scale, (dx, dy) =>
        updateAnnot(page.id, a.id, {
          points: a.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)),
        }),
      );
    } else {
      const w = 'w' in a ? a.w : 10;
      const h = 'h' in a ? a.h : 10;
      drag(e, scale, (dx, dy) =>
        updateAnnot(page.id, a.id, {
          x: Math.max(10 - w, Math.min(page.w - 10, a.x + dx)),
          y: Math.max(10 - h, Math.min(page.h - 10, a.y + dy)),
        }),
      );
    }
  };

  const handles = (a: BoxAnnot): React.ReactNode =>
    HANDLES.map(([hx, hy, cursor]) => (
      <span
        key={`${hx}${hy}`}
        className="annot-handle"
        data-handle={`${hx},${hy}`}
        style={{ left: `${(hx + 1) * 50}%`, top: `${(hy + 1) * 50}%`, cursor }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          e.preventDefault();
          drag(e, scale, (dx, dy) => updateAnnot(page.id, a.id, resized(a, hx, hy, dx, dy)));
        }}
      />
    ));

  const interactive = tool === 'select';

  const render = (a: Annot, isDraft = false): React.ReactNode => {
    const sel = !isDraft && a.id === selectedId;
    const pe = interactive && !isDraft ? 'auto' : 'none';
    const common = {
      'data-annot': a.id,
      'data-annot-type': a.type,
      onPointerDown: (e: React.PointerEvent) => grab(e, a),
      // Evita che il mousedown sposti il focus (chiuderebbe subito l'editor di testo).
      onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
    };
    switch (a.type) {
      case 'image': {
        const asset = assets[a.assetId];
        return (
          <div
            key={a.id}
            {...common}
            className={`absolute cursor-move ${sel ? 'annot-selected' : ''}`}
            style={{ left: a.x, top: a.y, width: a.w, height: a.h, pointerEvents: pe }}
          >
            {asset && (
              <img src={asset.url} alt="" draggable={false} className="block h-full w-full select-none" />
            )}
            {sel && handles(a)}
          </div>
        );
      }
      case 'rect':
        return (
          <div
            key={a.id}
            {...common}
            className={`absolute cursor-move ${sel ? 'annot-selected' : ''}`}
            style={{ left: a.x, top: a.y, width: a.w, height: a.h, pointerEvents: pe }}
          >
            {/* Il tratto è centrato sul bordo, come nel PDF esportato. */}
            <div
              className="absolute"
              style={{ inset: -a.width / 2, border: `${a.width}px solid ${a.color}` }}
            />
            {sel && handles(a)}
          </div>
        );
      case 'highlight':
        return (
          <div
            key={a.id}
            {...common}
            className={`absolute cursor-move ${sel ? 'annot-selected' : ''}`}
            style={{ left: a.x, top: a.y, width: a.w, height: a.h, pointerEvents: pe }}
          >
            {blendEl &&
              createPortal(
                <div
                  className="absolute"
                  style={{ left: a.x, top: a.y, width: a.w, height: a.h, background: a.color, opacity: 0.4 }}
                />,
                blendEl,
              )}
            {sel && handles(a)}
          </div>
        );
      case 'ink': {
        const d = inkPath(a.points);
        const b = sel ? inkBounds(a) : null;
        return (
          <div key={a.id} className="pointer-events-none absolute inset-0">
            <svg
              className="absolute inset-0 overflow-visible"
              width={page.w}
              height={page.h}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={d} stroke={a.color} strokeWidth={a.width} />
              {/* tratto invisibile più largo: rende la linea facile da afferrare */}
              <path
                {...common}
                d={d}
                stroke="transparent"
                strokeWidth={Math.max(a.width, 10 / scale)}
                className="cursor-move"
                style={{ pointerEvents: pe === 'auto' ? 'stroke' : 'none' }}
              />
            </svg>
            {b && (
              <div
                className="annot-selected absolute"
                style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
              />
            )}
          </div>
        );
      }
      case 'text':
        if (a.id === editingText) return <TextEditor key={a.id} a={a} pageId={page.id} />;
        return (
          <div
            key={a.id}
            {...common}
            className={`annot-text absolute cursor-move select-none ${sel ? 'annot-selected' : ''}`}
            style={{
              left: a.x,
              top: a.y,
              fontSize: a.size,
              color: a.color,
              pointerEvents: interactive || tool === 'text' ? 'auto' : 'none',
            }}
            onDoubleClick={() =>
              setState({ selected: { pageId: page.id, id: a.id }, editingText: a.id })
            }
          >
            {a.text}
          </div>
        );
    }
  };

  const cursor = tool === 'text' ? 'text' : 'crosshair';

  return (
    <div ref={root} className="absolute inset-0">
      {tool !== 'select' && (
        <div
          data-testid="draw-surface"
          className="pointer-events-auto absolute inset-0 touch-none"
          style={{ cursor }}
          onPointerDown={onDown}
          onMouseDown={(e) => e.preventDefault()}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      )}
      {annots.map((a) => render(a))}
      {draft && render(draft, true)}
    </div>
  );
}
