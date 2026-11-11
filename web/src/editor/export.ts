// Costruzione del PDF finale con pdf-lib (chunk lazy: si scarica solo alla
// prima esportazione).
//
// Due strade:
//  - "in place": se le pagine sono esattamente quelle del file originale,
//    nello stesso ordine, si modifica il documento originale. Segnalibri,
//    metadati e campi modulo (che restano compilabili) sono preservati.
//  - "ricostruzione": con pagine riordinate, eliminate o unite da più file si
//    crea un documento nuovo copiando le pagine. Le pagine eliminate non
//    lasciano tracce nel file; i moduli vengono appiattiti (i valori restano
//    visibili ma non più modificabili) e i segnalibri si perdono.
import {
  BlendMode,
  concatTransformationMatrix,
  LineCapStyle,
  LineJoinStyle,
  lineTo,
  moveTo,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingColor,
  StandardFonts,
  stroke,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type RGB,
} from 'pdf-lib';
import { getPage } from '../pdf/pdfjs';
import type { Annot, DocState, FormValue, Source, State } from '../state/store';

type ExportInput = DocState & Pick<State, 'sources' | 'assets'>;

/** Distanza della prima linea di base dal bordo alto della casella, in em
 *  (Helvetica/Arial con interlinea 1.2, come nel livello di editing). */
const BASELINE = 0.9465;
const LINE_HEIGHT = 1.2;

function hex(color: string): RGB {
  const n = parseInt(color.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function applyForm(doc: PDFDocument, values: Record<string, FormValue>, warnings: string[]): void {
  const form = doc.getForm();
  for (const [name, value] of Object.entries(values)) {
    try {
      const field = form.getFieldMaybe(name);
      if (!field) continue;
      if (field instanceof PDFTextField) {
        field.setText(String(value) || undefined);
      } else if (field instanceof PDFCheckBox) {
        if (value !== 'Off' && value !== '') field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        if (value) field.select(String(value));
      } else if (field instanceof PDFDropdown) {
        if (value) field.select(String(value));
        else field.clear();
      } else if (field instanceof PDFOptionList) {
        field.select(Array.isArray(value) ? value : [value]);
      }
    } catch (e) {
      warnings.push(`Campo «${name}» non compilato: ${e instanceof Error ? e.message : e}`);
    }
  }
}

function inverse(m: number[]): [number, number, number, number, number, number] {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

function drawAnnots(
  page: PDFPage,
  annots: Annot[],
  viewportTransform: number[],
  height: number,
  images: Map<string, PDFImage>,
  font: PDFFont,
  charset: Set<number>,
  warnings: string[],
): void {
  // Sistema di coordinate "pagina come la si vede": origine in basso a
  // sinistra della pagina mostrata, y verso l'alto. La matrice assorbe
  // rotazione (/Rotate) e origine del CropBox.
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...inverse(viewportTransform)),
    concatTransformationMatrix(1, 0, 0, -1, 0, height),
  );
  for (const a of annots) {
    switch (a.type) {
      case 'image': {
        const image = images.get(a.assetId);
        if (image) {
          page.drawImage(image, { x: a.x, y: height - a.y - a.h, width: a.w, height: a.h });
        }
        break;
      }
      case 'rect':
        page.drawRectangle({
          x: a.x,
          y: height - a.y - a.h,
          width: a.w,
          height: a.h,
          borderColor: hex(a.color),
          borderWidth: a.width,
        });
        break;
      case 'highlight':
        page.drawRectangle({
          x: a.x,
          y: height - a.y - a.h,
          width: a.w,
          height: a.h,
          color: hex(a.color),
          opacity: 0.4,
          blendMode: BlendMode.Multiply,
        });
        break;
      case 'ink': {
        const p = a.points;
        const ops = [
          pushGraphicsState(),
          setStrokingColor(hex(a.color)),
          setLineWidth(a.width),
          setLineCap(LineCapStyle.Round),
          setLineJoin(LineJoinStyle.Round),
          moveTo(p[0], height - p[1]),
        ];
        for (let i = 2; i < p.length; i += 2) ops.push(lineTo(p[i], height - p[i + 1]));
        if (p.length === 2) ops.push(lineTo(p[0] + 0.01, height - p[1]));
        ops.push(stroke(), popGraphicsState());
        page.pushOperators(...ops);
        break;
      }
      case 'text': {
        // Il font standard copre solo WinAnsi: gli altri caratteri diventano "?".
        let replaced = false;
        const text = Array.from(a.text.replace(/\t/g, '    '))
          .map((ch) => {
            if (ch === '\n' || charset.has(ch.codePointAt(0)!)) return ch;
            replaced = true;
            return '?';
          })
          .join('');
        if (replaced) {
          warnings.push(
            'Alcuni caratteri di una casella di testo non sono supportati dal font standard e sono stati sostituiti con «?».',
          );
        }
        if (a.cover) {
          // Testo stampato sostituito: l'originale viene coperto.
          page.drawRectangle({
            x: a.cover.x,
            y: height - a.cover.y - a.cover.h,
            width: a.cover.w,
            height: a.cover.h,
            color: hex(a.cover.color),
          });
        }
        page.drawText(text, {
          x: a.x,
          y: height - a.y - a.size * BASELINE,
          size: a.size,
          lineHeight: a.size * LINE_HEIGHT,
          font,
          color: hex(a.color),
        });
        break;
      }
    }
  }
  page.pushOperators(popGraphicsState());
}

async function loadSourceDoc(src: Source): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(await src.file.arrayBuffer());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/encrypt/i.test(msg)) {
      throw new Error(`«${src.name}» è cifrato: i PDF protetti si possono leggere ma non esportare.`);
    }
    throw new Error(`«${src.name}»: ${msg}`);
  }
}

export async function buildPdf(
  s: ExportInput,
): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const warnings: string[] = [];
  const usedSrcIds = [...new Set(s.pages.map((p) => p.srcId))];
  const only = usedSrcIds.length === 1 ? s.sources[usedSrcIds[0]] : null;
  const inPlace =
    !!only && s.pages.length === only.numPages && s.pages.every((p, i) => p.index === i);

  const docs = new Map<string, PDFDocument>();
  for (const id of usedSrcIds) {
    const src = s.sources[id];
    const doc = await loadSourceDoc(src);
    const values = s.forms[id];
    if (values && Object.keys(values).length > 0) applyForm(doc, values, warnings);
    if (!inPlace && src.hasForm) {
      try {
        doc.getForm().flatten();
      } catch {
        warnings.push(`Non è stato possibile appiattire i campi modulo di «${src.name}».`);
      }
    }
    docs.set(id, doc);
  }

  let out: PDFDocument;
  let outPages: PDFPage[];
  if (inPlace && only) {
    out = docs.get(only.id)!;
    outPages = out.getPages();
  } else {
    out = await PDFDocument.create();
    // Una sola copyPages per sorgente: le risorse condivise (font, immagini)
    // vengono copiate una volta.
    const copied = new Map<string, PDFPage>();
    for (const id of usedSrcIds) {
      const indices = s.pages.filter((p) => p.srcId === id).map((p) => p.index);
      const pages = await out.copyPages(docs.get(id)!, indices);
      indices.forEach((idx, i) => copied.set(`${id}:${idx}`, pages[i]));
    }
    outPages = s.pages.map((p) => out.addPage(copied.get(`${p.srcId}:${p.index}`)!));
    const first = only ?? s.sources[s.pages[0].srcId];
    const title = docs.get(first.id)?.getTitle();
    if (title) out.setTitle(title);
  }

  const annotated = s.pages.some((p) => (s.annots[p.id]?.length ?? 0) > 0);
  if (annotated) {
    const font = await out.embedFont(StandardFonts.Helvetica);
    const charset = new Set(font.getCharacterSet());
    const images = new Map<string, PDFImage>();
    for (let i = 0; i < s.pages.length; i++) {
      const ref = s.pages[i];
      const annots = s.annots[ref.id];
      if (!annots || annots.length === 0) continue;
      for (const a of annots) {
        if (a.type !== 'image' || images.has(a.assetId)) continue;
        const asset = s.assets[a.assetId];
        if (!asset) continue;
        images.set(
          a.assetId,
          asset.mime === 'image/png' ? await out.embedPng(asset.bytes) : await out.embedJpg(asset.bytes),
        );
      }
      const page = await getPage(s.sources[ref.srcId], ref.index);
      const viewport = page.getViewport({ scale: 1 });
      drawAnnots(outPages[i], annots, viewport.transform, viewport.height, images, font, charset, warnings);
    }
  }

  const bytes = await out.save();
  return { bytes, warnings: [...new Set(warnings)] };
}
