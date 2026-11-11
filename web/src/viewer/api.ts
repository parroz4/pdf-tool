// Comandi imperativi verso il viewer (registrati dal componente Viewer).
export interface ViewerApi {
  scrollToPage: (index: number) => void;
  scrollToMatch: (pageId: string, y: number) => void;
  /** Zoom moltiplicativo ancorato al centro della vista. */
  zoomBy: (factor: number) => void;
  /** Punto (in punti pagina) al centro della parte visibile della pagina. */
  visibleCenter: (pageId: string) => { x: number; y: number } | null;
}

export const viewerApi: ViewerApi = {
  scrollToPage: () => {},
  scrollToMatch: () => {},
  zoomBy: () => {},
  visibleCenter: () => null,
};

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;
/** px CSS per punto PDF al 100%. */
export const PT_TO_PX = 96 / 72;
