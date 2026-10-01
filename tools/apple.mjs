// Shared Apple Music API helpers for the GitHub Action scripts. Zero dependencies (Node 20+).
import { createPrivateKey, sign } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Signed developer token (JWT, ES256). Apple allows at most 6 months.
export function developerToken({ teamId, keyId, privateKey, ttlSeconds = 3600 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = b64url(JSON.stringify({ iss: teamId, iat: now, exp: now + ttlSeconds }));
  const data = `${header}.${payload}`;
  const key = createPrivateKey(privateKey);
  const sig = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64url(sig)}`;
}

export function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export function credentials() {
  return { teamId: env('APPLE_TEAM_ID'), keyId: env('APPLE_KEY_ID'), privateKey: env('APPLE_PRIVATE_KEY') };
}

export function appleClient() {
  const devToken = developerToken(credentials());
  const headers = { Authorization: `Bearer ${devToken}`, 'Music-User-Token': env('APPLE_MUSIC_USER_TOKEN') };
  const base = 'https://api.music.apple.com';

  async function get(path, params) {
    const url = new URL(path.startsWith('http') ? path : base + path);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await fetch(url, { headers });
    if (res.status === 403) throw new Error('Apple returned 403. The Music User Token has probably expired: re-run tools/authorize.html and update the APPLE_MUSIC_USER_TOKEN secret.');
    if (res.status === 401) throw new Error('Apple returned 401. Check APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY.');
    if (res.status === 404) return { data: [] };
    if (!res.ok) throw new Error(`Apple returned ${res.status} for ${url.pathname}: ${await res.text()}`);
    return res.json();
  }

  // Follows Apple's `next` links until everything is collected.
  async function getAll(path, params, max = 20000) {
    let out = [];
    let body = await get(path, params);
    while (body) {
      out = out.concat(body.data || []);
      if (!body.next || out.length >= max) break;
      body = await get(body.next);
    }
    return out;
  }

  let storefrontCache = null;
  async function storefront() {
    if (storefrontCache) return storefrontCache;
    try {
      const j = await get('/v1/me/storefront');
      storefrontCache = (j.data && j.data[0] && j.data[0].id) || 'us';
    } catch { storefrontCache = 'us'; }
    return storefrontCache;
  }

  return { get, getAll, storefront };
}
