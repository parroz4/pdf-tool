// Integrazione con l'app desktop (Electron): se la pagina gira nel guscio
// desktop, apre i PDF che arrivano dal sistema (doppio clic su un file,
// "Apri con"). Nel browser non fa nulla.
import { openFile } from './state/actions';

interface DesktopFile {
  name: string;
  data: Uint8Array;
}
interface DesktopBridge {
  initialFile: () => Promise<DesktopFile | null>;
  onOpenFile: (callback: (file: DesktopFile) => void) => void;
}

export function initDesktop(): void {
  const bridge = (window as { pdfToolDesktop?: DesktopBridge }).pdfToolDesktop;
  if (!bridge) return;
  const open = (f: DesktopFile | null): void => {
    if (!f) return;
    void openFile(new File([f.data as BlobPart], f.name, { type: 'application/pdf' }));
  };
  bridge.onOpenFile(open);
  void bridge.initialFile().then(open, () => {});
}
