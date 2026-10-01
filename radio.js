/* Olisa's radio — a synchronized 24/7 station built from whichever playlist Olisa last played.
   Everyone hears the same song at the same moment: the position is computed from the station's
   start time, never streamed. Four ways to hear it:
     apple    full songs through Apple Music (MusicKit JS), needs a subscription
     spotify  full songs through Spotify's web player, needs Premium
     embed    Spotify's embedded player (full songs if logged in to Spotify, previews otherwise)
     preview  Apple's 30-second previews, no sign-in */
(function () {
  'use strict';

  var PREVIEW_MS = 30000, POLL_MS = 60000, DRIFT_MS = 4000, SP_WINDOW = 50;
  var SP_SCOPES = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';

  var S = {
    data: null, cfg: null,
    source: null,          // 'apple' | 'spotify' | 'embed' | 'preview'
    timeline: 'preview',   // 'full' | 'preview' — which clock the current source follows
    playing: false, idx: -1,
    music: null, audio: null,
    sp: { player: null, deviceId: null, state: null, stateAt: 0, windowStart: -1, windowEnd: -1, embed: null, embedUri: '', embedUpdate: null, embedAt: 0, embedArmed: false },
    timers: {}
  };
  var els = {};
  var $ = function (id) { return document.getElementById(id); };

  function fetchJson(url) {
    return fetch(url + (url.indexOf('?') === -1 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function loadScript(src, readyCheck, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (readyCheck()) return resolve();
      var s = document.createElement('script'); s.src = src; s.async = true;
      s.onerror = function () { reject(new Error('Could not load ' + src.split('/')[2] + '.')); };
      document.head.appendChild(s);
      var t0 = Date.now();
      (function wait() { if (readyCheck()) return resolve(); if (Date.now() - t0 > (timeoutMs || 12000)) return reject(new Error('Player took too long to load.')); setTimeout(wait, 100); })();
    });
  }

  /* ---------- the clock ---------- */
  function schedule(data, timeline, now) {
    now = now || Date.now();
    var durs = data.tracks.map(function (t) { return timeline === 'full' ? t.duration : PREVIEW_MS; });
    var total = durs.reduce(function (a, b) { return a + b; }, 0);
    if (!total) return null;
    var elapsed = ((now - Date.parse(data.startedAt)) % total + total) % total;
    for (var i = 0; i < durs.length; i++) { if (elapsed < durs[i]) return { idx: i, offset: elapsed, duration: durs[i] }; elapsed -= durs[i]; }
    return { idx: 0, offset: 0, duration: durs[0] };
  }
  function slotTimer(s, fn) {
    clearTimeout(S.timers.slot);
    S.timers.slot = setTimeout(function () { if (S.playing) fn(); }, Math.max(250, s.duration - s.offset + 60));
  }

  /* ---------- UI ---------- */
  function say(msg) { els.status.textContent = msg || ''; }
  function sourceLabel() { return { apple: 'Apple Music', spotify: 'Spotify', embed: 'Spotify', preview: 'Previews' }[S.source] || ''; }

  function showTrack(i) {
    var t = S.data.tracks[i]; if (!t) return;
    S.idx = i;
    els.title.textContent = t.song;
    els.artist.textContent = t.artist + (t.album ? '  —  ' + t.album : '');
    var link = (S.source === 'spotify' || S.source === 'embed') && t.spotifyId ? 'https://open.spotify.com/track/' + t.spotifyId : t.url;
    if (link) { els.link.href = link; els.link.hidden = false; } else { els.link.hidden = true; }
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
  function position() {
    if (S.source === 'apple' && S.music && S.music.nowPlayingItem) return { offset: S.music.currentPlaybackTime * 1000, duration: S.music.currentPlaybackDuration * 1000 };
    if (S.source === 'spotify' && S.sp.state) { var st = S.sp.state; return { offset: st.position + (st.paused ? 0 : Date.now() - S.sp.stateAt), duration: st.duration }; }
    if (S.source === 'embed' && S.sp.embedUpdate) { var u = S.sp.embedUpdate; return { offset: u.position + (u.isPaused ? 0 : Date.now() - S.sp.embedAt), duration: u.duration }; }
    return schedule(S.data, S.timeline);
  }
  function tickUI() {
    if (!S.data) return;
    if (S.source === 'preview' || !S.source) { var s = schedule(S.data, 'preview'); if (s && s.idx !== S.idx) showTrack(s.idx); }
    var pos = position();
    if (pos && pos.duration) els.progress.style.width = Math.min(100, (pos.offset / pos.duration) * 100) + '%';
  }
  function showPlayer() {
    els.choose.classList.add('leaving');
    setTimeout(function () { els.choose.hidden = true; }, 700);
    els.stage.hidden = false;
    els.source.textContent = sourceLabel();
  }
  function setTransport(playing) {
    S.playing = playing;
    els.onair.classList.toggle('live', playing);
    els.start.hidden = true; els.play.hidden = playing; els.pause.hidden = !playing; els.volume.hidden = false;
  }

  /* ---------- preview mode (plain <audio>) ---------- */
  function previewTune() {
    S.timeline = 'preview';
    var s = schedule(S.data, 'preview'); if (!s) return;
    var t = S.data.tracks[s.idx];
    showTrack(s.idx);
    if (!S.audio) {
      S.audio = new Audio(); S.audio.preload = 'auto'; S.audio.volume = parseFloat(els.volume.value);
      S.audio.addEventListener('ended', function () { if (S.playing && S.source === 'preview') previewTune(); });
      S.audio.addEventListener('error', function () { if (S.playing && S.source === 'preview') setTimeout(previewTune, 1500); });
    }
    slotTimer(s, previewTune);
    if (!t.preview) { S.audio.pause(); return; }
    S.audio.src = t.preview;
    var target = s.offset / 1000;
    var seek = function () { try { if (Math.abs(S.audio.currentTime - target) > 1.5) S.audio.currentTime = target; } catch (e) {} };
    S.audio.addEventListener('loadedmetadata', seek, { once: true });
    S.audio.addEventListener('canplay', seek, { once: true });
    S.audio.play().catch(function () { say('Tap play to start listening.'); });
    setTimeout(function () { if (S.playing && S.source === 'preview' && S.audio.src.indexOf(t.preview) !== -1) { target = schedule(S.data, 'preview').offset / 1000; seek(); } }, 1200);
  }

  /* ---------- Apple Music (MusicKit JS) ---------- */
  function musicInstance() {
    if (!S.cfg || !S.cfg.token) return Promise.reject(new Error('Apple Music sign-in isn’t available right now.'));
    return loadScript('https://js-cdn.music.apple.com/musickit/v3/musickit.js', function () { return !!window.MusicKit; }).then(function () {
      if (S.music) return S.music;
      return MusicKit.configure({ developerToken: S.cfg.token, app: { name: 'Olisa’s radio', build: '1' } }).then(function () {
        S.music = MusicKit.getInstance();
        S.music.addEventListener('nowPlayingItemDidChange', function () {
          var item = S.music.nowPlayingItem; if (!item || !S.data || S.source !== 'apple') return;
          var i = S.data.tracks.findIndex(function (t) { return t.id === String(item.id); });
          if (i !== -1 && i !== S.idx) showTrack(i);
        });
        S.music.addEventListener('playbackStateDidChange', function () {
          var st = S.music.playbackState, P = MusicKit.PlaybackStates;
          if (S.playing && S.source === 'apple' && (st === P.stopped || st === P.ended)) appleTune();
        });
        return S.music;
      });
    });
  }
  function appleTune() {
    S.timeline = 'full';
    var s = schedule(S.data, 'full'); if (!s) return Promise.resolve();
    var music = S.music;
    showTrack(s.idx);
    music.repeatMode = MusicKit.PlayerRepeatMode.all;
    music.volume = parseFloat(els.volume.value);
    return music.setQueue({ songs: S.data.tracks.map(function (t) { return t.id; }), startPosition: s.idx, startTime: s.offset / 1000, startPlaying: true })
      .then(function () { return music.play(); })
      .then(function () { setTimeout(appleDrift, 1500); });
  }
  function appleDrift() {
    if (!S.playing || S.source !== 'apple' || !S.music) return;
    var want = schedule(S.data, 'full'); if (!want) return;
    if (S.music.nowPlayingItemIndex !== want.idx) S.music.changeToMediaAtIndex(want.idx).then(function () { S.music.seekToTime(want.offset / 1000); });
    else if (Math.abs(S.music.currentPlaybackTime * 1000 - want.offset) > DRIFT_MS) S.music.seekToTime(want.offset / 1000);
  }

  /* ---------- Spotify: login (Authorization Code with PKCE, browser only) ---------- */
  function spRedirectUri() { return location.origin + location.pathname; }
  function spStored() { try { return JSON.parse(localStorage.getItem('radio-spotify') || 'null'); } catch (e) { return null; } }
  function spStore(tok) { try { localStorage.setItem('radio-spotify', JSON.stringify(tok)); } catch (e) {} }
  function b64url(buf) { var s = ''; new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function randomVerifier() { var a = new Uint8Array(48); crypto.getRandomValues(a); return b64url(a.buffer); }

  function spLogin() {
    if (!S.cfg || !S.cfg.spotifyClientId) { say('Spotify sign-in isn’t set up yet.'); return; }
    var verifier = randomVerifier();
    try { sessionStorage.setItem('radio-spotify-verifier', verifier); } catch (e) {}
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(function (hash) {
      location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
        client_id: S.cfg.spotifyClientId, response_type: 'code', redirect_uri: spRedirectUri(), scope: SP_SCOPES,
        code_challenge_method: 'S256', code_challenge: b64url(hash), state: 'radio'
      });
    });
  }
  function spTokenRequest(params) {
    return fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error_description || j.error || 'Spotify sign-in failed.'); return j; }); })
      .then(function (j) {
        var prev = spStored() || {};
        var tok = { access: j.access_token, refresh: j.refresh_token || prev.refresh, exp: Date.now() + (j.expires_in - 60) * 1000 };
        spStore(tok); return tok;
      });
  }
  function spHandleCallback() {
    var q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return Promise.resolve(false);
    history.replaceState(null, '', location.pathname);
    if (q.has('error')) return Promise.reject(new Error('Spotify sign-in was ' + (q.get('error') === 'access_denied' ? 'cancelled.' : 'refused: ' + q.get('error'))));
    var verifier = ''; try { verifier = sessionStorage.getItem('radio-spotify-verifier') || ''; sessionStorage.removeItem('radio-spotify-verifier'); } catch (e) {}
    return spTokenRequest({ client_id: S.cfg.spotifyClientId, grant_type: 'authorization_code', code: q.get('code'), redirect_uri: spRedirectUri(), code_verifier: verifier }).then(function () { return true; });
  }
  function spAccessToken() {
    var tok = spStored();
    if (!tok) return Promise.reject(new Error('Not signed in to Spotify.'));
    if (Date.now() < tok.exp) return Promise.resolve(tok.access);
    if (!tok.refresh) return Promise.reject(new Error('Spotify session expired.'));
    return spTokenRequest({ client_id: S.cfg.spotifyClientId, grant_type: 'refresh_token', refresh_token: tok.refresh }).then(function (t) { return t.access; });
  }
  function spApi(method, path, body) {
    return spAccessToken().then(function (tok) {
      return fetch('https://api.spotify.com/v1' + path, { method: method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    });
  }

  /* ---------- Spotify: full songs (Web Playback SDK) ---------- */
  function spotifyStart() {
    say('Connecting to Spotify…');
    return loadScript('https://sdk.scdn.co/spotify-player.js', function () { return !!(window.Spotify && window.Spotify.Player); }).then(function () {
      return new Promise(function (resolve, reject) {
        if (S.sp.player && S.sp.deviceId) return resolve();
        var player = new Spotify.Player({ name: 'Olisa’s radio', volume: parseFloat(els.volume.value), getOAuthToken: function (cb) { spAccessToken().then(cb).catch(function () { cb(''); }); } });
        S.sp.player = player;
        var settled = false;
        player.addListener('ready', function (e) { S.sp.deviceId = e.device_id; if (!settled) { settled = true; resolve(); } });
        player.addListener('not_ready', function () { S.sp.deviceId = null; });
        ['initialization_error', 'authentication_error', 'account_error'].forEach(function (ev) {
          player.addListener(ev, function (e) { if (!settled) { settled = true; reject(new Error(ev === 'account_error' ? 'premium' : (e && e.message) || ev)); } });
        });
        player.addListener('player_state_changed', spStateChanged);
        if (player.activateElement) { try { player.activateElement(); } catch (e) {} }
        player.connect().then(function (ok) { if (!ok && !settled) { settled = true; reject(new Error('Spotify player would not connect.')); } });
        setTimeout(function () { if (!settled) { settled = true; reject(new Error('Spotify player took too long.')); } }, 15000);
      });
    }).then(spotifyTune);
  }
  function spStateChanged(state) {
    if (S.source !== 'spotify') return;
    var prev = S.sp.state;
    S.sp.state = state; S.sp.stateAt = Date.now();
    if (!state) return;
    var cur = state.track_window && state.track_window.current_track;
    if (cur) {
      var i = -1;
      for (var k = S.sp.windowStart; k <= S.sp.windowEnd && k < S.data.tracks.length; k++) if (S.data.tracks[k].spotifyId === cur.id) { i = k; break; }
      if (i === -1) i = S.data.tracks.findIndex(function (t) { return t.spotifyId === cur.id; });
      if (i !== -1 && i !== S.idx) showTrack(i);
    }
    // The run of tracks finished (paused at 0 right after the end of a track): rejoin live.
    if (S.playing && state.paused && state.position === 0 && prev && !prev.paused && prev.duration && prev.position > prev.duration - 6000) setTimeout(spotifyTune, 300);
  }
  function spotifyTune() {
    if (S.source !== 'spotify' || !S.sp.deviceId) return Promise.resolve();
    S.timeline = 'full';
    var s = schedule(S.data, 'full'); if (!s) return Promise.resolve();
    var tracks = S.data.tracks;
    showTrack(s.idx);
    if (!tracks[s.idx].spotifyId) {
      say('This one isn’t on Spotify — back after the song.');
      S.sp.player.pause(); slotTimer(s, spotifyTune); return Promise.resolve();
    }
    say('Full songs · Spotify');
    var uris = [], end = s.idx;
    for (var k = s.idx; k < tracks.length && uris.length < SP_WINDOW && tracks[k].spotifyId; k++) { uris.push('spotify:track:' + tracks[k].spotifyId); end = k; }
    S.sp.windowStart = s.idx; S.sp.windowEnd = end;
    clearTimeout(S.timers.slot);
    return spApi('PUT', '/me/player/play?device_id=' + S.sp.deviceId, { uris: uris, offset: { position: 0 }, position_ms: Math.floor(s.offset) }).then(function (r) {
      if (r.status === 404) return new Promise(function (res) { setTimeout(res, 1200); }).then(spotifyTune);
      if (r.status === 403) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(/PREMIUM/i.test(JSON.stringify(j)) ? 'premium' : 'Spotify refused playback.'); });
      if (!r.ok && r.status !== 204) throw new Error('Spotify playback failed (' + r.status + ').');
    });
  }
  function spotifyDrift() {
    if (!S.playing || S.source !== 'spotify' || !S.sp.state || S.sp.state.paused) return;
    var want = schedule(S.data, 'full'); if (!want) return;
    var pos = position();
    if (S.idx !== want.idx) { if (want.idx < S.sp.windowStart || want.idx > S.sp.windowEnd) spotifyTune(); else if (Math.abs(S.idx - want.idx) > 1) spotifyTune(); }
    else if (pos && Math.abs(pos.offset - want.offset) > DRIFT_MS) S.sp.player.seek(Math.floor(want.offset));
  }

  /* ---------- Spotify: embedded player fallback ---------- */
  function embedStart(reason) {
    S.source = 'embed'; els.source.textContent = sourceLabel();
    say(reason || 'Playing through Spotify’s player.');
    els.embed.hidden = false;
    return loadScript('https://open.spotify.com/embed/iframe-api/v1', function () { return !!window.__spIframeApi; }).then(function () {
      return new Promise(function (resolve) {
        if (S.sp.embed) return resolve();
        var s = schedule(S.data, S.timeline), t = S.data.tracks[s.idx];
        window.__spIframeApi.createController(els.embedSlot, { uri: 'spotify:track:' + (t.spotifyId || ''), width: '100%', height: 80 }, function (controller) {
          S.sp.embed = controller;
          controller.addListener('playback_update', function (e) {
            var d = e.data || {}; S.sp.embedUpdate = d; S.sp.embedAt = Date.now();
            if (!S.playing || S.source !== 'embed') return;
            if (S.sp.embedArmed && d.duration > 0) {
              S.sp.embedArmed = false;
              var want = S.data.tracks[S.idx];
              var preview = want && d.duration < want.duration - 5000;
              S.timeline = preview ? 'preview' : 'full';
              var sc = schedule(S.data, S.timeline);
              if (sc.idx !== S.idx) return embedTune();
              controller.seek(Math.floor(sc.offset / 1000)); controller.play();
              say(preview ? 'Spotify previews · log in to Spotify in the player for full songs' : 'Full songs · Spotify');
              setTimeout(function () { if (S.playing && S.sp.embedUpdate && S.sp.embedUpdate.isPaused) say('Press play on the Spotify player below.'); }, 2500);
            }
            if (d.duration > 0 && d.isPaused && d.position >= d.duration - 1500 && d.position > 0) embedTune();
          });
          resolve();
        });
      });
    }).then(embedTune);
  }
  function embedTune() {
    if (S.source !== 'embed' || !S.sp.embed) return;
    var s = schedule(S.data, S.timeline), t = S.data.tracks[s.idx];
    showTrack(s.idx);
    if (!t.spotifyId) { say('This one isn’t on Spotify — back after the song.'); S.sp.embed.pause(); slotTimer(s, embedTune); return; }
    slotTimer(s, embedTune);
    S.sp.embedArmed = true; S.sp.embedUpdate = null;
    S.sp.embed.loadUri('spotify:track:' + t.spotifyId);
  }

  /* ---------- transport ---------- */
  function start(source) {
    S.source = source; els.source.textContent = sourceLabel();
    setTransport(true);
    var p;
    if (source === 'apple') { say('Full songs · Apple Music'); p = appleTune(); }
    else if (source === 'spotify') { p = spotifyStart(); }
    else { say('30-second previews'); previewTune(); p = Promise.resolve(); }
    return p.catch(function (e) {
      var msg = (e && e.message) || '';
      if (source === 'spotify') {
        if (S.sp.player) { try { S.sp.player.disconnect(); } catch (x) {} S.sp.player = null; S.sp.deviceId = null; }
        return embedStart(msg === 'premium' ? 'Full songs need Spotify Premium, so here’s Spotify’s player instead.' : 'Spotify’s player couldn’t start here, so here’s Spotify’s embedded player.');
      }
      S.source = 'preview'; els.source.textContent = sourceLabel();
      say((source === 'apple' ? 'Apple Music couldn’t play here' : 'Playback failed') + ', so you’re hearing previews.');
      previewTune();
    });
  }
  function pause() {
    setTransport(false);
    clearTimeout(S.timers.slot);
    if (S.source === 'apple' && S.music) S.music.pause();
    if (S.source === 'spotify' && S.sp.player) S.sp.player.pause();
    if (S.source === 'embed' && S.sp.embed) S.sp.embed.pause();
    if (S.audio) S.audio.pause();
    say('Paused. Press play to rejoin live.');
  }
  function resume() {
    setTransport(true);
    if (S.source === 'apple') { say('Full songs · Apple Music'); appleTune(); }
    else if (S.source === 'spotify') { spotifyTune(); }
    else if (S.source === 'embed') { embedTune(); }
    else { say('30-second previews'); previewTune(); }
  }
  function stopAll() {
    S.playing = false; clearTimeout(S.timers.slot);
    if (S.music) { try { S.music.stop(); } catch (e) {} }
    if (S.sp.player) { try { S.sp.player.pause(); } catch (e) {} }
    if (S.sp.embed) { try { S.sp.embed.pause(); } catch (e) {} }
    if (S.audio) S.audio.pause();
  }
  function setVolume(v) {
    if (S.music) S.music.volume = v;
    if (S.sp.player) S.sp.player.setVolume(v);
    if (S.audio) S.audio.volume = v;
    try { localStorage.setItem('radio-volume', String(v)); } catch (e) {}
  }

  /* ---------- choosing a service ---------- */
  function pickApple() {
    say('Opening Apple Music…'); els.pickApple.disabled = true;
    musicInstance().then(function (m) { return m.authorize(); })
      .then(function () { showPlayer(); return start('apple'); })
      .catch(function (e) { els.pickApple.disabled = false; els.chooseHint.textContent = (e && e.message) || 'Apple Music sign-in was cancelled.'; });
  }
  function pickSpotify() {
    var tok = spStored();
    if (tok && (Date.now() < tok.exp || tok.refresh)) { showPlayer(); start('spotify'); return; }
    els.chooseHint.textContent = 'Taking you to Spotify…';
    spLogin();
  }
  function pickPreviews() { showPlayer(); start('preview'); }
  function switchService() {
    stopAll();
    els.embed.hidden = true;
    els.stage.hidden = true;
    els.choose.hidden = false; els.choose.classList.remove('leaving');
    els.chooseHint.textContent = 'Choose how to listen';
    S.source = null; S.timeline = 'preview';
  }

  /* ---------- station changes ---------- */
  function poll() {
    fetchJson('/radio.json').then(function (d) {
      if (!S.data || d.startedAt !== S.data.startedAt || d.station.id !== S.data.station.id) {
        var switching = !!S.data;
        S.data = d;
        els.station.textContent = d.station.name; els.chooseStation.textContent = d.station.name;
        if (switching && S.playing) { say('Switching to ' + d.station.name + '…'); resume(); }
        if (!S.playing) { var s = schedule(d, 'preview'); if (s) showTrack(s.idx); }
      } else if (S.data && d.updated !== S.data.updated) {
        S.data = d; // same station, refreshed details (Spotify matches filling in)
      }
    }).catch(function () {});
  }

  /* ---------- boot ---------- */
  function init() {
    ['status', 'station', 'title', 'artist', 'link', 'art', 'back', 'progress', 'play', 'pause', 'volume', 'onair', 'stage', 'choose', 'source', 'switch', 'start', 'embed'].forEach(function (k) { els[k] = $('rd-' + k); });
    els.pickApple = $('rd-pick-apple'); els.pickSpotify = $('rd-pick-spotify'); els.pickPreviews = $('rd-pick-previews');
    els.chooseStation = $('rd-choose-station'); els.chooseHint = document.querySelector('.rd-choose-hint'); els.embedSlot = $('rd-embed-slot');

    els.pickApple.addEventListener('click', pickApple);
    els.pickSpotify.addEventListener('click', pickSpotify);
    els.pickPreviews.addEventListener('click', pickPreviews);
    els.play.addEventListener('click', resume);
    els.pause.addEventListener('click', pause);
    els.switch.addEventListener('click', switchService);
    els.start.addEventListener('click', function () { start('spotify'); });
    els.volume.addEventListener('input', function () { setVolume(parseFloat(els.volume.value)); });
    document.addEventListener('keydown', function (e) { if (e.key === ' ' && S.source && e.target === document.body) { e.preventDefault(); S.playing ? pause() : resume(); } });
    try { var v = localStorage.getItem('radio-volume'); if (v) els.volume.value = v; } catch (e) {}

    Promise.all([fetchJson('/radio.json'), fetchJson('/radio-token.json').catch(function () { return {}; })])
      .then(function (r) {
        S.data = r[0]; S.cfg = r[1] || {};
        els.station.textContent = S.data.station.name; els.chooseStation.textContent = S.data.station.name;
        var s = schedule(S.data, 'preview'); if (s) showTrack(s.idx);
        if (!S.cfg.spotifyClientId) els.pickSpotify.querySelector('.rd-half-sub').textContent = 'Not set up yet';
        S.timers.ui = setInterval(tickUI, 500);
        S.timers.poll = setInterval(poll, POLL_MS);
        S.timers.drift = setInterval(function () { appleDrift(); spotifyDrift(); }, 30000);
        // Back from Spotify's login page: show the player and wait for a tap (browsers need one before audio).
        return spHandleCallback().then(function (cameBack) {
          if (!cameBack) return;
          showPlayer(); S.source = 'spotify'; els.source.textContent = sourceLabel();
          els.start.hidden = false; say('Signed in to Spotify.');
        }).catch(function (e) { els.chooseHint.textContent = (e && e.message) || 'Spotify sign-in failed.'; });
      })
      .catch(function () {
        els.chooseStation.textContent = 'Off air';
        els.chooseHint.textContent = 'No station yet. Olisa hasn’t played a playlist recently.';
        els.pickApple.disabled = els.pickSpotify.disabled = els.pickPreviews.disabled = true;
      });
  }

  window.onSpotifyIframeApiReady = function (api) { window.__spIframeApi = api; };
  window.onSpotifyWebPlaybackSDKReady = function () {};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.OlisaRadio = { schedule: schedule, state: S };
})();
