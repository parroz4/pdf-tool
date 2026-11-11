// Genera i PDF e l'immagine di prova in tests/out/fixtures (non versionati).
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'out', 'fixtures');
mkdirSync(dir, { recursive: true });

async function textDoc(name, count, label, size = [595, 842]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= count; i++) {
    const page = doc.addPage(size);
    const { height } = page.getSize();
    page.drawText(`${label} ${i}`, { x: 50, y: height - 80, size: 28, font: bold });
    for (let l = 0; l < 30; l++) {
      page.drawText(
        `Riga ${l + 1} della pagina ${i}: il veloce cane marrone salta oltre la volpe pigra.` +
          (i % 97 === 0 && l === 12 ? ' ornitorinco' : ''),
        { x: 50, y: height - 130 - l * 20, size: 11, font, color: rgb(0.15, 0.15, 0.15) },
      );
    }
    page.drawRectangle({ x: 50, y: 40, width: 495 * (i / count), height: 8, color: rgb(0.2, 0.4, 0.9) });
  }
  writeFileSync(join(dir, name), await doc.save());
}

async function formDoc() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const form = doc.getForm();
  page.drawText('Modulo di prova', { x: 50, y: 780, size: 22, font });
  page.drawText('Nome', { x: 50, y: 730, size: 12, font });
  form.createTextField('nome').addToPage(page, { x: 150, y: 722, width: 250, height: 22 });
  page.drawText('Note', { x: 50, y: 690, size: 12, font });
  const note = form.createTextField('note');
  note.enableMultiline();
  note.addToPage(page, { x: 150, y: 630, width: 250, height: 70 });
  page.drawText('Accetto', { x: 50, y: 595, size: 12, font });
  form.createCheckBox('accetto').addToPage(page, { x: 150, y: 590, width: 16, height: 16 });
  page.drawText('Colore', { x: 50, y: 555, size: 12, font });
  const radio = form.createRadioGroup('colore');
  radio.addOptionToPage('rosso', page, { x: 150, y: 550, width: 16, height: 16 });
  radio.addOptionToPage('blu', page, { x: 200, y: 550, width: 16, height: 16 });
  page.drawText('Paese', { x: 50, y: 515, size: 12, font });
  const dd = form.createDropdown('paese');
  dd.addOptions(['Italia', 'Francia', 'Spagna']);
  dd.select('Francia');
  dd.addToPage(page, { x: 150, y: 508, width: 150, height: 22 });
  const p2 = doc.addPage([595, 842]);
  p2.drawText('Seconda pagina del modulo', { x: 50, y: 780, size: 22, font });
  writeFileSync(join(dir, 'form.pdf'), await doc.save());
}

async function rotatedDoc() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('Pagina ruotata di 90 gradi', { x: 60, y: 760, size: 24, font });
  page.drawRectangle({ x: 60, y: 60, width: 100, height: 60, color: rgb(0.9, 0.3, 0.3) });
  page.setRotation(degrees(90));
  page.setCropBox(20, 30, 555, 782);
  writeFileSync(join(dir, 'rotated.pdf'), await doc.save());
}

function png(w, h, pixel) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 3 + 1) + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await textDoc('basic.pdf', 3, 'Documento base, pagina');
await textDoc('other.pdf', 2, 'Altro documento, pagina', [842, 595]);
await textDoc('long.pdf', 800, 'Capitolo');
await formDoc();
await rotatedDoc();
// Immagine a scacchi magenta/verde: colori che non compaiono nei PDF di prova.
writeFileSync(
  join(dir, 'image.png'),
  png(200, 120, (x, y) => (((x >> 5) + (y >> 5)) % 2 ? [255, 0, 255] : [0, 200, 80])),
);
console.log('Fixture create in', dir);
