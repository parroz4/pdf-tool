// Copia in public/pdfjs/ i file di supporto di pdf.js (CMap, font standard,
// decoder wasm, profili ICC). Vengono scaricati dal browser solo se un PDF
// ne ha bisogno, quindi non pesano sull'avvio.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const dst = join(root, 'public', 'pdfjs');

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  cpSync(join(src, dir), join(dst, dir), { recursive: true });
}

// OCR (Tesseract): worker, motore wasm e dati della lingua italiana finiscono
// in public/tesseract/. Si scaricano solo al primo uso del pulsante OCR, così
// il riconoscimento funziona senza CDN e il PDF non lascia il computer.
const nm = join(root, 'node_modules');
const ocr = join(root, 'public', 'tesseract');
rmSync(ocr, { recursive: true, force: true });
mkdirSync(ocr, { recursive: true });
cpSync(join(nm, 'tesseract.js', 'dist', 'worker.min.js'), join(ocr, 'worker.min.js'));
for (const variant of ['relaxedsimd-lstm', 'simd-lstm', 'lstm']) {
  const file = `tesseract-core-${variant}.wasm.js`;
  cpSync(join(nm, 'tesseract.js-core', file), join(ocr, file));
}
cpSync(
  join(nm, '@tesseract.js-data', 'ita', '4.0.0_best_int', 'ita.traineddata.gz'),
  join(ocr, 'ita.traineddata.gz'),
);
