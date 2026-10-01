/* Olisa's radio — a synchronized 24/7 station built from whichever playlist Olisa last played.
   Full songs via Apple Music (MusicKit JS) for subscribers; 30-second previews for everyone else. */
(function () {
  'use strict';

  var PREVIEW_MS = 30000;
  var POLL_MS = 60000;
  var DRIFT_S = 4;

  var S = { data: null, token: null, mode: null, music: null, audio: null, idx: -1, playing: false, uiTimer: null, pollTimer: null, slotTimer: null };
  var $ = function (id) { return document.getElementById(id); };
  var els = {};

  function fetchJson(url) {
    return fetch(url + (url.indexOf('?') === -1 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  /* ---------- the clock: where is the station right now? ---------- */
  function schedule(data, mode, now) {
    now = now || Date.now();
    var tracks = data.tracks, durs = tracks.map(function (t) { return mode === 'full' ? t.duration : PREVIEW_MS; });
    var total = durs.reduce(function (a, b) { return a + b; }, 0);
    if (!total) return null;
    var elapsed = ((now - Date.parse(data.startedAt)) % total + total) % total;
    for (var i = 0; i < durs.length; i++) {
      if (elapsed < durs[i]) return { idx: i, offset: elapsed, duration: durs[i] };
      elapsed -= durs[i];
    }
    return { idx: 0, offset: 0, duration: durs[0] };
  }

  /* ---------- UI ---------- */
  function say(msg) { els.status.textContent = msg || ''; }

  function showTrack(i) {
    var t = S.data.tracks[i]; if (!t) return;
    S.idx = i;
    els.title.textContent = t.song;
    els.artist.textContent = t.artist + (t.album ? '  —  ' + t.album : '');
    if (t.url) { els.link.href = t.url; els.link.hidden = false; } else { els.link.hidden = true; }
    swapImage(els.art, t.artwork); swapImage(els.back, t.artwork);
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: t.song, artist: t.artist, album: 'Olisa’s radio · ' + S.data.station.name, artwork: t.artwork ? [{ src: t.artwork, sizes: '1200x1200' }] : [] }); } catch (e) {}
    }
  }

  function swapImage(container, src) {
    var old = container.querySelector('img.show');
    var img = document.createElement('img'); img.alt = '';
    img.onload = function () { img.classList.add('show'); if (old) setTimeout(function () { old.remove(); }, 1200); };
    img.src = src || '';
    container.appendChild(img);
  }

  function tickUI() {
    if (!S.data) return;
    var pos;
    if (S.mode === 'full' && S.music && S.music.nowPlayingItem) {
      pos = { offset: S.music.currentPlaybackTime * 1000, duration: S.music.currentPlaybackDuration * 1000 };
    } else {
      pos = schedule(S.data, S.mode || 'preview');
      if (pos && pos.idx !== S.idx) showTrack(pos.idx);
    }
    if (pos && pos.duration) els.progress.style.width = Math.min(100, (pos.offset / pos.duration) * 100) + '%';
  }

  /* ---------- preview mode (plain <audio>) ---------- */
  function previewTune() {
    var s = schedule(S.data, 'preview'); if (!s) return;
    var t = S.data.tracks[s.idx];
    showTrack(s.idx);
    if (!S.audio) {
      S.audio = new Audio(); S.audio.preload = 'auto';
      S.audio.addEventListener('ended', function () { if (S.playing) previewTune(); });
      S.audio.addEventListener('error', function () { if (S.playing) setTimeout(previewTune, 1500); });
    }
    clearTimeout(S.slotTimer);
    S.slotTimer = setTimeout(function () { if (S.playing && S.mode === 'preview') previewTune(); }, s.duration - s.offset + 50);
    if (!t.preview) return; // silent slot for a song with no preview; the timer moves us along
    S.audio.src = t.preview;
    var target = s.offset / 1000;
    var seek = function () { try { if (Math.abs(S.audio.currentTime - target) > 1.5) S.audio.currentTime = target; } catch (e) {} };
    S.audio.addEventListener('loadedmetadata', seek, { once: true });
    S.audio.addEventListener('canplay', seek, { once: true });
    S.audio.play().catch(function () { say('Tap play to start listening.'); });
    setTimeout(function () { if (S.playing && S.mode === 'preview' && S.audio.src.indexOf(t.preview) !== -1) { target = schedule(S.data, 'preview').offset / 1000; seek(); } }, 1200);
  }

  /* ---------- full mode (MusicKit JS) ---------- */
  function loadMusicKit() {
    return new Promise(function (resolve, reject) {
      if (window.MusicKit) return resolve();
      var s = document.createElement('script');
      s.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
      s.onerror = function () { reject(new Error('Could not load Apple Music.')); };
      document.addEventListener('musickitloaded', function () { resolve(); }, { once: true });
      document.head.appendChild(s);
      setTimeout(function () { if (!window.MusicKit) reject(new Error('Apple Music took too long to load.')); }, 12000);
    });
  }

  function musicInstance() {
    return loadMusicKit().then(function () {
      if (S.music) return S.music;
      return MusicKit.configure({ developerToken: S.token.token, app: { name: 'Olisa’s radio', build: '1' } }).then(function () {
        S.music = MusicKit.getInstance();
        S.music.addEventListener('nowPlayingItemDidChange', function () {
          var item = S.music.nowPlayingItem; if (!item || !S.data) return;
          var i = S.data.tracks.findIndex(function (t) { return t.id === String(item.id); });
          if (i !== -1 && i !== S.idx) showTrack(i);
        });
        S.music.addEventListener('playbackStateDidChange', function () {
          var st = S.music.playbackState, P = MusicKit.PlaybackStates;
          if (S.playing && (st === P.stopped || st === P.ended)) fullTune();
        });
        return S.music;
      });
    });
  }

  function fullTune() {
    var s = schedule(S.data, 'full'); if (!s) return Promise.resolve();
    var music = S.music;
    showTrack(s.idx);
    music.repeatMode = MusicKit.PlayerRepeatMode.all;
    return music.setQueue({ songs: S.data.tracks.map(function (t) { return t.id; }), startPosition: s.idx, startTime: s.offset / 1000, startPlaying: true })
      .then(function () { return music.play(); })
      .then(function () {
        // Some MusicKit builds ignore startTime; nudge into place once playback is running.
        setTimeout(function () {
          var want = schedule(S.data, 'full');
          if (want && music.nowPlayingItemIndex === want.idx && Math.abs(music.currentPlaybackTime - want.offset / 1000) > DRIFT_S) music.seekToTime(want.offset / 1000);
        }, 1500);
      });
  }

  function driftCheck() {
    if (!S.playing || S.mode !== 'full' || !S.music) return;
    var want = schedule(S.data, 'full'); if (!want) return;
    if (S.music.nowPlayingItemIndex !== want.idx) { S.music.changeToMediaAtIndex(want.idx).then(function () { S.music.seekToTime(want.offset / 1000); }); }
    else if (Math.abs(S.music.currentPlaybackTime - want.offset / 1000) > DRIFT_S) S.music.seekToTime(want.offset / 1000);
  }

  /* ---------- transport ---------- */
  function start(mode) {
    S.mode = mode; S.playing = true;
    els.onair.classList.add('live');
    els.tune.hidden = true; els.play.hidden = true; els.pause.hidden = false; els.volume.hidden = false;
    if (mode === 'full') {
      say('Full songs · Apple Music');
      return fullTune().catch(function (e) {
        // No subscription (or playback blocked): fall back to previews rather than silence.
        S.mode = 'preview';
        say('Apple Music couldn’t play here, so you’re hearing previews.');
        previewTune();
      });
    }
    say('30-second previews · sign in for full songs');
    previewTune();
    return Promise.resolve();
  }

  function pause() {
    S.playing = false;
    els.onair.classList.remove('live');
    els.play.hidden = false; els.pause.hidden = true;
    clearTimeout(S.slotTimer);
    if (S.mode === 'full' && S.music) S.music.pause();
    if (S.audio) S.audio.pause();
    say('Paused. Press play to rejoin live.');
  }

  function resume() {
    if (!S.mode) return openSheet();
    start(S.mode);
  }

  function setVolume(v) {
    if (S.music) S.music.volume = v;
    if (S.audio) S.audio.volume = v;
    try { localStorage.setItem('radio-volume', String(v)); } catch (e) {}
  }

  /* ---------- sign-in sheet ---------- */
  function openSheet() {
    els.sheet.hidden = false;
    els.signin.disabled = !S.token;
    els.sheetNote.textContent = S.token ? 'Full songs need an Apple Music subscription. Apple handles the sign-in; this site never sees your password.' : 'Apple Music sign-in isn’t available right now, but previews still work.';
  }
  function closeSheet() { els.sheet.hidden = true; }

  function signIn() {
    els.signin.disabled = true; say('Opening Apple Music…');
    musicInstance()
      .then(function (music) { return music.authorize(); })
      .then(function () { closeSheet(); return start('full'); })
      .catch(function (e) {
        els.signin.disabled = false;
        say((e && e.message) ? e.message : 'Sign-in was cancelled.');
      });
  }

  /* ---------- station changes ---------- */
  function poll() {
    fetchJson('/radio.json').then(function (d) {
      if (!S.data || d.startedAt !== S.data.startedAt || d.station.id !== S.data.station.id) {
        var switching = !!S.data;
        S.data = d;
        els.station.textContent = d.station.name;
        if (switching) {
          say('Switching to ' + d.station.name + '…');
          if (S.playing) { if (S.mode === 'full') fullTune(); else previewTune(); }
        }
        if (!S.playing) { var s = schedule(d, 'preview'); if (s) showTrack(s.idx); }
      }
    }).catch(function () {});
  }

  /* ---------- boot ---------- */
  function init() {
    ['status', 'station', 'title', 'artist', 'link', 'art', 'back', 'progress', 'play', 'pause', 'volume', 'onair', 'sheet', 'signin', 'previews', 'sheetNote', 'tune'].forEach(function (k) { els[k] = $('rd-' + k); });

    els.tune.addEventListener('click', openSheet);
    els.play.addEventListener('click', resume);
    els.pause.addEventListener('click', pause);
    els.signin.addEventListener('click', signIn);
    els.previews.addEventListener('click', function () { closeSheet(); start('preview'); });
    els.sheet.addEventListener('click', function (e) { if (e.target === els.sheet) closeSheet(); });
    els.volume.addEventListener('input', function () { setVolume(parseFloat(els.volume.value)); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); if (e.key === ' ' && S.mode && e.target === document.body) { e.preventDefault(); S.playing ? pause() : resume(); } });
    try { var v = localStorage.getItem('radio-volume'); if (v) { els.volume.value = v; } } catch (e) {}

    Promise.all([fetchJson('/radio.json'), fetchJson('/radio-token.json').catch(function () { return null; })])
      .then(function (r) {
        S.data = r[0]; S.token = r[1];
        els.station.textContent = S.data.station.name;
        var s = schedule(S.data, 'preview'); if (s) showTrack(s.idx);
        els.tune.hidden = false;
        say('');
        S.uiTimer = setInterval(tickUI, 500);
        S.pollTimer = setInterval(poll, POLL_MS);
        setInterval(driftCheck, 30000);
      })
      .catch(function () {
        els.station.textContent = 'Off air';
        say('No station yet. Olisa hasn’t played a playlist recently.');
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.OlisaRadio = { schedule: schedule, state: S };
})();
