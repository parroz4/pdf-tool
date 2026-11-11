// Una pagina visibile: canvas (dalla cache o renderizzato), livello testo per
// la selezione, evidenziazioni di ricerca e — solo se servono — i livelli
// modulo/editor, caricati in modo lazy.
import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react';
import { TextLayer } from 'pdfjs-dist';
import { getCached, getPage, renderPage } from '../pdf/pdfjs';
import { useStore, type PageRef } from '../state/store';

const EditorLayer = lazy(() => import('../editor/EditorLayer'));
const FormLayer = lazy(() => import('../editor/FormLayer'));

interface Props {
  page: PageRef;
  scale: number;
  top: number;
}

export const PageView = memo(function PageView({ page, scale, top }: Props) {
  const src = useStore((s) => s.sources[page.srcId]);
  const editorOn = useStore((s) => s.editorOn);
  const hits = useStore((s) => s.search.byPage[page.id]);
  const active = useStore((s) => (s.search.byPage[page.id] ? s.search.active : -1));
  const holder = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const shown = useRef<HTMLCanvasElement | null>(null);
  const [blendEl, setBlendEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!src) return;
    const show = (c: HTMLCanvasElement): void => {
      if (shown.current === c) return;
      shown.current = c;
      c.className = 'block h-full w-full';
      holder.current?.replaceChildren(c);
    };
    const cached = getCached(src, page.index);
    if (cached) {
      show(cached.canvas);
      if (cached.scale === scale) return;
    }
    let job: ReturnType<typeof renderPage> | null = null;
    // Durante lo zoom il canvas esistente viene solo riscalato via CSS; il
    // nuovo render parte quando la scala si ferma.
    const timer = setTimeout(
      () => {
        job = renderPage(src, page.index, scale);
        job.promise.then(
          (c) => c && show(c),
          (e) => console.error('Render pagina non riuscito', e),
        );
      },
      shown.current ? 140 : 0,
    );
    return () => {
      clearTimeout(timer);
      job?.cancel();
    };
  }, [src, page.index, scale]);

  useEffect(() => {
    const div = textRef.current;
    if (!src || !div) return;
    let cancelled = false;
    let layer: TextLayer | null = null;
    const timer = setTimeout(async () => {
      try {
        const p = await getPage(src, page.index);
        if (cancelled) return;
        layer = new TextLayer({
          textContentSource: p.streamTextContent(),
          container: div,
          viewport: p.getViewport({ scale: 1 }),
        });
        await layer.render();
      } catch {
        /* annullato o pagina senza testo */
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      layer?.cancel();
      div.replaceChildren();
    };
  }, [src, page.index]);

  const w = page.w * scale;
  const h = page.h * scale;

  return (
    <div
      data-page-id={page.id}
      className="page absolute right-0 left-0 mx-auto bg-white shadow-md"
      style={
        {
          top,
          width: w,
          height: h,
          '--total-scale-factor': scale,
          '--s': scale,
        } as React.CSSProperties
      }
    >
      <div ref={holder} className="absolute inset-0 overflow-hidden" />
      <div ref={textRef} className="textLayer" />
      {/* Livello in moltiplicazione (evidenziazioni, risultati di ricerca): è
          l'intero livello a fondersi con il canvas, come farà il PDF esportato. */}
      <div
        ref={setBlendEl}
        className="pointer-events-none absolute top-0 left-0 origin-top-left mix-blend-multiply"
        style={{ width: page.w, height: page.h, transform: `scale(${scale})` }}
      >
        {hits?.map((hit) =>
          hit.rects.map((r, i) => (
            <div
              key={`${hit.n}-${i}`}
              data-hit={hit.n === active ? 'active' : 'hit'}
              className="absolute"
              style={{
                left: r[0],
                top: r[1],
                width: r[2],
                height: r[3],
                // colori sRGB espliciti: in moltiplicazione quelli fuori gamut danno artefatti
                background: hit.n === active ? '#fb923c' : '#fde047',
                opacity: hit.n === active ? 0.85 : 0.6,
              }}
            />
          )),
        )}
      </div>
      <div
        className="pointer-events-none absolute top-0 left-0 origin-top-left"
        style={{ width: page.w, height: page.h, transform: `scale(${scale})` }}
      >
        <Suspense fallback={null}>
          {src?.hasForm && <FormLayer page={page} src={src} />}
          {editorOn && <EditorLayer page={page} scale={scale} blendEl={blendEl} />}
        </Suspense>
      </div>
    </div>
  );
});
