// Icone inline (tratto 24×24): nessuna libreria di icone nel bundle.
const PATHS = {
  open: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  merge: 'M8 4H5v16h3M16 4h3v16h-3M12 8v8M8 12h8',
  sidebar: 'M4 5h16v14H4zM9 5v14',
  prev: 'M6 15l6-6 6 6',
  next: 'M6 9l6 6 6-6',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  cursor: 'M6 3l12 9-6 1.5L9.5 20z',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  draw: 'M4 20l1-5L16 4l4 4L9 19zM14 6l4 4',
  highlight: 'M9 14l-3 3v3h3l3-3M9 14l8-9 4 4-9 8zM3 21h8',
  rect: 'M4 6h16v12H4z',
  undo: 'M9 7L4 12l5 5M4 12h10a6 6 0 0 1 0 12h-2',
  redo: 'M15 7l5 5-5 5M20 12H10a6 6 0 0 0 0 12h2',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  close: 'M6 6l12 12M18 6L6 18',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const clip = name === 'undo' || name === 'redo';
  return (
    <svg
      width={size}
      height={size}
      viewBox={clip ? '0 0 24 20' : '0 0 24 24'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
