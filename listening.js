/* "Olisa is listening to" — reads now-playing.json, resolves cover art + link via Apple's
   public iTunes Search service, and reveals it in a cinematic overlay. */
(function () {
  'use strict';

  var CONFIG = {
    dataUrl: '/now-playing.json',
    // Optional: automatic updates via Last.fm scrobbling. Leave blank to use now-playing.json only.
    lastfm: { user: '', apiKey: '' }
  };

  var trackPromise = null;

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function jsonp(url) {
    return new Promise(function (resolve, reject) {
      var cb = '__lst_cb_' + Math.random().toString(36).slice(2);
      var s = document.createElement('script');
      var timer = setTimeout(function () { cleanup(); reject(new Error('timeout')); }, 8000);
      function cleanup() { clearTimeout(timer); delete window[cb]; if (s.parentNode) s.parentNode.removeChild(s); }
      window[cb] = function (data) { cleanup(); resolve(data); };
      s.onerror = function () { cleanup(); reject(new Error('jsonp failed')); };
      s.src = url + (url.indexOf('?') === -1 ? '?' : '&') + 'callback=' + cb;
      document.head.appendChild(s);
    });
  }

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

  // Ask Apple for artwork + an Apple Music link that match the song/artist.
  function resolveWithApple(track) {
    var term = [track.song, track.artist].filter(Boolean).join(' ');
    var url = 'https://itunes.apple.com/search?' + new URLSearchParams({ term: term, entity: 'song', limit: '8', media: 'music' });
    return jsonp(url).then(function (data) {
      var results = (data && data.results) || [];
      if (!results.length) return track;
      var a = norm(track.artist), t = norm(track.song);
      var best = results.find(function (r) { return norm(r.artistName).indexOf(a) !== -1 && norm(r.trackName).indexOf(t) !== -1; })
        || results.find(function (r) { return norm(r.artistName).indexOf(a) !== -1; })
        || results[0];
      return {
        song: track.song || best.trackName,
        artist: track.artist || best.artistName,
        album: track.album || best.collectionName || '',
        artwork: track.artwork || (best.artworkUrl100 || '').replace(/\d+x\d+bb/, '1200x1200bb'),
        appleMusicUrl: track.appleMusicUrl || best.trackViewUrl || ''
      };
    }).catch(function () { return track; });
  }

  function fromLastfm() {
    var c = CONFIG.lastfm;
    var url = 'https://ws.audioscrobbler.com/2.0/?' + new URLSearchParams({
      method: 'user.getrecenttracks', user: c.user, api_key: c.apiKey, format: 'json', limit: '1'
    });
    return fetchJson(url).then(function (d) {
      var t = d && d.recenttracks && d.recenttracks.track && d.recenttracks.track[0];
      if (!t) throw new Error('no track');
      return { song: t.name, artist: t.artist && t.artist['#text'], album: t.album && t.album['#text'], artwork: '', appleMusicUrl: '' };
    });
  }

  function loadTrack() {
    if (trackPromise) return trackPromise;
    var source = (CONFIG.lastfm.user && CONFIG.lastfm.apiKey)
      ? fromLastfm().catch(function () { return fetchJson(CONFIG.dataUrl); })
      : fetchJson(CONFIG.dataUrl);
    trackPromise = source.then(function (t) {
      if (!t || !t.song) throw new Error('nothing playing');
      return (t.artwork && t.appleMusicUrl) ? t : resolveWithApple(t);
    });
    return trackPromise;
  }

  function preload(src) {
    return new Promise(function (resolve) {
      if (!src) return resolve();
      var img = new Image();
      img.onload = img.onerror = function () { resolve(); };
      img.src = src;
    });
  }

  /* ---------- overlay ---------- */
  var overlay, els, lastFocus;

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'lst-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'What Olisa is listening to');
    overlay.innerHTML =
      '<div class="lst-backdrop"><img alt=""></div>' +
      '<div class="lst-vignette"></div>' +
      '<div class="lst-grain"></div>' +
      '<div class="lst-bar lst-bar-top"></div><div class="lst-bar lst-bar-bottom"></div>' +
      '<button class="lst-close" type="button" aria-label="Close">&#x2715;</button>' +
      '<p class="lst-status" hidden></p>' +
      '<div class="lst-stage">' +
        '<p class="lst-eyebrow">Olisa is listening to</p>' +
        '<div class="lst-art"><img alt=""></div>' +
        '<div class="lst-title" role="heading" aria-level="2"></div>' +
        '<p class="lst-artist"></p>' +
        '<p class="lst-album"></p>' +
        '<a class="lst-link" target="_blank" rel="noopener">Open in Apple Music &rarr;</a>' +
      '</div>';
    document.body.appendChild(overlay);
    els = {
      backdrop: overlay.querySelector('.lst-backdrop img'),
      art: overlay.querySelector('.lst-art img'),
      title: overlay.querySelector('.lst-title'),
      artist: overlay.querySelector('.lst-artist'),
      album: overlay.querySelector('.lst-album'),
      link: overlay.querySelector('.lst-link'),
      status: overlay.querySelector('.lst-status'),
      close: overlay.querySelector('.lst-close')
    };
    els.close.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay || e.target.classList.contains('lst-vignette')) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay.classList.contains('is-open')) close(); });
  }

  function setTitle(text) {
    els.title.textContent = '';
    String(text).split(/\s+/).forEach(function (word, i) {
      var w = document.createElement('span'); w.className = 'w';
      var inner = document.createElement('span'); inner.textContent = word; inner.style.setProperty('--i', i);
      w.appendChild(inner);
      els.title.appendChild(w);
      els.title.appendChild(document.createTextNode(' '));
    });
  }

  function fill(t) {
    els.backdrop.src = t.artwork || '';
    els.art.src = t.artwork || '';
    els.art.alt = t.album ? 'Cover art for ' + t.album : 'Cover art';
    setTitle(t.song);
    els.artist.textContent = t.artist || '';
    els.album.textContent = t.album || '';
    els.album.hidden = !t.album;
    if (t.appleMusicUrl) { els.link.href = t.appleMusicUrl; els.link.hidden = false; } else { els.link.hidden = true; }
  }

  function restartAnimations() {
    // Re-trigger CSS animations on every open.
    overlay.classList.remove('is-open');
    void overlay.offsetWidth;
    overlay.classList.add('is-open');
  }

  function open() {
    if (!overlay) build();
    lastFocus = document.activeElement;
    document.body.style.overflow = 'hidden';
    overlay.classList.add('is-loading', 'is-open');
    els.status.hidden = false;
    els.status.textContent = 'Listening…';
    loadTrack()
      .then(function (t) { return preload(t.artwork).then(function () { return t; }); })
      .then(function (t) {
        fill(t);
        els.status.hidden = true;
        overlay.classList.remove('is-loading');
        restartAnimations();
        els.close.focus();
      })
      .catch(function () {
        trackPromise = null;
        els.status.textContent = 'Silence, for now.';
        els.close.focus();
      });
  }

  function close() {
    overlay.classList.remove('is-open', 'is-loading');
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    if (document.body.dataset.listeningAutoclose === 'home') location.href = '/';
  }

  function init() {
    var btn = document.getElementById('listening-btn');
    if (btn) btn.addEventListener('click', function (e) { e.preventDefault(); open(); });
    // Warm the data so the click feels instant.
    var warm = function () { loadTrack().then(function (t) { preload(t.artwork); }).catch(function () {}); };
    if ('requestIdleCallback' in window) requestIdleCallback(warm); else setTimeout(warm, 300);
    if (document.body.dataset.listeningAutoopen === 'true') setTimeout(open, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.OlisaListening = { open: open, close: close };
})();
