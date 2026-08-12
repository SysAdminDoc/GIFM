import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { setPseudoLocale } from './strings';
import './styles.css';

setPseudoLocale(new URLSearchParams(window.location.search).get('locale') === 'pseudo');

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
