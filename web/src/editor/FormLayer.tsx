// Compilazione dei moduli AcroForm (chunk lazy, caricato solo per i PDF che
// hanno campi): i widget diventano controlli HTML sovrapposti alla pagina.
import { useEffect, useRef, useState } from 'react';
import { getPage } from '../pdf/pdfjs';
import {
  checkpoint,
  setFormValue,
  useStore,
  type FormValue,
  type PageRef,
  type Source,
} from '../state/store';

interface Widget {
  id: string;
  name: string;
  kind: 'text' | 'checkbox' | 'radio' | 'select' | 'list';
  x: number;
  y: number;
  w: number;
  h: number;
  initial: FormValue;
  /** Valore "acceso" di caselle e pulsanti radio. */
  on: string;
  options: string[];
  multiline: boolean;
  password: boolean;
  maxLen: number;
  readOnly: boolean;
  fontSize: number;
}

const cache = new Map<string, Promise<Widget[]>>();

function loadWidgets(src: Source, index: number): Promise<Widget[]> {
  const k = `${src.id}:${index}`;
  let p = cache.get(k);
  if (!p) {
    p = (async () => {
      const page = await getPage(src, index);
      const viewport = page.getViewport({ scale: 1 });
      const out: Widget[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const annotations: any[] = await page.getAnnotations({ intent: 'display' });
      for (const a of annotations) {
        if (a.subtype !== 'Widget' || a.hidden || !a.fieldName || !a.rect) continue;
        const [x0, y0] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
        const [x1, y1] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
        const base = {
          id: String(a.id),
          name: String(a.fieldName),
          x: Math.min(x0, x1),
          y: Math.min(y0, y1),
          w: Math.abs(x1 - x0),
          h: Math.abs(y1 - y0),
          on: '',
          options: [] as string[],
          multiline: !!a.multiLine,
          password: !!a.password,
          maxLen: typeof a.maxLen === 'number' && a.maxLen > 0 ? a.maxLen : 0,
          readOnly: !!a.readOnly,
          fontSize: Number(a.defaultAppearanceData?.fontSize) || 0,
        };
        if (a.fieldType === 'Tx') {
          out.push({ ...base, kind: 'text', initial: String(a.fieldValue ?? '') });
        } else if (a.fieldType === 'Btn' && a.checkBox) {
          out.push({
            ...base,
            kind: 'checkbox',
            on: String(a.exportValue ?? 'Yes'),
            initial: String(a.fieldValue ?? 'Off'),
          });
        } else if (a.fieldType === 'Btn' && a.radioButton) {
          out.push({
            ...base,
            kind: 'radio',
            on: String(a.buttonValue ?? ''),
            initial: String(a.fieldValue ?? ''),
          });
        } else if (a.fieldType === 'Ch') {
          // pdf-lib seleziona le opzioni per testo visualizzato: si usa quello.
          const opts: { exportValue: string; displayValue: string }[] = a.options ?? [];
          const display = (v: unknown): string =>
            opts.find((o) => o.exportValue === v)?.displayValue ?? String(v ?? '');
          const values: string[] = (Array.isArray(a.fieldValue) ? a.fieldValue : [a.fieldValue])
            .filter((v: unknown) => v !== null && v !== undefined && v !== '')
            .map(display);
          const multi = !a.combo;
          out.push({
            ...base,
            kind: multi ? 'list' : 'select',
            options: opts.map((o) => o.displayValue),
            initial: multi ? values : (values[0] ?? ''),
          });
        }
      }
      return out;
    })();
    cache.set(k, p);
  }
  return p;
}

const fieldClass =
  'pointer-events-auto absolute m-0 box-border border border-blue-300/80 bg-blue-100/60 p-0 text-black ' +
  'outline-none focus:border-blue-600 focus:bg-white disabled:opacity-60';

function Field({ w, srcId }: { w: Widget; srcId: string }) {
  const stored = useStore((s) => s.forms[srcId]?.[w.name]);
  const value = stored ?? w.initial;
  const touched = useRef(false);

  /** Un passo di annulla per ogni "sessione" di modifica di un campo. */
  const change = (v: FormValue, discrete: boolean): void => {
    if (discrete || !touched.current) {
      touched.current = true;
      checkpoint();
    }
    setFormValue(srcId, w.name, v);
  };
  const box = { left: w.x, top: w.y, width: w.w, height: w.h };
  // La dimensione dichiarata dal PDF vale solo se sta nel campo.
  const fontSize = w.multiline
    ? Math.min(w.fontSize || 11, 14)
    : Math.min(w.fontSize || 12, Math.max(6, w.h * 0.7));
  const common = {
    'data-field': w.name,
    'aria-label': w.name,
    disabled: w.readOnly,
    onFocus: () => {
      touched.current = false;
    },
  };

  switch (w.kind) {
    case 'text':
      return w.multiline ? (
        <textarea
          {...common}
          className={`${fieldClass} resize-none`}
          style={{ ...box, fontSize, lineHeight: 1.15, padding: '1px 2px' }}
          value={String(value)}
          maxLength={w.maxLen || undefined}
          onChange={(e) => change(e.target.value, false)}
        />
      ) : (
        <input
          {...common}
          type={w.password ? 'password' : 'text'}
          className={fieldClass}
          style={{ ...box, fontSize, padding: '0 2px' }}
          value={String(value)}
          maxLength={w.maxLen || undefined}
          onChange={(e) => change(e.target.value, false)}
        />
      );
    case 'checkbox':
      return (
        <input
          {...common}
          type="checkbox"
          className="pointer-events-auto absolute m-0 cursor-pointer accent-blue-600"
          style={box}
          checked={value === w.on}
          onChange={(e) => change(e.target.checked ? w.on : 'Off', true)}
        />
      );
    case 'radio':
      return (
        <input
          {...common}
          type="radio"
          name={`${srcId}:${w.name}`}
          data-on={w.on}
          className="pointer-events-auto absolute m-0 cursor-pointer accent-blue-600"
          style={box}
          checked={value === w.on}
          onChange={() => change(w.on, true)}
        />
      );
    case 'select':
      return (
        <select
          {...common}
          className={fieldClass}
          style={{ ...box, fontSize }}
          value={String(value)}
          onChange={(e) => change(e.target.value, true)}
        >
          {!w.options.includes(String(value)) && <option value={String(value)}>{String(value)}</option>}
          {w.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case 'list':
      return (
        <select
          {...common}
          multiple
          className={fieldClass}
          style={{ ...box, fontSize }}
          value={Array.isArray(value) ? value : [value]}
          onChange={(e) =>
            change(
              Array.from(e.target.selectedOptions, (o) => o.value),
              true,
            )
          }
        >
          {w.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
  }
}

export default function FormLayer({ page, src }: { page: PageRef; src: Source }) {
  const [widgets, setWidgets] = useState<Widget[]>([]);
  useEffect(() => {
    let alive = true;
    loadWidgets(src, page.index).then(
      (w) => alive && setWidgets(w),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [src, page.index]);

  return (
    <>
      {widgets.map((w) => (
        <Field key={w.id} w={w} srcId={src.id} />
      ))}
    </>
  );
}
