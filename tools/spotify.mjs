// Spotify matching for the radio, without a Spotify developer account.
//
// Odesli (song.link) resolves an Apple Music song to the same recording on other services. We ask
// it for each station track's Spotify id and cache the answer in spotify-index.json, keyed by the
// Apple catalog id. The free tier allows about 10 requests a minute, so each run looks up a small
// batch and a new station fills in over a few runs.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_LOOKUPS_PER_RUN = 20;
const SPACING_MS = 6500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function spotifyIdFromOdesli(body) {
  const link = body && body.linksByPlatform && body.linksByPlatform.spotify;
  const fromUrl = link && link.url && /open\.spotify\.com\/track\/([A-Za-z0-9]+)/.exec(link.url);
  if (fromUrl) return fromUrl[1];
  const fromEntity = link && link.entityUniqueId && /^SPOTIFY_SONG::(.+)$/.exec(link.entityUniqueId);
  return fromEntity ? fromEntity[1] : '';
}

async function lookup(appleId, storefront) {
  const url = 'https://api.song.link/v1-alpha.1/links?' + new URLSearchParams({ platform: 'appleMusic', type: 'song', id: appleId, userCountry: (storefront || 'us').toUpperCase() });
  const res = await fetch(url, { headers: { 'User-Agent': 'olisanwogugu.com radio' } });
  if (res.status === 429) return null;           // rate limited: stop for this run
  if (res.status === 404) return '';             // Odesli doesn't know this song
  if (!res.ok) throw new Error(`song.link returned ${res.status}`);
  return spotifyIdFromOdesli(await res.json());
}

// Fills in `spotifyId` on each track (mutating). Returns true when the cache file changed.
export async function matchSpotify(tracks, root, storefront) {
  const file = resolve(root, 'spotify-index.json');
  let cache = {};
  try { cache = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  const pending = tracks.filter((t) => t.id && !(t.id in cache)).map((t) => t.id);
  let changed = false, done = 0;
  for (const id of pending.slice(0, MAX_LOOKUPS_PER_RUN)) {
    let sid;
    try { sid = await lookup(id, storefront); } catch (e) { console.log(`Spotify match failed for ${id}: ${e.message}`); break; }
    if (sid === null) { console.log('song.link rate limit reached; continuing next run.'); break; }
    cache[id] = sid; changed = true; done++;
    if (done < pending.length) await sleep(SPACING_MS);
  }
  if (pending.length) console.log(`Spotify: matched ${done} song${done === 1 ? '' : 's'}${pending.length > done ? `, ${pending.length - done} still to go` : ''}`);
  if (changed) writeFileSync(file, JSON.stringify(cache, null, 0) + '\n');
  for (const t of tracks) t.spotifyId = cache[t.id] || '';
  return changed;
}
