// Spotify catalog matching for the radio. Uses the client-credentials flow (no user login), so a
// free Spotify account is enough to register the app. Matches by ISRC, the universal recording code
// Apple exposes on every catalog song, and caches results in spotify-index.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_LOOKUPS_PER_RUN = 300;

export function spotifyConfigured() {
  return !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

async function accessToken() {
  const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error(`Spotify token request failed (${res.status}). Check SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.`);
  return (await res.json()).access_token;
}

async function lookupIsrc(token, isrc) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://api.spotify.com/v1/search?${new URLSearchParams({ q: `isrc:${isrc}`, type: 'track', limit: '1' })}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      const wait = Math.min(60, Number(res.headers.get('retry-after') || 2));
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Spotify search failed (${res.status}): ${await res.text()}`);
    const j = await res.json();
    const t = j.tracks && j.tracks.items && j.tracks.items[0];
    return t ? t.id : '';
  }
  return null; // still rate limited; try again next run
}

// Fills in `spotifyId` on each track (mutating), looking up at most MAX_LOOKUPS_PER_RUN new ISRCs.
// Returns true when the cache file changed.
export async function matchSpotify(tracks, root) {
  const file = resolve(root, 'spotify-index.json');
  let cache = {};
  try { cache = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  const pending = [...new Set(tracks.map((t) => t.isrc).filter((i) => i && !(i in cache)))];
  let changed = false;
  if (pending.length && spotifyConfigured()) {
    const token = await accessToken();
    let done = 0;
    for (const isrc of pending.slice(0, MAX_LOOKUPS_PER_RUN)) {
      const id = await lookupIsrc(token, isrc);
      if (id === null) break;
      cache[isrc] = id;
      changed = true;
      done++;
    }
    console.log(`Spotify: matched ${done} new ISRC${done === 1 ? '' : 's'}${pending.length > done ? `, ${pending.length - done} still to go` : ''}`);
    if (changed) writeFileSync(file, JSON.stringify(cache, null, 0) + '\n');
  }
  for (const t of tracks) t.spotifyId = (t.isrc && cache[t.isrc]) || '';
  return changed;
}
