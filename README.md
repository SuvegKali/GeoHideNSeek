# GeoHideNSeek v1

Social geography hide-and-seek MVP (see `spec.md`).

## Prereqs

- Node.js >= 20
- A Google Maps Platform API key with **Maps JS API + Street View Static API**
  enabled (see billing note below).

## Setup

```bash
cp .env.example .env   # put your key in MAPS_API_KEY *and* VITE_MAPS_API_KEY
npm install
npm run dev            # server :3001 + client :3000
```

> Vite only picks up `VITE_*` vars at startup — restart `npm run dev`
> after editing `.env`. The client reads the repo-root `.env`.

Open `http://localhost:3000` in two browsers (one incognito) to test multiplayer.

## Layout

- `config/scoring.ts` — tunable distance thresholds / points (no code changes needed to retune).
- `server/` — Express + Socket.io authority (`index.ts`, `rooms.ts`, `game.ts`, `scoring.ts`).
- `client/` — static Vite SPA (`src/app/*` views, `src/maps.ts` pano validator).

## Maps Platform billing / free-tier

- Street View + Maps JS are billed per request. For v1: cache `panoExists`
  checks, debounce panorama loads, restrict keys (HTTP referrer for client,
  IP for server).
- See https://developers.google.com/maps/billing-and-pricing/pricing for current free tier.

## LAN testing

1. Put all devices on the same Wi-Fi.
2. Run `npm run dev`, find host LAN IP (e.g. `192.168.1.20`).
3. On each phone/laptop open `http://<host-ip>:3000` + 2 incognito windows.
4. Create room on host, join via 6-char code on the others.

## Scoring tuning

Edit `config/scoring.ts` (`SCORING` thresholds per `WORLD|CONTINENT|COUNTRY|CITY`).
Server `scoreGuess` reads these values; restart server after changes.
