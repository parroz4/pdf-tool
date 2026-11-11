import { useEffect, useRef, useState } from 'react';
import { EMPTY_SEARCH, setState, useStore } from '../state/store';
import { Icon } from '../ui/Icon';
import { cancelSearch, runSearch, stepSearch } from './search';

export default function SearchBar() {
  const search = useStore((s) => s.search);
  const [text, setText] = useState(search.query);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  // Ricerca "mentre scrivi", con un piccolo ritardo.
  useEffect(() => {
    const t = setTimeout(() => void runSearch(text), 220);
    return () => clearTimeout(t);
  }, [text]);

  const close = (): void => {
    cancelSearch();
    setState({ searchOpen: false, search: EMPTY_SEARCH });
  };

  const status = !search.query
    ? ''
    : search.total > 0
      ? `${search.active + 1} di ${search.total}${search.running ? '…' : ''}`
      : search.running
        ? 'Ricerca…'
        : 'Nessun risultato';

  return (
    <div
      data-testid="searchbar"
      className="absolute top-2 right-6 z-20 flex items-center gap-1 rounded-md border border-zinc-300 bg-white p-1 shadow-lg dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
    >
      <input
        ref={input}
        data-testid="search-input"
        aria-label="Cerca nel documento"
        placeholder="Cerca nel documento"
        className="h-7 w-52 rounded border border-zinc-300 bg-white px-2 dark:border-zinc-600 dark:bg-zinc-900"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            stepSearch(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
        }}
      />
      <span data-testid="search-status" className="min-w-20 px-1 text-center text-zinc-500 dark:text-zinc-400">
        {status}
      </span>
      <button
        type="button"
        title="Risultato precedente (Maiusc+Invio)"
        aria-label="Risultato precedente"
        className="rounded p-1 hover:bg-zinc-200 dark:hover:bg-zinc-700"
        onClick={() => stepSearch(-1)}
      >
        <Icon name="prev" size={16} />
      </button>
      <button
        type="button"
        title="Risultato successivo (Invio)"
        aria-label="Risultato successivo"
        className="rounded p-1 hover:bg-zinc-200 dark:hover:bg-zinc-700"
        onClick={() => stepSearch(1)}
      >
        <Icon name="next" size={16} />
      </button>
      <button
        type="button"
        title="Chiudi (Esc)"
        aria-label="Chiudi ricerca"
        className="rounded p-1 hover:bg-zinc-200 dark:hover:bg-zinc-700"
        onClick={close}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
