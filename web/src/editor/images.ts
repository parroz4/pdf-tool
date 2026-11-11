// Inserimento immagini (chunk lazy). pdf-lib incorpora solo PNG e JPEG: gli
// altri formati — e i JPEG con orientamento EXIF — vengono ricodificati.
import {
  addAnnot,
  checkpoint,
  getState,
  setState,
  uid,
  type Asset,
  type ImageAnnot,
} from '../state/store';
import { viewerApi } from '../viewer/api';

function sniff(b: Uint8Array): Asset['mime'] | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  return null;
}

/** Orientamento EXIF di un JPEG (1 = normale). */
function jpegOrientation(b: Uint8Array): number {
  let o = 2;
  while (o + 4 < b.length && b[o] === 0xff) {
    const marker = b[o + 1];
    const len = (b[o + 2] << 8) | b[o + 3];
    if (marker === 0xda) break;
    if (marker === 0xe1 && b[o + 4] === 0x45 && b[o + 5] === 0x78) {
      const t = o + 10;
      const le = b[t] === 0x49;
      const u16 = (p: number): number => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]);
      const u32 = (p: number): number =>
        le ? u16(p) | (u16(p + 2) << 16) : (u16(p) << 16) | u16(p + 2);
      const ifd = t + u32(t + 4);
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > b.length) break;
        if (u16(e) === 0x0112) return u16(e + 8);
      }
      return 1;
    }
    o += 2 + len;
  }
  return 1;
}

async function decode(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function reencode(img: HTMLImageElement, mime: Asset['mime']): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || 512;
  canvas.height = img.naturalHeight || 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas non disponibile');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('codifica non riuscita'))), mime, 0.92),
  );
}

export async function loadAsset(file: Blob): Promise<Asset> {
  let blob = file;
  let bytes = new Uint8Array(await blob.arrayBuffer());
  let mime = sniff(bytes);
  const img = await decode(mime ? new Blob([bytes], { type: mime }) : blob);
  if (!mime || (mime === 'image/jpeg' && jpegOrientation(bytes) > 1)) {
    mime = mime ?? 'image/png';
    blob = await reencode(img, mime);
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  return {
    id: uid('a'),
    bytes,
    mime,
    url: URL.createObjectURL(new Blob([bytes], { type: mime })),
    w: img.naturalWidth || 512,
    h: img.naturalHeight || 512,
  };
}

/**
 * Inserisce un'immagine centrata nel punto (x, y) della pagina indicata, o al
 * centro della parte visibile della pagina corrente.
 */
export async function insertImage(
  file: Blob,
  pageId?: string,
  x?: number,
  y?: number,
  offset = 0,
): Promise<void> {
  const asset = await loadAsset(file);
  const s = getState();
  const page = s.pages.find((p) => p.id === pageId) ?? s.pages[s.currentPage] ?? s.pages[0];
  if (!page) return;
  // Dimensione naturale a 96 dpi, ridotta se supera il 60% della pagina.
  let w = asset.w * 0.75;
  let h = asset.h * 0.75;
  const k = Math.min(1, (page.w * 0.6) / w, (page.h * 0.6) / h);
  w *= k;
  h *= k;
  const center =
    x !== undefined && y !== undefined ? { x, y } : (viewerApi.visibleCenter(page.id) ?? { x: page.w / 2, y: page.h / 2 });
  const clamp = (v: number, max: number): number => Math.max(0, Math.min(v, Math.max(0, max)));
  const annot: ImageAnnot = {
    id: uid('n'),
    type: 'image',
    x: clamp(center.x - w / 2 + offset, page.w - w),
    y: clamp(center.y - h / 2 + offset, page.h - h),
    w,
    h,
    assetId: asset.id,
  };
  checkpoint();
  setState((st) => ({ assets: { ...st.assets, [asset.id]: asset } }));
  addAnnot(page.id, annot);
  setState({ editorOn: true, tool: 'select', selected: { pageId: page.id, id: annot.id } });
}
