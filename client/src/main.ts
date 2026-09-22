import './style.css';
import { LobbyView } from './app/LobbyView';
import { HideView } from './app/HideView';
import { SeekView } from './app/SeekView';
import { ResultsView } from './app/ResultsView';

const app = document.getElementById('app')!;

app.innerHTML = `<h1>GeoHideNSeek</h1><div id="view"></div>`;
const view = document.getElementById('view')!;
view.appendChild(LobbyView());
// Round views land in later plan steps — stubs stay mounted until then.
view.appendChild(HideView());
view.appendChild(SeekView());
view.appendChild(ResultsView());
