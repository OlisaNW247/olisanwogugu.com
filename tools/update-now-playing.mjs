// Fetches the most recently played track from Apple Music and writes now-playing.json.
// Runs in GitHub Actions on a schedule. Zero dependencies (Node 20+).
//
// Required environment:
//   APPLE_TEAM_ID            Apple Developer Team ID (10 characters)
//   APPLE_KEY_ID             Key ID of the MusicKit private key
//   APPLE_PRIVATE_KEY        Contents of the AuthKey_XXXX.p8 file (PEM, multi-line)
//   APPLE_MUSIC_USER_TOKEN   Music User Token from tools/authorize.html

import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Signed developer token (JWT, ES256). Apple allows at most 6 months; one hour is plenty here.
export function developerToken({ teamId, keyId, privateKey, ttlSeconds = 3600 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = b64url(JSON.stringify({ iss: teamId, iat: now, exp: now + ttlSeconds }));
  const data = `${header}.${payload}`;
  const key = createPrivateKey(privateKey);
  const sig = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64url(sig)}`;
}

export function trackFromApple(item, storefront = 'us') {
  const a = item && item.attributes;
  if (!a) return null;
  // Library songs carry no public URL, but their catalog ID is enough to build one.
  const catalogId = a.playParams && a.playParams.catalogId;
  const url = a.url || (catalogId ? `https://music.apple.com/${storefront}/song/${catalogId}` : '');
  return {
    song: a.name || '',
    artist: a.artistName || '',
    album: a.albumName || '',
    artwork: a.artwork && a.artwork.url ? a.artwork.url.replace('{w}', '1200').replace('{h}', '1200') : '',
    appleMusicUrl: url
  };
}

const sameTrack = (x, y) => x && y && ['song', 'artist', 'album', 'artwork', 'appleMusicUrl'].every((k) => (x[k] || '') === (y[k] || ''));

async function main() {
  const env = (name) => {
    const v = process.env[name];
    if (!v) throw new Error(`Missing environment variable ${name}`);
    return v;
  };
  const devToken = developerToken({ teamId: env('APPLE_TEAM_ID'), keyId: env('APPLE_KEY_ID'), privateKey: env('APPLE_PRIVATE_KEY') });
  const userToken = env('APPLE_MUSIC_USER_TOKEN');

  const headers = { Authorization: `Bearer ${devToken}`, 'Music-User-Token': userToken };

  let storefront = 'us';
  try {
    const sf = await fetch('https://api.music.apple.com/v1/me/storefront', { headers });
    if (sf.ok) { const j = await sf.json(); if (j.data && j.data[0] && j.data[0].id) storefront = j.data[0].id; }
  } catch {}

  const url = 'https://api.music.apple.com/v1/me/recent/played/tracks?types=songs,library-songs&limit=1';
  const res = await fetch(url, { headers });
  if (res.status === 403) throw new Error('Apple returned 403. The Music User Token has probably expired: re-run tools/authorize.html and update the APPLE_MUSIC_USER_TOKEN secret.');
  if (res.status === 401) throw new Error('Apple returned 401. Check APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY.');
  if (!res.ok) throw new Error(`Apple returned ${res.status}: ${await res.text()}`);
  const body = await res.json();
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
