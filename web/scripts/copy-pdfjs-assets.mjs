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
