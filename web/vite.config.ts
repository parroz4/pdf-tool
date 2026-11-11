import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Percorsi relativi: la build funziona da qualunque sottocartella
  // (es. GitHub Pages) senza configurazione.
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
    // Il chunk principale contiene pdf.js (~460 kB minificato), che non è
    // ulteriormente divisibile; editor e pdf-lib sono già chunk lazy.
    chunkSizeWarningLimit: 800,
  },
});
