import { getSocket } from '../socket';

interface RoundResults {
  reason: string;
  roundNo: number;
  guesses: Array<{
    seekerId: string;
    targetHiderId: string;
    targetName: string;
    distanceKm: number;
    points: number;
    tier: string;
  }>;
  survival: Array<{ playerId: string; name: string; points: number }>;
  totals: Array<{ playerId: string; name: string; score: number }>;
}

const REASON_LABEL: Record<string, string> = {
  timeout: 'Seeking time expired — scored as-is.',
  'seeker-timeout': 'Seeker disconnected — scored as-is.',
  'owner-ended': 'Round ended early by the owner.',
  'all-guessed': 'All hiders guessed — scored.',
};

/** ResultsView: per-guess distance/points + survival awards + running totals. */
export function ResultsView(): HTMLElement {
  const socket = getSocket();
  const el = document.createElement('section');
  el.hidden = true;

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  }

  el.innerHTML = `
    <div class="card">
      <h2 data-r="title">Round results</h2>
      <p class="hint" data-r="reason"></p>
      <h3>Guesses</h3>
      <ul class="players" data-r="guesses"></ul>
      <h3>Totals</h3>
      <ul class="players" data-r="totals"></ul>
      <div class="row" style="margin-top:12px">
        <button data-act="dismiss" class="secondary">Back to lobby</button>
      </div>
    </div>`;

  const q = <T extends HTMLElement = HTMLElement>(sel: string): T => el.querySelector(sel) as T;

  function show(roomCode: string, results: RoundResults) {
    void roomCode;
    el.hidden = false;
    q('[data-r="title"]').textContent = `Round ${results.roundNo} results`;
    q('[data-r="reason"]').textContent = REASON_LABEL[results.reason] ?? results.reason;
    const guessesUl = q('[data-r="guesses"]');
    guessesUl.innerHTML = '';
    if (results.guesses.length === 0) {
      guessesUl.innerHTML = '<li><span class="hint">No guesses locked.</span></li>';
    }
    for (const g of results.guesses) {
      const li = document.createElement('li');
      li.innerHTML =
        `<strong>${escapeHtml(g.targetName)}</strong> ` +
        `<span class="badge">${escapeHtml(g.tier)}</span> ` +
        `<span class="hint">${g.distanceKm.toFixed(2)} km</span> ` +
        `<span class="hint">${g.points} pts</span>`;
      guessesUl.appendChild(li);
    }
    for (const s of results.survival) {
      const li = document.createElement('li');
      li.innerHTML =
        `<strong>${escapeHtml(s.name)}</strong> ` +
        `<span class="badge">unfound</span> ` +
        `<span class="hint">+${s.points} pts survival</span>`;
      guessesUl.appendChild(li);
    }
    const totalsUl = q('[data-r="totals"]');
    totalsUl.innerHTML = '';
    for (const t of results.totals) {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${escapeHtml(t.name)}</strong> <span class="hint">${t.score} pts</span>`;
      totalsUl.appendChild(li);
    }
  }

  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-act="dismiss"]');
    if (btn) el.hidden = true;
  });

  socket.on(
    'round:ended',
    (payload: { roomCode: string; results: RoundResults }) => {
      if (!payload.results) return;
      show(payload.roomCode, payload.results);
    },
  );
  socket.on('hiding:started', () => {
    el.hidden = true;
  });

  return el;
}
