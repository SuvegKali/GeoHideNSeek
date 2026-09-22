# GeoHideNSeek v1 Spec

## Problem Statement
Casual friend groups and map enthusiasts want a social geography game where the challenge comes from outsmarting each other, not from a random drop. GeoGuessr proves panoramas are fun, but the location is random. Create GeoHideNSeek to let one player (or team) hide anywhere on a real-world map and a seeker track them down from their panoramic view. Success for v1 is a locally runnable multiplayer MVP: create room with code → hide with timer → seek with timer → score → repeat with a persistent scoreboard.

## Acceptance Criteria
- **Rooms:** When an owner creates a room, the system shall generate a 6-char room code and owner-configurable settings. When a player joins with code + display name, the system shall add them without login. Support max 10 players per room.
- **Modes:** When a game starts, the system shall support Classic (1 seeker vs 2-9 hiders), 1v1 (1 vs 1), Teams (N seekers vs M hiders, teams assigned by owner).
- **Seeker assignment:** When a round starts, the system shall assign seeker randomly or by owner pick. The system shall never assign a disconnected player as seeker.
- **Map selection:** When the owner selects a region, the system shall restrict choices to regions with verified Street View coverage (World / Continent / Country / City preset). Reject custom regions without coverage.
- **Hiding:** When the hiding phase starts, the system shall show hiders a zoomable map + timer + `Check Street View` + `Lock Hide`. The system shall allow Lock only if Street View panorama exists within 50m of the pin. The pin shall freeze at timer end. When a hider fails to lock, the system shall grant 10s overtime, then exclude that hider from the round.
- **Hider visibility:** When hiders pick spots, the system shall show anonymized teammate pins to other hiders to avoid duplicates.
- **Seeking:** When the seeking phase starts, the system shall show the seeker a hider list. When the seeker clicks a hider, the system shall show that hider's locked panorama (interactive pan/zoom, no movement). The system shall allow the seeker to place/check a map pin + `Check Street View` + `Lock Guess` per hider until time expires or all hiders are guessed.
- **Found / scoring:** When a guess locks, the system shall compute haversine distance and award points using `config/scoring.ts` thresholds. Use these defaults (tune later):
  - World: Found ≤10km (1000 pts), Partial ≤50km (scaled 100-999), Miss >50km (0)
  - Continent: Found ≤5km, Partial ≤25km
  - Country: Found ≤2km, Partial ≤10km
  - City: Found ≤0.5km, Partial ≤2km
  When a hider remains unfound at round end, the system shall award that hider 500 pts. When a seeker finds a hider, the system shall add `bonusTimeSec` (default 30s) to the seeking clock.
- **Seeker visibility:** During seeking, the system shall broadcast the seeker's currently viewed hider ID and guess-pin region to hiders (spectate mode).
- **Timers:** When hiding or seeking time expires, the system shall auto-lock state and score the round as-is. When the seeker disconnects, the system shall pause 30s, then end the round and score as-is. When a hider disconnects, the system shall keep their seat and allow rejoin next round with the same code + name.
- **Scoreboard:** When a round ends, the system shall show per-guess distance, points, and running totals. The room shall persist until the owner closes it.

## Technical Design
Create a monorepo with a real-time client + server. Keep dependencies minimal.

**Architecture:** Create a Node.js + TypeScript WebSocket server to own all game state, timers, and scoring. Create a static SPA client to render Maps, Panoramas, and game phases. Store rooms in-memory (no DB for v1). Gate every state transition on the server.

**Create these files/components:**
- `server/index.ts` — Create Express + Socket.io host to manage `createRoom`, `joinRoom`, `rejoin`, `startRound`, `lockHide`, `lockGuess`, `endRound`.
- `server/rooms.ts` — Create Room store to track players, connection status, teams, scores.
- `server/game.ts` — Create phase machine (`LOBBY → HIDING → SEEKING → RESULTS → LOBBY`) to enforce timers and overtime/disconnect rules.
- `server/scoring.ts` — Create `scoreGuess(distanceKm, mapScale)` to return `{tier: FOUND|PARTIAL|MISS, points}`.
- `config/scoring.ts` — Create tunable distance thresholds and points to allow tweaking without code changes.
- `client/app/` — Create `LobbyView`, `HideView` (map + panorama check), `SeekView` (hider list + hide panorama + guess map), `ResultsView` (scoreboard).
- `client/maps.ts` — Create wrapper for Maps JS API + Street View Service to validate `panoExists(lat,lng)` before any lock.

**Data contracts:** Implement these shapes exactly:
```ts
RoomSettings { mapScale: 'WORLD'|'CONTINENT'|'COUNTRY'|'CITY', regionId: string, hidingTimeSec: number, seekingTimeSec: number, bonusTimeSec: number, mode: 'CLASSIC'|'1V1'|'TEAMS', seekerId?: string }
Player { id: string, name: string, team?: string, connected: bool, score: number }
Hide { playerId: string, lat: number, lng: number, panoId: string }
Guess { seekerId: string, targetHiderId: string, lat: number, lng: number, distanceKm: number, points: number }
```

## Constraints & Guardrails
- Enforce Street View-only hides. Do NOT allow a lock without a `panoId`. Do NOT support maps without coverage.
- Keep login optional. Do NOT build accounts, passwords, OAuth, or persistent stats in v1.
- Use Google Maps Platform (Maps JS + Street View) with server key restriction and client key restriction. Do NOT use Google AI Studio for maps — it provides no map tiles or panoramas.
- Keep the stack simple: TypeScript, one backend, one SPA, in-memory state. Do NOT introduce Postgres/Redis/Docker/K8s in v1.
- Do NOT build anti-cheat, chat, custom map uploads, or mobile-native apps in v1. Ignore reverse-image search and voice-chat collusion.
- Do NOT exceed Maps free-tier blindly. Cache `panoExists` checks and debounce panorama loads.

## Implementation Plan
- [ ] Scaffold monorepo with `client/`, `server/`, `config/scoring.ts`, README + `.env.example` for `MAPS_API_KEY`.
- [ ] Implement `rooms.ts` + socket events for create/join/rejoin/disconnect with 30s seeker grace.
- [ ] Implement lobby UI with room code share, settings form, mode select, random/owner seeker pick, team assign.
- [ ] Implement `maps.ts` pano validator + `HideView` with map, timer, check-view, lock-hide, 10s overtime skip.
- [ ] Implement `SeekView` with hider list, locked panorama viewer, guess map, lock-guess, live seeker-activity broadcast.
- [ ] Implement `scoring.ts` + bonus-time logic + `ResultsView` scoreboard.
- [ ] Implement 1v1 and Teams assignment and multi-seeker guess handling.
- [ ] Add disconnect/rejoin flow and owner-close room.
- [ ] Verify local multiplayer via two browsers + incognito and document LAN test steps.

## Definition of Done
- Run `npm install && npm run dev` locally to launch server + client with only `MAPS_API_KEY` required.
- Pass manual E2E: create room → 3 clients join via code → set World map, 60s hide, 300s seek → all hiders lock Street View spots → seeker locks 1+ guesses → verify distances, points, bonus time, scoreboard → start next round → test 1v1 and Teams modes.
- Pass timeout tests: hider no-lock → 10s overtime → skipped; seeker timeout → scored as-is; seeker disconnect 30s → round ends; hider disconnect → rejoins next round.
- Deliver README with setup, Maps Platform billing/free-tier note, LAN testing (same Wi-Fi via `http://<host-ip>:3000` + 2 incognito windows), and scoring tuning guide.
- Hand to coding agent with no open questions on modes, timers, scoring, or disconnects.