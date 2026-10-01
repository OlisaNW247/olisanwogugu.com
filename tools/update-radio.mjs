// Olisa's radio: picks the station from the last played song and writes radio.json.
//
// Rule: the station is the playlist with more than 10 songs that contains the last played
// song. If several qualify, the one with the most songs wins (ties go to the playlist Olisa
// opened most recently). If none qualify, the current station keeps playing.
//
// Files it maintains (all committed by the workflow):
//   radio-index.json  cache of every library playlist's track ids, refreshed when Apple says a
//                     playlist changed (or once a day)
//   radio.json        the station: playlist name, start time, shuffled playable tracks
//   radio-token.json  developer token for the web player, renewed when under 30 days remain
//   spotify-index.json  cache of ISRC → Spotify track id (only when Spotify secrets are set)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { appleClient, developerToken, credentials } from './apple.mjs';
import { matchSpotify } from './spotify.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_SONGS = 10;            // a playlist needs more than this many songs
const MAX_TRACKS = 1500;         // cap on tracks written to radio.json
const INDEX_TTL_MS = 24 * 3600e3;
const TOKEN_TTL_S = 60 * 24 * 3600;
const TOKEN_RENEW_S = 30 * 24 * 3600;

const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(resolve(ROOT, f), 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => writeFileSync(resolve(ROOT, f), JSON.stringify(v, null, 2) + '\n');

/* ---------- pure logic (unit-tested) ---------- */

export function pickStation(index, { catalogId, libraryId }, recentPlaylistIds = []) {
  const candidates = Object.entries(index.playlists || {})
    .map(([id, p]) => ({ id, ...p }))
    .filter((p) => p.count > MIN_SONGS)
    .filter((p) => (catalogId && p.catalogIds.includes(catalogId)) || (libraryId && p.libraryIds.includes(libraryId)));
  if (!candidates.length) return null;
  const recency = (id) => { const i = recentPlaylistIds.indexOf(id); return i === -1 ? Infinity : i; };
  candidates.sort((a, b) => (b.count - a.count) || (recency(a.id) - recency(b.id)) || a.name.localeCompare(b.name));
  return candidates[0];
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function seededShuffle(items, seed) {
  const rnd = mulberry32(hashSeed(seed));
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function radioTrack(song) {
  const a = song && song.attributes;
  if (!a || !a.durationInMillis) return null;
  const preview = a.previews && a.previews[0] && a.previews[0].url;
  return {
    id: String(song.id),
    song: a.name || '',
    artist: a.artistName || '',
    album: a.albumName || '',
    artwork: a.artwork && a.artwork.url ? a.artwork.url.replace('{w}', '1200').replace('{h}', '1200') : '',
    duration: a.durationInMillis,
    preview: preview || '',
    url: a.url || '',
    isrc: a.isrc || ''
  };
}

/* ---------- Apple calls ---------- */

async function refreshIndex(apple, index) {
  const playlists = await apple.getAll('/v1/me/library/playlists', { limit: 100 });
  const seen = new Set();
  let changed = false;
  for (const p of playlists) {
    const a = p.attributes || {};
    seen.add(p.id);
    const cached = index.playlists[p.id];
    const lastModified = a.lastModifiedDate || a.dateAdded || '';
    const stale = !cached || cached.lastModified !== lastModified || (Date.now() - Date.parse(cached.fetchedAt || 0)) > INDEX_TTL_MS;
    if (!stale) continue;
    const tracks = await apple.getAll(`/v1/me/library/playlists/${p.id}/tracks`, { limit: 100 });
    const catalogIds = new Set(), libraryIds = new Set();
    for (const t of tracks) {
      const pp = (t.attributes && t.attributes.playParams) || {};
      const isLibrary = t.type === 'library-songs';
      const c = pp.catalogId || (!isLibrary && (pp.id || t.id));
      if (c) catalogIds.add(String(c));
      if (isLibrary && t.id) libraryIds.add(String(t.id));
    }
    index.playlists[p.id] = {
      name: a.name || 'Untitled', lastModified, fetchedAt: new Date().toISOString(),
      count: tracks.length, catalogIds: [...catalogIds], libraryIds: [...libraryIds]
    };
    changed = true;
    console.log(`Indexed playlist "${a.name}" (${tracks.length} songs)`);
  }
  for (const id of Object.keys(index.playlists)) if (!seen.has(id)) { delete index.playlists[id]; changed = true; }
  if (changed) index.updated = new Date().toISOString();
  return changed;
}

async function recentPlaylistIds(apple) {
  try {
    const body = await apple.get('/v1/me/recent/played', { limit: 10 });
    return (body.data || []).filter((r) => /playlists$/.test(r.type)).map((r) => r.id);
  } catch { return []; }
}

async function catalogSongs(apple, storefront, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const body = await apple.get(`/v1/catalog/${storefront}/songs`, { ids: batch.join(',') });
    for (const s of body.data || []) out.set(String(s.id), s);
  }
  return out;
}

function refreshToken() {
  const current = readJson('radio-token.json', null) || {};
  const now = Math.floor(Date.now() / 1000);
  const spotifyClientId = process.env.SPOTIFY_CLIENT_ID || '';
  const next = { ...current, spotifyClientId };
  if (!current.token || (current.exp - now) <= TOKEN_RENEW_S) {
    next.token = developerToken({ ...credentials(), ttlSeconds: TOKEN_TTL_S });
    next.exp = now + TOKEN_TTL_S;
    console.log('Renewed the web player developer token.');
  }
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  writeJson('radio-token.json', next);
  return true;
}

async function main() {
  const apple = appleClient();
  refreshToken();

  const np = readJson('now-playing.json', {});
  if (!np.catalogId && !np.libraryId) { console.log('now-playing.json has no track ids yet; nothing to do.'); return; }

  const index = readJson('radio-index.json', { playlists: {} });
  if (await refreshIndex(apple, index)) writeJson('radio-index.json', index);

  const recent = await recentPlaylistIds(apple);
  const station = pickStation(index, np, recent);
  if (!station) { console.log(`"${np.song}" is not in any playlist with more than ${MIN_SONGS} songs; station unchanged.`); return; }

  const current = readJson('radio.json', null);
  const sameStation = !!(current && current.station && current.station.id === station.id && current.station.lastModified === station.lastModified);

  let tracks;
  const complete = sameStation && current.tracks.every((t) => 'isrc' in t);
  if (complete) {
    // Keep the running station's order and clock; only Spotify matches may still be filling in.
    tracks = current.tracks;
  } else {
    const storefront = await apple.storefront();
    const songs = await catalogSongs(apple, storefront, station.catalogIds.slice(0, MAX_TRACKS));
    tracks = station.catalogIds.map((id) => radioTrack(songs.get(id))).filter(Boolean);
    if (!tracks.length) { console.log(`No playable catalog songs in "${station.name}"; station unchanged.`); return; }
    if (sameStation) {
      // Same station, older file format: refresh the details but keep the running order and clock.
      const byId = new Map(tracks.map((t) => [t.id, t]));
      const kept = current.tracks.map((t) => byId.get(t.id)).filter(Boolean);
      const seen = new Set(kept.map((t) => t.id));
      tracks = kept.concat(tracks.filter((t) => !seen.has(t.id)));
    }
  }

  await matchSpotify(tracks, ROOT);

  const startedAt = sameStation ? current.startedAt : new Date().toISOString();
  const radio = {
    station: { id: station.id, name: station.name, lastModified: station.lastModified, songCount: station.count },
    startedAt,
    tracks: sameStation ? tracks : seededShuffle(tracks, startedAt + station.id),
    updated: sameStation ? current.updated : startedAt
  };
  if (sameStation && JSON.stringify(radio) === JSON.stringify(current)) { console.log(`Station unchanged: ${station.name}`); return; }
  if (sameStation) radio.updated = new Date().toISOString();
  writeJson('radio.json', radio);
  console.log(`Radio: ${station.name} (${tracks.length} playable of ${station.count}, ${tracks.filter((t) => t.spotifyId).length} on Spotify)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
