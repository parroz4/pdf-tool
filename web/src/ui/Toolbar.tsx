import { useEffect, useState } from 'react';
import {
  exportPdf,
  handleFiles,
  IMAGE_ACCEPT,
  mergeFiles,
  PDF_ACCEPT,
  pickFiles,
  runOcr,
} from '../state/actions';
import {
  checkpoint,
  findAnnot,
  redo,
  removeAnnot,
  setState,
  setTool,
  undo,
  updateAnnot,
  useStore,
  type Annot,
  type Tool,
} from '../state/store';
import { PT_TO_PX, viewerApi } from '../viewer/api';
import { Icon, type IconName } from './Icon';

const btn =
  'inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded px-1.5 text-zinc-700 ' +
  'hover:bg-zinc-200 disabled:opacity-35 disabled:hover:bg-transparent ' +
  'dark:text-zinc-200 dark:hover:bg-zinc-700';
const btnOn = 'bg-blue-100 text-blue-700 hover:bg-blue-100 dark:bg-blue-900 dark:text-blue-100';
const sep = <span className="mx-1 h-5 w-px shrink-0 bg-zinc-300 dark:bg-zinc-600" />;

function Btn(props: {
  icon: IconName;
  title: string;
  label?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  testid?: string;
}) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active}
      disabled={props.disabled}
      data-testid={props.testid}
      className={`${btn} ${props.active ? btnOn : ''}`}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
      {props.label && <span className="hidden pr-1 lg:inline">{props.label}</span>}
    </button>
  );
}

const TOOLS: { tool: Tool; icon: IconName; title: string }[] = [
  { tool: 'select', icon: 'cursor', title: 'Seleziona / sposta (Esc)' },
  { tool: 'text', icon: 'text', title: 'Casella di testo: clicca sulla pagina' },
  { tool: 'draw', icon: 'draw', title: 'Disegno a mano libera' },
  { tool: 'highlight', icon: 'highlight', title: 'Evidenziatore: trascina sull’area' },
  { tool: 'rect', icon: 'rect', title: 'Rettangolo: trascina sulla pagina' },
];

const COLORS = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#f59e0b'];
const HL_COLORS = ['#fde047', '#86efac', '#7dd3fc', '#f9a8d4'];
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function PageBox() {
  const current = useStore((s) => s.currentPage);
  const total = useStore((s) => s.pages.length);
  const [text, setText] = useState('');
  useEffect(() => setText(String(current + 1)), [current]);
  const go = (): void => {
    const n = Math.round(Number(text));
    if (Number.isFinite(n) && n >= 1 && n <= total) viewerApi.scrollToPage(n - 1);
    else setText(String(current + 1));
  };
  return (
    <span className="flex items-center gap-1 whitespace-nowrap text-zinc-600 dark:text-zinc-300">
      <input
        aria-label="Numero di pagina"
        data-testid="page-input"
        className="h-7 w-12 rounded border border-zinc-300 bg-white px-1 text-center dark:border-zinc-600 dark:bg-zinc-800"
        value={text}
        inputMode="numeric"
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={go}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      <span data-testid="page-count">/ {total}</span>
    </span>
  );
}

function ZoomBox() {
  const mode = useStore((s) => s.zoomMode);
  const scale = useStore((s) => s.scale);
  const pct = Math.round((scale / PT_TO_PX) * 100);
  return (
    <>
      <Btn icon="minus" title="Riduci (Ctrl+-)" onClick={() => viewerApi.zoomBy(1 / 1.2)} />
      <select
        aria-label="Zoom"
        data-testid="zoom-select"
        className="h-7 rounded border border-zinc-300 bg-white px-1 dark:border-zinc-600 dark:bg-zinc-800"
        value={mode === 'custom' ? 'custom' : mode}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'fit-width' || v === 'fit-page') setState({ zoomMode: v });
          else if (v !== 'custom') setState({ zoomMode: 'custom', zoom: Number(v) });
        }}
      >
        <option value="custom">{pct}%</option>
        <option value="fit-width">Adatta larghezza{mode === 'fit-width' ? ` (${pct}%)` : ''}</option>
        <option value="fit-page">Adatta pagina{mode === 'fit-page' ? ` (${pct}%)` : ''}</option>
        {ZOOMS.map((z) => (
          <option key={z} value={z}>
            {z * 100}%
          </option>
        ))}
      </select>
      <Btn icon="plus" title="Ingrandisci (Ctrl++)" onClick={() => viewerApi.zoomBy(1.2)} />
    </>
  );
}

function Swatches(props: { colors: string[]; value: string; onPick: (c: string) => void }) {
  return (
    <span className="flex items-center gap-1">
      {props.colors.map((c) => (
        <button
          key={c}
          type="button"
          title={`Colore ${c}`}
          aria-label={`Colore ${c}`}
          aria-pressed={props.value === c}
          className={`h-5 w-5 rounded-full border ${
            props.value === c ? 'ring-2 ring-blue-500 ring-offset-1' : 'border-zinc-400'
          }`}
          style={{ background: c }}
          onClick={() => props.onPick(c)}
        />
      ))}
    </span>
  );
}

/** Barra contestuale: opzioni dello strumento attivo o dell'elemento selezionato. */
function Options() {
  const tool = useStore((s) => s.tool);
  const style = useStore((s) => s.style);
  const selected = useStore((s) => s.selected);
  const annot = useStore((s) => (s.selected ? findAnnot(s.selected) : undefined));

  const kind: Annot['type'] | null = annot
    ? annot.type
    : tool === 'draw'
      ? 'ink'
      : tool === 'select'
        ? null
        : tool;
  if (!kind) return null;

  const patch = (p: Partial<Annot>, s: Partial<typeof style>): void => {
    setState({ style: { ...style, ...s } });
    if (annot && selected) {
      checkpoint();
      updateAnnot(selected.pageId, annot.id, p);
    }
  };
  const color = annot && 'color' in annot ? annot.color : kind === 'highlight' ? style.hlColor : style.color;
  const width = annot && 'width' in annot ? annot.width : style.width;
  const size = annot && annot.type === 'text' ? annot.size : style.size;
  const label = {
    text: 'Testo',
    ink: 'Disegno',
    highlight: 'Evidenziatore',
    rect: 'Rettangolo',
    image: 'Immagine',
  }[kind];

  return (
    <div
      data-testid="options"
      className="flex h-9 items-center gap-3 border-b border-zinc-300 bg-zinc-100 px-3 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
    >
      <span className="font-medium">{label}</span>
      {kind === 'highlight' && (
        <Swatches colors={HL_COLORS} value={color} onPick={(c) => patch({ color: c }, { hlColor: c })} />
      )}
      {(kind === 'text' || kind === 'ink' || kind === 'rect') && (
        <Swatches colors={COLORS} value={color} onPick={(c) => patch({ color: c }, { color: c })} />
      )}
      {(kind === 'ink' || kind === 'rect') && (
        <label className="flex items-center gap-1.5">
          Spessore
          <input
            type="range"
            min={0.5}
            max={12}
            step={0.5}
            value={width}
            onChange={(e) => {
              const v = Number(e.target.value);
              patch({ width: v }, { width: v });
            }}
          />
          <span className="w-8 tabular-nums">{width}</span>
        </label>
      )}
      {kind === 'text' && (
        <label className="flex items-center gap-1.5">
          Dimensione
          <input
            type="number"
            data-testid="font-size"
            className="h-6 w-14 rounded border border-zinc-300 bg-white px-1 dark:border-zinc-600 dark:bg-zinc-800"
            min={4}
            max={200}
            value={size}
            onChange={(e) => {
              const v = Math.min(200, Math.max(4, Number(e.target.value) || 4));
              patch({ size: v }, { size: v });
            }}
          />
        </label>
      )}
      {kind === 'image' && <span className="text-zinc-500">Trascina per spostare, maniglie per ridimensionare</span>}
      {annot && selected && (
        <button
          type="button"
          data-testid="delete-annot"
          className={`${btn} ml-auto text-red-600 dark:text-red-400`}
          onClick={() => {
            checkpoint();
            removeAnnot(selected.pageId, annot.id);
          }}
        >
          <Icon name="trash" size={16} /> Elimina
        </button>
      )}
    </div>
  );
}

export function Toolbar() {
  const hasDoc = useStore((s) => s.pages.length > 0);
  const tool = useStore((s) => s.tool);
  const sidebar = useStore((s) => s.sidebar);
  const searchOpen = useStore((s) => s.searchOpen);
  const canUndo = useStore((s) => s.undo.length > 0);
  const canRedo = useStore((s) => s.redo.length > 0);
  const current = useStore((s) => s.currentPage);
  const total = useStore((s) => s.pages.length);
  const busy = useStore((s) => s.busy !== null);

  return (
    <header className="shrink-0 select-none">
      <div className="flex h-11 items-center gap-0.5 overflow-x-auto border-b border-zinc-300 bg-zinc-50 px-2 dark:border-zinc-700 dark:bg-zinc-900">
        <Btn
          icon="open"
          title="Apri PDF (Ctrl+O)"
          label="Apri"
          testid="open"
          onClick={() => void pickFiles(PDF_ACCEPT, false).then((f) => handleFiles(f))}
        />
        {hasDoc && (
          <>
            <Btn
              icon="merge"
              title="Unisci altri PDF in fondo al documento"
              label="Unisci"
              testid="merge"
              onClick={() => void pickFiles(PDF_ACCEPT, true).then((f) => mergeFiles(f))}
            />
            {sep}
            <Btn
              icon="sidebar"
              title="Miniature (F4)"
              active={sidebar}
              onClick={() => setState({ sidebar: !sidebar })}
            />
            <Btn
              icon="prev"
              title="Pagina precedente"
              disabled={current <= 0}
              onClick={() => viewerApi.scrollToPage(current - 1)}
            />
            <Btn
              icon="next"
              title="Pagina successiva"
              disabled={current >= total - 1}
              onClick={() => viewerApi.scrollToPage(current + 1)}
            />
            <PageBox />
            {sep}
            <ZoomBox />
            <Btn
              icon="search"
              title="Cerca (Ctrl+F)"
              active={searchOpen}
              testid="search-toggle"
              onClick={() => setState({ searchOpen: !searchOpen })}
            />
            {sep}
            {TOOLS.map((t) => (
              <Btn
                key={t.tool}
                icon={t.icon}
                title={t.title}
                active={tool === t.tool}
                testid={`tool-${t.tool}`}
                onClick={() => setTool(t.tool)}
              />
            ))}
            <Btn
              icon="image"
              title="Inserisci immagine (o trascinala sulla pagina)"
              testid="tool-image"
              onClick={() => void pickFiles(IMAGE_ACCEPT, true).then((f) => handleFiles(f))}
            />
            <button
              type="button"
              data-testid="ocr"
              disabled={busy}
              title="OCR: riconosce il testo della pagina corrente (Maiusc+clic: tutte le pagine)"
              aria-label="OCR: riconosci il testo"
              className={btn}
              onClick={(e) => void runOcr(e.shiftKey)}
            >
              <Icon name="ocr" />
              <span className="pr-1">OCR</span>
            </button>
            {sep}
            <Btn icon="undo" title="Annulla (Ctrl+Z)" disabled={!canUndo} testid="undo" onClick={undo} />
            <Btn icon="redo" title="Ripristina (Ctrl+Y)" disabled={!canRedo} testid="redo" onClick={redo} />
            <span className="flex-1" />
            <button
              type="button"
              data-testid="export"
              disabled={busy}
              title="Esporta il PDF modificato (Ctrl+S)"
              className="ml-2 inline-flex h-8 shrink-0 items-center gap-1.5 rounded bg-blue-600 px-3 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              onClick={() => void exportPdf()}
            >
              <Icon name="download" size={16} /> Esporta PDF
            </button>
          </>
        )}
      </div>
      {hasDoc && <Options />}
    </header>
  );
}
