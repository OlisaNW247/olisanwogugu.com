// Spotify matching for the radio, without a Spotify developer account.
//
// Each station track is resolved to its Spotify id by trying, in order:
//   1. Odesli's API (song.link), if an ODESLI_API_KEY secret is set
//   2. song.link's public page for the Apple Music song
//   3. MusicBrainz, looking up the ISRC and reading the recording's Spotify link
// Results (including "not found") are cached in spotify-index.json keyed by Apple catalog id, so each
// song is looked up once. A run does a small batch to respect the services' rate limits.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_LOOKUPS_PER_RUN = 20;
const SPACING_MS = 4000;
const UA = 'olisanwogugu.com radio (https://olisanwogugu.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRACK_RE = /open\.spotify\.com\/track\/([A-Za-z0-9]{22})/;
// Pages embed JSON where "/" may appear as "\/" or "\u002F"; also accept bare Spotify URIs.
const SLASH = String.raw`(?:\/|\\\/|\\u002[fF])`;
const HTML_RE = new RegExp(`open\\.spotify\\.com${SLASH}track${SLASH}([A-Za-z0-9]{22})|spotify:track:([A-Za-z0-9]{22})`);
const CACHE_VERSION = 2;

export function spotifyIdFromOdesli(body) {
  const link = body && body.linksByPlatform && body.linksByPlatform.spotify;
  const fromUrl = link && link.url && TRACK_RE.exec(link.url);
  if (fromUrl) return fromUrl[1];
  const fromEntity = link && link.entityUniqueId && /^SPOTIFY_SONG::(.+)$/.exec(link.entityUniqueId);
  return fromEntity ? fromEntity[1] : '';
}
export function spotifyIdFromHtml(html) {
  const m = HTML_RE.exec(String(html || ''));
  return m ? (m[1] || m[2]) : '';
}
export function spotifyIdFromMusicBrainz(body) {
  const recs = (body && body.recordings) || [];
  for (const r of recs) for (const rel of r.relations || []) {
    const m = rel.url && rel.url.resource && TRACK_RE.exec(rel.url.resource);
    if (m) return m[1];
  }
  return '';
}

// Each resolver returns a Spotify id, '' for "looked, not there", or null for "couldn't look".
const resolvers = [
  {
    name: 'odesli-api',
    enabled: () => !!process.env.ODESLI_API_KEY,
    async run(t, storefront) {
      const url = 'https://api.song.link/v1-alpha.1/links?' + new URLSearchParams({ platform: 'appleMusic', type: 'song', id: t.id, userCountry: storefront.toUpperCase(), key: process.env.ODESLI_API_KEY });
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 404) return '';
      if (!res.ok) return null;
      return spotifyIdFromOdesli(await res.json());
    }
  },
  {
    name: 'song.link',
    enabled: () => true,
    async run(t) {
      const res = await fetch(`https://song.link/i/${t.id}`, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' });
      if (res.status === 404) return '';
      if (!res.ok) return null;
      return spotifyIdFromHtml(await res.text());
    }
  },
  {
    name: 'musicbrainz',
    enabled: () => true,
    async run(t) {
      if (!t.isrc) return null;
      const res = await fetch(`https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(t.isrc)}?fmt=json&inc=url-rels`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 404) return '';
      if (!res.ok) return null;
      return spotifyIdFromMusicBrainz(await res.json());
    }
  }
];

export async function resolveOne(track, storefront, log) {
  let sawAnswer = false;
  for (const r of resolvers) {
    if (!r.enabled()) continue;
    let id;
    try { id = await r.run(track, storefront); } catch (e) { log(`${r.name}: ${e.message}`); continue; }
    if (id === null) { log(`${r.name}: no answer`); continue; }
    sawAnswer = true;
    if (id) { log(`${r.name}: matched`); return id; }
    log(`${r.name}: not found`);
  }
  return sawAnswer ? '' : null;
}

// Fills in `spotifyId` on each track (mutating). Returns true when the cache file changed.
export async function matchSpotify(tracks, root, storefront) {
  const file = resolve(root, 'spotify-index.json');
  let cache = {};
  try { cache = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  if (cache._v !== CACHE_VERSION) {
    // Parsing improved: forget "not found" answers so they get another look, keep real matches.
    for (const [k, v] of Object.entries(cache)) if (!v) delete cache[k];
    cache._v = CACHE_VERSION;
  }
  const pending = tracks.filter((t) => t.id && !(t.id in cache));
  let changed = false, done = 0, found = 0;
  const notes = {};
  const log = (msg) => { notes[msg] = (notes[msg] || 0) + 1; };
  for (const t of pending.slice(0, MAX_LOOKUPS_PER_RUN)) {
    const id = await resolveOne(t, storefront || 'us', log);
    if (id === null) continue;                     // every resolver failed; try again another run
    cache[t.id] = id; changed = true; done++; if (id) found++;
    await sleep(SPACING_MS);
  }
  if (pending.length) {
    console.log(`Spotify: looked up ${done} song${done === 1 ? '' : 's'}, found ${found}${pending.length > done ? `, ${pending.length - done} still to go` : ''}`);
    for (const [k, v] of Object.entries(notes)) console.log(`  ${k} ×${v}`);
  }
  if (changed) writeFileSync(file, JSON.stringify(cache, null, 0) + '\n');
  for (const t of tracks) t.spotifyId = cache[t.id] || '';
  return changed;
}
