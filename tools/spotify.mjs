// Spotify matching for the radio, without a Spotify developer account.
//
// Each station track is resolved to its Spotify id by trying, in order:
//   1. Spotify's own catalog, if SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET secrets are set
//   2. Odesli's API (song.link), if an ODESLI_API_KEY secret is set
//   3. MusicBrainz, looking up the ISRC and reading the recording's Spotify link
// Results (including "not found") are cached in spotify-index.json keyed by Apple catalog id, so each
// song is looked up once. A run does a small batch to respect the services' rate limits.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_LOOKUPS_PER_RUN = 20;
const SPACING_MS = 4000;
const FAST_LOOKUPS_PER_RUN = 150;   // when Spotify's own API answers, runs can do far more
const FAST_SPACING_MS = 250;
const UA = 'olisanwogugu.com radio (https://olisanwogugu.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRACK_RE = /open\.spotify\.com\/track\/([A-Za-z0-9]{22})/;
// Pages embed JSON where "/" may appear as "\/" or "\u002F"; also accept bare Spotify URIs.
const SLASH = String.raw`(?:\/|\\\/|\\u002[fF])`;
const HTML_RE = new RegExp(`open\\.spotify\\.com${SLASH}track${SLASH}([A-Za-z0-9]{22})|spotify:track:([A-Za-z0-9]{22})|SPOTIFY_SONG::([A-Za-z0-9]{22})`);
const CACHE_VERSION = 4;

export function spotifyIdFromOdesli(body) {
  const link = body && body.linksByPlatform && body.linksByPlatform.spotify;
  const fromUrl = link && link.url && TRACK_RE.exec(link.url);
  if (fromUrl) return fromUrl[1];
  const fromEntity = link && link.entityUniqueId && /^SPOTIFY_SONG::(.+)$/.exec(link.entityUniqueId);
  return fromEntity ? fromEntity[1] : '';
}
export function spotifyIdFromHtml(html) {
  const m = HTML_RE.exec(String(html || ''));
  return m ? (m[1] || m[2] || m[3]) : '';
}
export function spotifyIdFromMusicBrainz(body) {
  const recs = (body && body.recordings) || [];
  for (const r of recs) for (const rel of r.relations || []) {
    const m = rel.url && rel.url.resource && TRACK_RE.exec(rel.url.resource);
    if (m) return m[1];
  }
  return '';
}

// Spotify's own catalog (client-credentials flow: no user login, needs SPOTIFY_CLIENT_ID/SECRET).
let spotifyToken = null;
async function spotifyAccessToken() {
  if (spotifyToken && spotifyToken.exp > Date.now()) return spotifyToken.value;
  const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  if (!res.ok) throw new Error(`Spotify token request failed (${res.status}); check SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET`);
  const j = await res.json();
  spotifyToken = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return spotifyToken.value;
}
async function spotifySearch(q) {
  const token = await spotifyAccessToken();
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://api.spotify.com/v1/search?${new URLSearchParams({ q, type: 'track', limit: '3' })}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) { await sleep(Math.min(60, Number(res.headers.get('retry-after') || 2)) * 1000); continue; }
    if (!res.ok) return null;
    const j = await res.json();
    return (j.tracks && j.tracks.items) || [];
  }
  return null;
}
export function spotifyConfigured() { return !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET); }

// Each resolver returns a Spotify id, '' for "looked, not there", or null for "couldn't look".
const resolvers = [
  {
    // Exact match by ISRC, then a title + artist search as a backstop.
    name: 'spotify-api',
    enabled: spotifyConfigured,
    async run(t) {
      if (t.isrc) {
        const items = await spotifySearch(`isrc:${t.isrc}`);
        if (items === null) return null;
        if (items.length) return items[0].id;
      }
      if (!t.song || !t.artist) return '';
      const artist = t.artist.split(/,|&|\bfeat\b/i)[0].trim();
      const items = await spotifySearch(`track:${t.song.replace(/[()\[\]"]/g, ' ')} artist:${artist}`);
      if (items === null) return null;
      const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const hit = items.find((i) => norm(i.name) === norm(t.song) && i.artists.some((a) => norm(a.name) === norm(artist))) || items.find((i) => i.artists.some((a) => norm(a.name) === norm(artist)));
      return hit ? hit.id : '';
    }
  },
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
    // song.link's page lists Spotify only as a placeholder (the link is fetched by their script after
    // load), so this rarely helps; kept in case their page changes.
    name: 'song.link',
    enabled: () => false,
    async run(t) {
      const res = await fetch(`https://song.link/i/${t.id}`, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' });
      if (res.status === 404) return '';
      if (!res.ok) return null;
      const html = await res.text();
      const id = spotifyIdFromHtml(html);
      if (!id && diagnostics-- > 0) {
        const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1] || '';
        console.log(`  [song.link diag] status ${res.status}, final url ${res.url}, ${html.length} chars, title "${title.slice(0, 80)}", next-data ${/__NEXT_DATA__/.test(html)}, challenge ${/challenge|cf-browser-verification|Just a moment/i.test(html)}`);
        const re = /spotify/gi; let m, n = 0;
        while ((m = re.exec(html)) && n < 6) { n++; console.log(`    …${html.slice(Math.max(0, m.index - 70), m.index + 90).replace(/\s+/g, ' ')}…`); }
      }
      return id;
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
  },
  {
    // Last resort: search MusicBrainz by title and artist, then read each candidate's links.
    name: 'musicbrainz-search',
    enabled: () => true,
    async run(t) {
      if (!t.song || !t.artist) return null;
      const q = `recording:"${t.song.replace(/"/g, '')}" AND artist:"${t.artist.split(/,|&/)[0].trim().replace(/"/g, '')}"`;
      const res = await fetch(`https://musicbrainz.org/ws/2/recording?${new URLSearchParams({ query: q, fmt: 'json', limit: '3' })}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) return null;
      const recs = ((await res.json()).recordings || []).filter((r) => r.score >= 85);
      for (const r of recs) {
        await sleep(1100); // MusicBrainz asks for one request per second
        const d = await fetch(`https://musicbrainz.org/ws/2/recording/${r.id}?fmt=json&inc=url-rels`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (!d.ok) continue;
        const id = spotifyIdFromMusicBrainz({ recordings: [await d.json()] });
        if (id) return id;
      }
      return '';
    }
  }
];
let diagnostics = 0; // set above 0 to log page snippets for misses

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
  const fast = spotifyConfigured();
  for (const t of pending.slice(0, fast ? FAST_LOOKUPS_PER_RUN : MAX_LOOKUPS_PER_RUN)) {
    const id = await resolveOne(t, storefront || 'us', log);
    if (id === null) continue;                     // every resolver failed; try again another run
    cache[t.id] = id; changed = true; done++; if (id) found++;
    await sleep(fast ? FAST_SPACING_MS : SPACING_MS);
  }
  if (pending.length) {
    console.log(`Spotify: looked up ${done} song${done === 1 ? '' : 's'}, found ${found}${pending.length > done ? `, ${pending.length - done} still to go` : ''}`);
    for (const [k, v] of Object.entries(notes)) console.log(`  ${k} ×${v}`);
  }
  if (changed) writeFileSync(file, JSON.stringify(cache, null, 0) + '\n');
  for (const t of tracks) t.spotifyId = cache[t.id] || '';
  return changed;
}
