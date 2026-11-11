// Unico punto di contatto con pdf.js: apertura, rendering con cache LRU,
// miniature. Il parsing gira nel worker e il rendering nel "renderer worker"
// (OffscreenCanvas), quindi il thread UI resta libero durante lo scroll.
import {
  AnnotationMode,
  getDocument,
  GlobalWorkerOptions,
  PasswordResponses,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import rendererUrl from 'pdfjs-dist/build/pdf.renderer.min.mjs?url';
import type { Source } from '../state/store';

GlobalWorkerOptions.workerSrc = workerUrl;
GlobalWorkerOptions.rendererSrc = rendererUrl;

const assets = (dir: string): string => new URL(`pdfjs/${dir}/`, document.baseURI).href;

export class PasswordCancelled extends Error {}

export async function openPdf(file: Blob): Promise<PDFDocumentProxy> {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = getDocument({
    data,
    cMapUrl: assets('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assets('standard_fonts'),
    wasmUrl: assets('wasm'),
    iccUrl: assets('iccs'),
  });
  let cancelled = false;
  task.onPassword = (update: (pw: string) => void, reason: number) => {
    const pw = window.prompt(
      reason === PasswordResponses.INCORRECT_PASSWORD
        ? 'Password errata. Riprova:'
        : 'Questo PDF è protetto. Inserisci la password:',
    );
    if (pw === null) {
      cancelled = true;
      void task.destroy();
    } else {
      update(pw);
    }
  };
  try {
    return await task.promise;
  } catch (e) {
    if (cancelled) throw new PasswordCancelled();
    throw e;
  }
}

export const getPage = (src: Source, index: number): Promise<PDFPageProxy> =>
  src.pdf.getPage(index + 1);

// ------------------------------------------------------------ cache render

interface CacheEntry {
  canvas: HTMLCanvasElement;
  scale: number;
  px: number;
}

/** Budget della cache in pixel (4 byte l'uno): ~96 MB. */
const CACHE_BUDGET_PX = 24e6;
/** Limite per singola pagina: oltre, si renderizza a risoluzione ridotta. */
const MAX_PAGE_PX = 16e6;

const cache = new Map<string, CacheEntry>();
let cachePx = 0;

const key = (src: Source, index: number): string => `${src.id}:${index}`;

export function getCached(src: Source, index: number): CacheEntry | undefined {
  const k = key(src, index);
  const e = cache.get(k);
  if (e) {
    cache.delete(k);
    cache.set(k, e);
  }
  return e;
}

function putCached(k: string, canvas: HTMLCanvasElement, scale: number): void {
  const old = cache.get(k);
  if (old) {
    cachePx -= old.px;
    cache.delete(k);
  }
  const px = canvas.width * canvas.height;
  cache.set(k, { canvas, scale, px });
  cachePx += px;
  for (const [ok, oe] of cache) {
    if (cachePx <= CACHE_BUDGET_PX || ok === k) break;
    cache.delete(ok);
    cachePx -= oe.px;
    oe.canvas.width = 0; // libera subito la memoria del bitmap
  }
}

export function dropSourceFromCache(srcId: string): void {
  for (const [k, e] of cache) {
    if (k.startsWith(`${srcId}:`)) {
      cache.delete(k);
      cachePx -= e.px;
    }
  }
  for (const k of thumbs.keys()) if (k.startsWith(`${srcId}:`)) thumbs.delete(k);
}

export interface RenderJob {
  promise: Promise<HTMLCanvasElement | null>;
  cancel: () => void;
}

/**
 * Renderizza una pagina su un canvas fuori schermo alla scala CSS richiesta
 * (moltiplicata per il devicePixelRatio). Risolve `null` se annullato.
 */
export function renderPage(src: Source, index: number, scale: number): RenderJob {
  let cancelled = false;
  let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
  const promise = (async () => {
    const page = await getPage(src, index);
    if (cancelled) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let out = scale * dpr;
    const base = page.getViewport({ scale: 1 });
    const px = base.width * base.height * out * out;
    if (px > MAX_PAGE_PX) out *= Math.sqrt(MAX_PAGE_PX / px);
    const viewport = page.getViewport({ scale: out });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    task = page.render({
      canvas,
      viewport,
      // I campi modulo li disegna il FormLayer (HTML), non il canvas.
      annotationMode: src.hasForm ? AnnotationMode.ENABLE_FORMS : AnnotationMode.ENABLE,
    });
    try {
      await task.promise;
    } catch (e) {
      if (cancelled) return null;
      throw e;
    }
    if (cancelled) return null;
    putCached(key(src, index), canvas, scale);
    return canvas;
  })();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      task?.cancel();
    },
  };
}

// --------------------------------------------------------------- miniature

export const THUMB_W = 132;
const THUMB_LIMIT = 400;
const thumbs = new Map<string, HTMLCanvasElement>();
let thumbQueue: Promise<unknown> = Promise.resolve();

export const getCachedThumb = (src: Source, index: number): HTMLCanvasElement | undefined =>
  thumbs.get(key(src, index));

/** Le miniature si renderizzano una alla volta, per non rubare tempo alle pagine. */
export function renderThumb(src: Source, index: number): RenderJob {
  let cancelled = false;
  const run = async (): Promise<HTMLCanvasElement | null> => {
    if (cancelled) return null;
    const k = key(src, index);
    const hit = thumbs.get(k);
    if (hit) return hit;
    const page = await getPage(src, index);
    if (cancelled) return null;
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: (THUMB_W * dpr) / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    await page.render({ canvas, viewport }).promise;
    thumbs.set(k, canvas);
    if (thumbs.size > THUMB_LIMIT) {
      const oldest = thumbs.keys().next().value;
      if (oldest !== undefined) thumbs.delete(oldest);
    }
    return canvas;
  };
  const promise = thumbQueue.then(run, run);
  thumbQueue = promise.catch(() => null);
  return { promise, cancel: () => (cancelled = true) };
}
