// Test end-to-end sulla build di produzione (dist/), con Chromium via Playwright.
//   npm run build && node tests/make-fixtures.mjs && npm run test:e2e
// Richiede il pacchetto `playwright` risolvibile da Node (nei container Claude
// Code è preinstallato globalmente).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'out', 'fixtures');
const OUT = path.join(__dirname, 'out');
const PORT = 4179;
const URL = `http://localhost:${PORT}/`;

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function startServer() {
  const proc = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(URL);
      if (r.ok) return proc;
    } catch {
      /* non ancora pronto */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error('vite preview non è partito');
}

async function choose(page, selector, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(selector)]);
  await chooser.setFiles(files);
}

async function openPdf(page, file) {
  const sel = (await page.$('[data-testid=welcome-open]')) ? '[data-testid=welcome-open]' : '[data-testid=open]';
  // Gli id pagina sono univoci: quando cambiano, il nuovo documento è montato.
  const before = await page.$$eval('[data-page-id]', (els) => els.map((e) => e.dataset.pageId));
  await choose(page, sel, file);
  await page.waitForFunction(
    (old) => {
      const el = document.querySelector('[data-page-id]');
      return el && !old.includes(el.dataset.pageId) && el.querySelector('canvas');
    },
    before,
  );
  await page.waitForSelector('[data-testid=busy]', { state: 'detached' });
}

const pageCount = (page) =>
  page.$eval('[data-testid=page-count]', (el) => Number(el.textContent.replace(/\D/g, '')));

async function gotoPage(page, n) {
  await page.fill('[data-testid=page-input]', String(n));
  await page.press('[data-testid=page-input]', 'Enter');
  await page.waitForTimeout(100);
}

/** Elemento DOM della pagina in cima alla vista (dopo gotoPage). */
async function topPage(page) {
  const handle = await page.evaluateHandle(() => {
    const viewer = document.querySelector('[data-testid=viewer]');
    const top = viewer.getBoundingClientRect().top;
    return [...document.querySelectorAll('[data-page-id]')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.top <= top + 20 && r.bottom > top + 20;
    });
  });
  return handle.asElement();
}

/** Attende che il canvas della pagina sia renderizzato alla scala corrente. */
async function waitRendered(page, el) {
  await page.waitForFunction(
    (p) => {
      const c = p.querySelector('canvas');
      if (!c) return false;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      return Math.abs(c.width - Math.floor(p.getBoundingClientRect().width * dpr)) <= 2;
    },
    el,
    { timeout: 15000 },
  );
}

/** Colore del canvas nel punto (x, y) espresso in punti pagina. */
async function pixel(page, el, x, y) {
  return el.evaluate(
    (p, [px, py]) => {
      const c = p.querySelector('canvas');
      const s = Number(getComputedStyle(p).getPropertyValue('--s'));
      const k = c.width / (p.getBoundingClientRect().width / s);
      const d = c.getContext('2d').getImageData(Math.round(px * k), Math.round(py * k), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [x, y],
  );
}

/** Coordinate schermo di un punto pagina. */
async function at(el, x, y) {
  return el.evaluate(
    (p, [px, py]) => {
      const r = p.getBoundingClientRect();
      const s = Number(getComputedStyle(p).getPropertyValue('--s'));
      return { x: r.left + px * s, y: r.top + py * s };
    },
    [x, y],
  );
}

async function dragOnPage(page, el, from, to, steps = 8) {
  const a = await at(el, from[0], from[1]);
  const b = await at(el, to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
}

async function exportPdf(page, name) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('[data-testid=export]'),
  ]);
  const file = path.join(OUT, name);
  await download.saveAs(file);
  await page.waitForSelector('[data-testid=busy]', { state: 'detached' });
  return file;
}

async function pageTexts(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out.push(tc.items.map((it) => it.str).join(' '));
  }
  await doc.loadingTask.destroy();
  return out;
}

const isMagentaOrGreen = ([r, g, b]) =>
  (r > 200 && g < 60 && b > 200) || (r < 60 && g > 150 && b < 130);
const near = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const requests = [];
  const errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => d.accept());

  try {
    // ------------------------------------------------ 1. apertura + lazy
    console.log('\n[1] Apertura e caricamento lazy');
    await page.goto(URL);
    await openPdf(page, path.join(FIX, 'basic.pdf'));
    check('PDF aperto, 3 pagine', (await pageCount(page)) === 3);
    await page.waitForTimeout(500);
    const lazy = (re) => requests.some((u) => re.test(u));
    check(
      'chunk editor NON caricati in sola lettura',
      !lazy(/export-/) && !lazy(/EditorLayer-/) && !lazy(/images-/) && !lazy(/FormLayer-/),
    );
    let p1 = await topPage(page);
    await waitRendered(page, p1);
    check('pagina 1 renderizzata (testo scuro presente)', near(await pixel(page, p1, 300, 300), [255, 255, 255]));
    const span = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.textLayer span')].find((e) => e.textContent.startsWith('Riga 1 della'));
      if (!el) return null;
      const p = el.closest('[data-page-id]');
      const s = Number(getComputedStyle(p).getPropertyValue('--s'));
      const r = el.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      return { x: (r.left - pr.left) / s, y: (r.top - pr.top) / s, w: r.width / s, h: r.height / s };
    });
    // la riga è disegnata a x=50, linea di base y=130, corpo 11; sul canvas è larga 342 pt
    check('livello testo selezionabile allineato alla pagina', !!span && Math.abs(span.x - 50) < 1.5 && span.y > 117 && span.y < 123 && span.w > 337 && span.w < 347, JSON.stringify(span));
    await page.waitForSelector('[data-thumb="2"] canvas');
    check('miniature renderizzate', (await page.$$('[data-thumb] canvas')).length === 3);
    await page.screenshot({ path: path.join(OUT, '01-aperto.png') });

    // ------------------------------------------------ 2. immagine + export
    console.log('\n[2] Nucleo: immagine → sposta/ridimensiona → esporta → riapri');
    await choose(page, '[data-testid=tool-image]', path.join(FIX, 'image.png'));
    await page.waitForSelector('[data-annot-type=image]');
    check('chunk immagini/editor caricati su richiesta', lazy(/images-/) && lazy(/EditorLayer-/));
    const box0 = await page.$eval('[data-annot-type=image]', (el) => ({
      l: parseFloat(el.style.left), t: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height),
    }));
    // sposta l'immagine: angolo in alto a sinistra a (60,200)pt
    p1 = await topPage(page);
    await dragOnPage(page, p1, [box0.l + box0.w / 2, box0.t + box0.h / 2], [60 + box0.w / 2, 200 + box0.h / 2]);
    let box = await page.$eval('[data-annot-type=image]', (el) => ({
      l: parseFloat(el.style.left), t: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height),
    }));
    check('immagine spostata', Math.abs(box.l - 60) < 2 && Math.abs(box.t - 200) < 2, JSON.stringify(box));
    // ridimensiona dall'angolo in basso a destra (+60pt in larghezza)
    await dragOnPage(page, p1, [box.l + box.w, box.t + box.h], [box.l + box.w + 60, box.t + box.h + 36]);
    box = await page.$eval('[data-annot-type=image]', (el) => ({
      l: parseFloat(el.style.left), t: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height),
    }));
    check('immagine ridimensionata mantenendo le proporzioni', Math.abs(box.w - 210) < 3 && Math.abs(box.w / box.h - 200 / 120) < 0.02, JSON.stringify(box));
    await page.screenshot({ path: path.join(OUT, '02-immagine.png') });
    check('pdf-lib non ancora caricato prima di esportare', !lazy(/export-/));
    const exp1 = await exportPdf(page, 'export-immagine.pdf');
    check('pdf-lib caricato all’esportazione', lazy(/export-/));
    await openPdf(page, exp1);
    check('PDF esportato riaperto, 3 pagine', (await pageCount(page)) === 3);
    p1 = await topPage(page);
    await waitRendered(page, p1);
    const inside = await pixel(page, p1, box.l + box.w / 2 + 3, box.t + box.h / 2 + 3);
    const outside = await pixel(page, p1, box.l + box.w + 15, box.t + box.h + 15);
    check('immagine presente nel PDF esportato, nella posizione giusta', isMagentaOrGreen(inside) && !isMagentaOrGreen(outside), `dentro=${inside} fuori=${outside}`);
    check('nessuna annotazione "viva" dopo la riapertura (è nel contenuto)', (await page.$$('[data-annot]')).length === 0);
    await page.screenshot({ path: path.join(OUT, '03-riaperto.png') });

    // ------------------------------------------------ 3. documento lungo
    console.log('\n[3] Documento lungo (800 pagine): virtualizzazione e scroll');
    const t0 = Date.now();
    await openPdf(page, path.join(FIX, 'long.pdf'));
    const openMs = Date.now() - t0;
    check('800 pagine aperte', (await pageCount(page)) === 800, `prima pagina visibile in ${openMs} ms`);
    const viewer = await page.$('[data-testid=viewer]');
    const vb = await viewer.boundingBox();
    await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
    await page.evaluate(() => {
      window.__frames = [];
      window.__maxPages = 0;
      let last = performance.now();
      const tick = (t) => {
        window.__frames.push(t - last);
        last = t;
        window.__maxPages = Math.max(window.__maxPages, document.querySelectorAll('[data-page-id]').length);
        if (!window.__stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    for (let i = 0; i < 150; i++) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(16);
    }
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, 6000); // scroll molto veloce
      await page.waitForTimeout(16);
    }
    const stats = await page.evaluate(() => {
      window.__stop = true;
      const f = window.__frames.slice(2).sort((a, b) => a - b);
      const q = (p) => f[Math.min(f.length - 1, Math.floor(f.length * p))];
      return {
        n: f.length,
        p50: q(0.5),
        p95: q(0.95),
        max: f[f.length - 1],
        maxPages: window.__maxPages,
        canvases: document.querySelectorAll('[data-page-id] canvas').length,
        scrollTop: document.querySelector('[data-testid=viewer]').scrollTop,
      };
    });
    const fmt = (v) => v.toFixed(1);
    check('pagine nel DOM sempre poche (virtualizzazione)', stats.maxPages <= 6, `max ${stats.maxPages} su 800`);
    check('scroll fluido', stats.p95 < 34 && stats.max < 150, `frame p50 ${fmt(stats.p50)} ms, p95 ${fmt(stats.p95)} ms, max ${fmt(stats.max)} ms su ${stats.n} frame`);
    check('lo scroll è avanzato davvero', stats.scrollTop > 100000, `scrollTop ${Math.round(stats.scrollTop)}`);
    await gotoPage(page, 800);
    let pLast = await topPage(page);
    await waitRendered(page, pLast);
    const txt = await page.$eval('[data-testid=page-input]', (el) => el.value);
    check('salto all’ultima pagina e render', txt === '800');
    await page.screenshot({ path: path.join(OUT, '04-lungo.png') });

    // zoom: Ctrl+rotella e menu
    const scaleOf = () => page.$eval('[data-page-id]', (p) => Number(getComputedStyle(p).getPropertyValue('--s')));
    const s0 = await scaleOf();
    await page.keyboard.down('Control');
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await page.waitForTimeout(300);
    const s1 = await scaleOf();
    check('zoom con Ctrl+rotella', s1 > s0 * 1.5, `${s0.toFixed(2)} → ${s1.toFixed(2)}`);
    check('la pagina corrente resta la stessa dopo lo zoom', (await page.$eval('[data-testid=page-input]', (el) => el.value)) === '800');
    await page.selectOption('[data-testid=zoom-select]', 'fit-page');
    await page.waitForTimeout(300);
    const fit = await page.$eval('[data-page-id]', (p) => p.getBoundingClientRect().height);
    check('"Adatta pagina" fa stare la pagina nella vista', fit <= vb.height, `${Math.round(fit)} px su ${Math.round(vb.height)}`);
    await page.selectOption('[data-testid=zoom-select]', 'fit-width');

    // ------------------------------------------------ 4. ricerca
    console.log('\n[4] Ricerca testo');
    await page.keyboard.press('Control+f');
    await page.fill('[data-testid=search-input]', 'ornitorinco');
    await page.waitForFunction(() => /^\d+ di 8$/.test(document.querySelector('[data-testid=search-status]')?.textContent ?? ''), null, { timeout: 30000 });
    check('8 risultati trovati su 800 pagine (pagine multiple di 97)', true, await page.$eval('[data-testid=search-status]', (e) => e.textContent));
    await page.waitForSelector('[data-hit=active]');
    check('primo risultato a pagina 97', (await page.$eval('[data-testid=page-input]', (el) => el.value)) === '97');
    await page.press('[data-testid=search-input]', 'Enter');
    await page.waitForTimeout(200);
    check('Invio → risultato successivo a pagina 194', (await page.$eval('[data-testid=page-input]', (el) => el.value)) === '194');
    const hit = await page.$eval('[data-hit=active]', (el) => ({ w: parseFloat(el.style.width), l: parseFloat(el.style.left) }));
    check('evidenziazione posizionata sulla parola', hit.w > 40 && hit.w < 75 && hit.l > 380, JSON.stringify(hit));
    await page.screenshot({ path: path.join(OUT, '05-ricerca.png') });
    await page.press('[data-testid=search-input]', 'Escape');

    // ------------------------------------------------ 5. strumenti
    console.log('\n[5] Testo, disegno, evidenziatore, rettangolo, annulla');
    await openPdf(page, path.join(FIX, 'basic.pdf'));
    p1 = await topPage(page);
    await page.click('[data-testid=tool-text]');
    let pt = await at(p1, 300, 60);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForSelector('[data-testid=text-editor]');
    await page.keyboard.type('Città: perché no?');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Seconda riga');
    pt = await at(p1, 500, 780);
    await page.mouse.click(pt.x, pt.y); // clic fuori: conferma
    await page.waitForSelector('[data-annot-type=text]');
    const textShown = await page.$eval('[data-annot-type=text]', (el) => el.textContent);
    check('casella di testo creata (accenti e a capo)', textShown === 'Città: perché no?\nSeconda riga', JSON.stringify(textShown));

    await page.click('[data-testid=tool-rect]');
    await dragOnPage(page, p1, [300, 300], [420, 360]);
    await page.click('[data-testid=tool-highlight]');
    await dragOnPage(page, p1, [45, 138], [330, 154]);
    await page.click('[data-testid=tool-draw]');
    const a0 = await at(p1, 100, 250);
    await page.mouse.move(a0.x, a0.y);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) {
      const q = await at(p1, 100 + i * 8, 250 + Math.sin(i / 3) * 25);
      await page.mouse.move(q.x, q.y);
    }
    await page.mouse.up();
    const kinds = await page.$$eval('[data-annot-type]', (els) => els.map((e) => e.dataset.annotType).sort());
    check('4 annotazioni presenti', JSON.stringify(kinds) === JSON.stringify(['highlight', 'ink', 'rect', 'text']), kinds.join(','));
    await page.click('[data-testid=undo]');
    check('annulla rimuove il disegno', (await page.$$('[data-annot-type=ink]')).length === 0);
    await page.click('[data-testid=redo]');
    check('ripristina lo rimette', (await page.$$('[data-annot-type=ink]')).length === 1);
    // sposta la casella di testo con lo strumento selezione
    await page.click('[data-testid=tool-select]');
    const tb = await page.$eval('[data-annot-type=text]', (el) => ({ l: parseFloat(el.style.left), t: parseFloat(el.style.top) }));
    await dragOnPage(page, p1, [tb.l + 10, tb.t + 8], [tb.l + 10 - 40, tb.t + 8 + 30]);
    const tb2 = await page.$eval('[data-annot-type=text]', (el) => ({ l: parseFloat(el.style.left), t: parseFloat(el.style.top) }));
    check('casella di testo spostata', Math.abs(tb2.l - (tb.l - 40)) < 2 && Math.abs(tb2.t - (tb.t + 30)) < 2);
    await page.screenshot({ path: path.join(OUT, '06-strumenti.png') });
    const beforePx = await page.screenshot({ clip: await clipOf(p1) });
    fs.writeFileSync(path.join(OUT, '06a-pagina-editor.png'), beforePx);
    const exp2 = await exportPdf(page, 'export-strumenti.pdf');
    const texts2 = await pageTexts(exp2);
    check('testo aggiunto presente nel PDF esportato', texts2[0].includes('Città: perché no?') && texts2[0].includes('Seconda riga'));
    await openPdf(page, exp2);
    p1 = await topPage(page);
    await waitRendered(page, p1);
    check('rettangolo nel PDF esportato', near(await pixel(page, p1, 300, 330), [220, 38, 38]), String(await pixel(page, p1, 300, 330)));
    check('evidenziazione nel PDF esportato (giallo su bianco)', near(await pixel(page, p1, 47, 146), [254, 243, 181], 25), String(await pixel(page, p1, 47, 146)));
    check('disegno nel PDF esportato', near(await pixel(page, p1, 100, 250), [220, 38, 38], 60), String(await pixel(page, p1, 100, 250)));
    fs.writeFileSync(path.join(OUT, '06b-pagina-esportata.png'), await page.screenshot({ clip: await clipOf(p1) }));

    // ------------------------------------------------ 6. pagine
    console.log('\n[6] Riordino, eliminazione, unione');
    await openPdf(page, path.join(FIX, 'basic.pdf'));
    await page.waitForSelector('[data-thumb="2"] canvas');
    // trascina la miniatura 3 prima della 1
    await page.dragAndDrop('[data-thumb="2"]', '[data-thumb="0"]', { targetPosition: { x: 60, y: 5 } });
    await choose(page, '[data-testid=merge]', path.join(FIX, 'other.pdf'));
    await page.waitForFunction(() => document.querySelector('[data-testid=page-count]').textContent.includes('5'));
    check('unione: 5 pagine', (await pageCount(page)) === 5);
    // elimina la pagina in posizione 2 (era la pagina 1 originale)
    await page.click('[data-thumb="1"]');
    await page.click('[data-testid=delete-pages]');
    check('eliminazione: 4 pagine', (await pageCount(page)) === 4);
    await page.screenshot({ path: path.join(OUT, '07-pagine.png') });
    const exp3 = await exportPdf(page, 'export-pagine.pdf');
    const texts3 = (await pageTexts(exp3)).map((t) => t.slice(0, 32).trim());
    const expected = ['Documento base, pagina 3', 'Documento base, pagina 2', 'Altro documento, pagina 1', 'Altro documento, pagina 2'];
    check('ordine pagine nel PDF esportato', texts3.every((t, i) => t.startsWith(expected[i])), texts3.join(' | '));
    const raw3 = fs.readFileSync(exp3).length;
    check('PDF esportato valido e compatto', raw3 > 1000 && raw3 < 20000, `${raw3} byte`);
    await page.click('[data-testid=undo]');
    check('annulla ripristina la pagina eliminata', (await pageCount(page)) === 5);

    // ------------------------------------------------ 7. moduli
    console.log('\n[7] Moduli AcroForm');
    await openPdf(page, path.join(FIX, 'form.pdf'));
    await page.waitForSelector('[data-field=nome]');
    check('chunk moduli caricato solo per PDF con campi', lazy(/FormLayer-/));
    await page.fill('[data-field=nome]', 'Mario Rossi');
    await page.fill('[data-field=note]', 'Prima riga\nSeconda riga');
    await page.check('[data-field=accetto]');
    await page.check('[data-field=colore][data-on=blu]');
    await page.selectOption('[data-field=paese]', 'Spagna');
    await page.screenshot({ path: path.join(OUT, '08-modulo.png') });
    const exp4 = await exportPdf(page, 'export-modulo.pdf');
    const { PDFDocument } = await import('pdf-lib');
    const filled = (await PDFDocument.load(fs.readFileSync(exp4))).getForm();
    const got = {
      nome: filled.getTextField('nome').getText(),
      note: filled.getTextField('note').getText(),
      accetto: filled.getCheckBox('accetto').isChecked(),
      colore: filled.getRadioGroup('colore').getSelected(),
      paese: filled.getDropdown('paese').getSelected()[0],
    };
    check(
      'valori del modulo salvati nel PDF (campi ancora compilabili)',
      got.nome === 'Mario Rossi' && got.note === 'Prima riga\nSeconda riga' && got.accetto === true && got.colore === 'blu' && got.paese === 'Spagna',
      JSON.stringify(got),
    );
    await openPdf(page, exp4);
    await page.waitForSelector('[data-field=nome]');
    check('riaprendo il PDF esportato i campi mostrano i valori', (await page.inputValue('[data-field=nome]')) === 'Mario Rossi' && (await page.isChecked('[data-field=accetto]')) && (await page.inputValue('[data-field=paese]')) === 'Spagna');
    // modulo + riordino → appiattimento
    await page.waitForSelector('[data-thumb="1"] canvas');
    await page.dragAndDrop('[data-thumb="1"]', '[data-thumb="0"]', { targetPosition: { x: 60, y: 5 } });
    const exp5 = await exportPdf(page, 'export-modulo-riordinato.pdf');
    const flat = await PDFDocument.load(fs.readFileSync(exp5));
    const texts5 = await pageTexts(exp5);
    check('modulo con pagine riordinate: campi appiattiti, valori visibili', flat.getForm().getFields().length === 0 && texts5[1].includes('Mario Rossi') && texts5[0].includes('Seconda pagina'), `campi=${flat.getForm().getFields().length}`);

    // ------------------------------------------------ 8. pagina ruotata + drop
    console.log('\n[8] Pagina ruotata con CropBox, drag&drop di immagine');
    await openPdf(page, path.join(FIX, 'rotated.pdf'));
    p1 = await topPage(page);
    await waitRendered(page, p1);
    const size = await p1.evaluate((p) => {
      const s = Number(getComputedStyle(p).getPropertyValue('--s'));
      const r = p.getBoundingClientRect();
      return [Math.round(r.width / s), Math.round(r.height / s)];
    });
    check('pagina ruotata mostrata in orizzontale (782×555)', size[0] === 782 && size[1] === 555, size.join('×'));
    // drag&drop simulato di un file immagine sulla pagina, nel punto (500, 300)
    const dropAt = await at(p1, 500, 300);
    const b64 = fs.readFileSync(path.join(FIX, 'image.png')).toString('base64');
    await page.evaluate(
      async ([x, y, data]) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
        const target = document.elementFromPoint(x, y);
        for (const type of ['dragover', 'drop']) {
          target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
        }
      },
      [dropAt.x, dropAt.y, b64],
    );
    await page.waitForSelector('[data-annot-type=image]');
    const db = await page.$eval('[data-annot-type=image]', (el) => ({
      l: parseFloat(el.style.left), t: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height),
    }));
    check('immagine rilasciata centrata sul punto di drop', Math.abs(db.l + db.w / 2 - 500) < 2 && Math.abs(db.t + db.h / 2 - 300) < 2, JSON.stringify(db));
    await page.click('[data-testid=tool-rect]');
    await dragOnPage(page, p1, [100, 100], [200, 160]);
    await page.click('[data-testid=tool-select]');
    await page.click('[data-annot-type=rect]', { position: { x: 1, y: 20 } });
    await page.keyboard.press('Delete');
    check('Canc elimina l’annotazione selezionata', (await page.$$('[data-annot-type=rect]')).length === 0);
    await page.keyboard.press('Control+z');
    check('Ctrl+Z la ripristina', (await page.$$('[data-annot-type=rect]')).length === 1);
    const exp6 = await exportPdf(page, 'export-ruotato.pdf');
    await openPdf(page, exp6);
    p1 = await topPage(page);
    await waitRendered(page, p1);
    check('su pagina ruotata l’immagine esportata è nel punto giusto', isMagentaOrGreen(await pixel(page, p1, 500, 300)) && !isMagentaOrGreen(await pixel(page, p1, db.l - 10, 300)), String(await pixel(page, p1, 500, 300)));
    check('su pagina ruotata il rettangolo esportato è nel punto giusto', near(await pixel(page, p1, 100, 130), [220, 38, 38]) && near(await pixel(page, p1, 150, 130), [255, 255, 255]), String(await pixel(page, p1, 100, 130)));
    fs.writeFileSync(path.join(OUT, '09-ruotato-esportato.png'), await page.screenshot({ clip: await clipOf(p1) }));

    check('nessun errore JavaScript in console', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${results.length - failures}/${results.length} controlli superati`);
  process.exit(failures ? 1 : 0);
}

async function clipOf(el) {
  const b = await el.boundingBox();
  const y = Math.max(b.y, 0);
  return { x: b.x, y, width: b.width, height: Math.min(b.height, 800 - y) };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
