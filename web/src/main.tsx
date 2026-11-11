import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initDesktop } from './desktop';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

initDesktop();
