// Fetches the most recently played track from Apple Music and writes now-playing.json.
// Runs in GitHub Actions on a schedule. See tools/README.md for the secrets it needs.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { appleClient, developerToken } from './apple.mjs';

export { developerToken };

export function trackFromApple(item, storefront = 'us') {
  const a = item && item.attributes;
  if (!a) return null;
  const pp = a.playParams || {};
  const isLibrary = item.type === 'library-songs';
  const catalogId = pp.catalogId || (!isLibrary && pp.id) || (!isLibrary && item.id) || '';
  // Library songs carry no public URL, but their catalog ID is enough to build one.
  const url = a.url || (catalogId ? `https://music.apple.com/${storefront}/song/${catalogId}` : '');
  return {
    song: a.name || '',
    artist: a.artistName || '',
    album: a.albumName || '',
    artwork: a.artwork && a.artwork.url ? a.artwork.url.replace('{w}', '1200').replace('{h}', '1200') : '',
    appleMusicUrl: url,
    catalogId: String(catalogId || ''),
    libraryId: isLibrary ? String(item.id || '') : ''
  };
}

const KEYS = ['song', 'artist', 'album', 'artwork', 'appleMusicUrl', 'catalogId', 'libraryId'];
const sameTrack = (x, y) => x && y && KEYS.every((k) => (x[k] || '') === (y[k] || ''));

async function main() {
  const apple = appleClient();
  const storefront = await apple.storefront();
  const body = await apple.get('/v1/me/recent/played/tracks', { types: 'songs,library-songs', limit: 1 });
  const track = trackFromApple(body.data && body.data[0], storefront);
  if (!track || !track.song) {
    console.log('No recently played track returned; leaving now-playing.json unchanged.');
    return;
  }

  const file = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'now-playing.json');
  let current = null;
  try { current = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  if (sameTrack(current, track)) {
    console.log(`Still playing: ${track.song} — ${track.artist}`);
    return;
  }
  const next = { ...track, updated: new Date().toISOString(), source: 'apple-music' };
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  console.log(`Now playing: ${track.song} — ${track.artist}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
