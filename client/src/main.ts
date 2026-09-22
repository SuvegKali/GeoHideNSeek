import './style.css';
import { LobbyView } from './app/LobbyView';
import { HideView } from './app/HideView';
import { SeekView } from './app/SeekView';
import { ResultsView } from './app/ResultsView';

const app = document.getElementById('app')!;

app.innerHTML = `
  <header class="brand">
    <svg class="brand-mark" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="2"/>
      <path d="M24 7 L28.5 24 L24 41 L19.5 24 Z" fill="currentColor"/>
      <path d="M7 24 L24 19.5 L41 24 L24 28.5 Z" fill="currentColor" opacity="0.4"/>
      <circle cx="24" cy="24" r="2.6" fill="currentColor"/>
    </svg>
    <div>
      <h1>GeoHideNSeek</h1>
      <p class="tagline">Hide anywhere &middot; Seek everywhere</p>
    </div>
  </header>
  <div id="view"></div>`;
const view = document.getElementById('view')!;
view.appendChild(LobbyView());
// Round views land in later plan steps — stubs stay mounted until then.
view.appendChild(HideView());
view.appendChild(SeekView());
view.appendChild(ResultsView());
