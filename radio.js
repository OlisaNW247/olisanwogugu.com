/* Olisa's radio — a synchronized 24/7 station built from whichever playlist Olisa last played.
   Everyone hears the same song at the same moment: the position is computed from the station's
   start time, never streamed. Three ways to hear it:
     apple    full songs through Apple Music (MusicKit JS), needs a subscription
     embed    Spotify's embedded player (full songs when logged in to Spotify there, previews otherwise)
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
    embed: null, embedUpdate: null, embedAt: 0, embedArmed: false,
    sp: { player: null, deviceId: null, state: null, stateAt: 0, windowStart: -1, windowEnd: -1 },
    shift: 0,              // ms this listener runs ahead of the station clock (after skipping unplayable songs)
    skips: 0,
    timers: {}
  };
  var els = {};
  var $ = function (id) { return document.getElementById(id); };
  var DEBUG = /[?&]debug/.test(location.search), LOG = [];
  function log(msg) {
    var line = new Date().toTimeString().slice(0, 8) + ' ' + msg;
    LOG.push(line); if (LOG.length > 40) LOG.shift();
    if (window.console) console.log('[radio] ' + msg);
    if (DEBUG && els.debug) els.debug.textContent = LOG.slice(-18).join('\n');
  }
  function stateName(st) { var P = window.MusicKit && MusicKit.PlaybackStates; if (!P) return String(st); for (var k in P) if (P[k] === st) return k; return String(st); }

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
  function live(timeline) { return schedule(S.data, timeline, Date.now() + S.shift); }
  var BAD_KEY = 'radio-unplayable';
  function badSet() { try { return new Set(JSON.parse(localStorage.getItem(BAD_KEY) || '[]')); } catch (e) { return new Set(); } }
  function rememberBad(id) { try { var b = badSet(); b.add(id); localStorage.setItem(BAD_KEY, JSON.stringify(Array.from(b).slice(-500))); } catch (e) {} }
  // Slide this listener's clock past the current song so the next one starts at once. Returns the new slot.
  function skipCurrent(timeline, persist) {
    var s = live(timeline); if (!s) return null;
    if (persist) rememberBad(S.data.tracks[s.idx].id);
    S.shift += (s.duration - s.offset) + 50;
    S.skips++;
    return live(timeline);
  }
  function slotTimer(s, fn) {
    clearTimeout(S.timers.slot);
    S.timers.slot = setTimeout(function () { if (S.playing) fn(); }, Math.max(250, s.duration - s.offset + 60));
  }

  /* ---------- UI ---------- */
  function say(msg) { els.status.textContent = msg || ''; }
  function hint(msg) { els.chooseHint.textContent = msg || ''; els.chooseHint.hidden = !msg; }
  function sourceLabel() { return { apple: 'Apple Music', spotify: 'Spotify', embed: 'Spotify', preview: 'Previews' }[S.source] || ''; }

  function showTrack(i) {
    var t = S.data.tracks[i]; if (!t) return;
    S.idx = i;
    els.title.textContent = t.song;
    els.artist.textContent = t.artist + (t.album ? '  —  ' + t.album : '');
    var link = (S.source === 'embed' || S.source === 'spotify') && t.spotifyId ? 'https://open.spotify.com/track/' + t.spotifyId : t.url;
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
    if (S.source === 'embed' && S.embedUpdate) { var u = S.embedUpdate; return { offset: u.position + (u.isPaused ? 0 : Date.now() - S.embedAt), duration: u.duration }; }
    return live(S.timeline);
  }
  function tickUI() {
    if (!S.data) return;
    if (S.source === 'preview' || !S.source) { var s = live('preview'); if (s && s.idx !== S.idx) showTrack(s.idx); }
    var pos = position();
    if (pos && pos.duration) els.progress.style.width = Math.min(100, (pos.offset / pos.duration) * 100) + '%';
  }
  function showPlayer() {
    els.choose.classList.add('leaving');
    setTimeout(function () { els.choose.hidden = true; }, 700);
    els.stage.hidden = false; els.dock.hidden = false;
    els.source.textContent = sourceLabel();
    document.body.classList.add('on-radio');
    revealControls();
  }
  // Controls and text stay hidden on the radio; a mouse move or tap shows them for a few seconds.
  function revealControls() {
    document.body.classList.add('show-controls');
    clearTimeout(S.timers.hide);
    S.timers.hide = setTimeout(function () { document.body.classList.remove('show-controls'); }, 3500);
  }
  function setTransport(playing) {
    S.playing = playing;
    els.onair.classList.toggle('live', playing);
    els.start.hidden = true; els.play.hidden = playing; els.pause.hidden = !playing; els.volume.hidden = false;
  }

  /* ---------- preview mode (plain <audio>) ---------- */
  function ensureAudio() {
    if (S.audio) return S.audio;
    S.audio = new Audio(); S.audio.preload = 'auto'; S.audio.volume = parseFloat(els.volume.value);
    S.audio.addEventListener('ended', function () { if (S.playing && S.source === 'preview') previewTune(); });
    S.audio.addEventListener('error', function () { if (S.playing && S.source === 'preview') setTimeout(previewTune, 1500); });
    return S.audio;
  }
  function seekPreview(audio, offsetMs) {
    var target = offsetMs / 1000;
    var seek = function () { try { if (Math.abs(audio.currentTime - target) > 1.5) audio.currentTime = target; } catch (e) {} };
    audio.addEventListener('loadedmetadata', seek, { once: true });
    audio.addEventListener('canplay', seek, { once: true });
  }
  function previewTune() {
    S.timeline = 'preview';
    var s = live('preview'); if (!s) return;
    var t = S.data.tracks[s.idx];
    showTrack(s.idx);
    ensureAudio();
    slotTimer(s, previewTune);
    if (!t.preview) { S.audio.pause(); return; }
    S.audio.src = t.preview;
    var target = s.offset / 1000;
    var seek = function () { try { if (Math.abs(S.audio.currentTime - target) > 1.5) S.audio.currentTime = target; } catch (e) {} };
    S.audio.addEventListener('loadedmetadata', seek, { once: true });
    S.audio.addEventListener('canplay', seek, { once: true });
    S.audio.play().catch(function () { say('Tap play to start listening.'); });
    setTimeout(function () { if (S.playing && S.source === 'preview' && S.audio.src.indexOf(t.preview) !== -1) { target = live('preview').offset / 1000; seek(); } }, 1200);
  }

  /* ---------- Apple Music (MusicKit JS) ---------- */
  function musicInstance() {
    if (!S.cfg || !S.cfg.token) return Promise.reject(new Error('Apple Music sign-in isn’t available right now.'));
    return loadScript('https://js-cdn.music.apple.com/musickit/v3/musickit.js', function () { return !!window.MusicKit; }).then(function () {
      if (S.music) return S.music;
      return MusicKit.configure({ developerToken: S.cfg.token, app: { name: 'Olisa’s radio', build: '1' } , suppressErrorDialog: true }).then(function () {
        S.music = MusicKit.getInstance();
        S.music.addEventListener('nowPlayingItemDidChange', function () {
          var item = S.music.nowPlayingItem;
          log('item -> ' + (item ? (item.attributes && item.attributes.name) + ' [' + S.music.nowPlayingItemIndex + ']' : 'none'));
          if (!item || !S.data || S.source !== 'apple') return;
          var i = S.data.tracks.findIndex(function (t) { return t.id === String(item.id); });
          // While a fresh load settles the player can briefly report the queue's first item; don't flash it.
          if (Date.now() - lastTuneAt < 4000 && i !== tunedIdx) { log('ignoring transient item [' + i + '] during load'); return; }
          if (i !== -1 && i !== S.idx) showTrack(i);
        });
        S.music.addEventListener('playbackStateDidChange', function () {
          var st = S.music.playbackState, P = MusicKit.PlaybackStates;
          log('state ' + stateName(st) + ' t=' + Math.round(S.music.currentPlaybackTime));
          if (S.playing && S.source === 'apple' && (st === P.ended || st === P.completed) && Date.now() - lastTuneAt > 10000) {
            // Repeat-all normally carries on by itself; only step in if it really stopped.
            setTimeout(function () { var now = S.music.playbackState; if (S.playing && S.source === 'apple' && (now === P.ended || now === P.completed || now === P.stopped)) { log('queue ended; re-tuning'); appleTune(); } }, 1500);
          }
        });
        S.music.addEventListener('mediaPlaybackError', function (e) { appleUnplayable(e); });
        return S.music;
      });
    });
  }
  var appleSeq = 0, lastTuneAt = 0, lastErrorAt = 0, retriedSame = false, indexFixes = 0, tunedIdx = -1;
  function appleTune() {
    S.timeline = 'full';
    var s = live('full'); if (!s) return Promise.resolve();
    var bad = badSet(), guard = 0;
    while (bad.has(S.data.tracks[s.idx].id) && guard++ < S.data.tracks.length) s = skipCurrent('full', false);
    var music = S.music, seq = ++appleSeq;
    showTrack(s.idx);
    clearTimeout(S.timers.slot);
    if (S.audio) S.audio.pause();
    lastTuneAt = Date.now(); indexFixes = 0; tunedIdx = s.idx;
    log('tune -> ' + S.data.tracks[s.idx].song + ' [' + s.idx + '] @' + Math.round(s.offset / 1000) + 's');
    music.repeatMode = MusicKit.PlayerRepeatMode.all;
    music.volume = parseFloat(els.volume.value);
    return music.setQueue({ songs: S.data.tracks.map(function (t) { return t.id; }), startPosition: s.idx, startTime: s.offset / 1000, startPlaying: true })
      .then(function () {
        if (seq !== appleSeq) return;
        // Some builds start at the top of the queue regardless; move to the right song if so.
        if (music.nowPlayingItemIndex !== s.idx && music.nowPlayingItemIndex !== undefined && typeof music.changeToMediaAtIndex === 'function') {
          log('queue started at [' + music.nowPlayingItemIndex + '], moving to [' + s.idx + ']');
          return music.changeToMediaAtIndex(s.idx).then(function () { if (seq === appleSeq) return music.seekToTime(live('full').offset / 1000); });
        }
      })
      .then(function () {
        if (seq !== appleSeq) return;
        // startPlaying should have begun playback; if nothing happened after a moment, press play once.
        setTimeout(function () {
          if (seq !== appleSeq || !S.playing) return;
          var P = MusicKit.PlaybackStates, st = music.playbackState;
          if (st !== P.playing && st !== P.loading && st !== P.waiting && st !== P.seeking && st !== P.stalled) { log('not playing (' + stateName(st) + '); play()'); music.play().catch(function (e) { log('play() failed: ' + (e && e.message)); }); }
        }, 3000);
        setTimeout(function () { if (seq === appleSeq) appleDrift(true); }, 8000);
      })
      .catch(function (e) {
        if (seq !== appleSeq) return;                       // superseded by a newer tune; ignore
        log('setQueue failed: ' + ((e && (e.errorCode || e.name || e.message)) || e));
        if (e && /abort/i.test(e.name || e.message || '')) return;
        appleUnplayable(e);
      });
  }
  // Apple won't play the current song here: licensing errors slide straight to the next song;
  // anything else (a network hiccup) gets one retry of the same song first.
  function appleUnplayable(e) {
    if (!S.playing || S.source !== 'apple') return;
    var code = String((e && (e.errorCode || e.name || e.message)) || '');
    log('playback error: ' + (code || '(no code)'));
    if (Date.now() - lastErrorAt < 5000) return;            // one action per error burst
    lastErrorAt = Date.now();
    if (S.skips > S.data.tracks.length * 2) { say('Apple Music can\u2019t play this station here.'); pause(); return; }
    var licensing = /LICENSE|UNAVAILABLE|NOT_FOUND|RESTRICTED|UNSUPPORTED|AGE|CONTENT/i.test(code);
    if (!licensing && !retriedSame) { retriedSame = true; log('retrying same song'); setTimeout(function () { if (S.playing && S.source === 'apple') appleTune(); }, 2000); return; }
    retriedSame = false;
    skipCurrent('full', licensing);
    appleTune();
  }
  function appleDrift(initial) {
    if (!S.playing || S.source !== 'apple' || !S.music) return;
    var music = S.music, P = MusicKit.PlaybackStates;
    if (music.playbackState !== P.playing) return;                        // never touch a loading player
    if (!initial && Date.now() - lastTuneAt < 15000) return;               // let a fresh tune settle
    var want = live('full'); if (!want) return;
    var idx = music.nowPlayingItemIndex, t = music.currentPlaybackTime * 1000;
    if (idx !== want.idx) {
      if (indexFixes >= 2) { log('index still off (' + idx + ' vs ' + want.idx + '); leaving the player alone'); return; }
      indexFixes++;
      log('index drift ' + idx + ' -> ' + want.idx);
      music.changeToMediaAtIndex(want.idx).then(function () { return music.seekToTime(live('full').offset / 1000); }).catch(function (e) { log('index fix failed: ' + (e && e.message)); });
      return;
    }
    if (Math.abs(t - want.offset) > 8000) { log('time drift ' + Math.round(t / 1000) + 's -> ' + Math.round(want.offset / 1000) + 's'); music.seekToTime(want.offset / 1000); }
  }

  /* ---------- Spotify sign-in (Authorization Code with PKCE, same tab so iOS never hands it to the app) ---------- */
  function spRedirectUri() { return location.origin + location.pathname; }
  function spStored() { try { return JSON.parse(localStorage.getItem('radio-spotify') || 'null'); } catch (e) { return null; } }
  function spStore(tok) { try { if (tok) localStorage.setItem('radio-spotify', JSON.stringify(tok)); else localStorage.removeItem('radio-spotify'); } catch (e) {} }
  function b64url(buf) { var s = ''; new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function spLogin() {
    if (!S.cfg || !S.cfg.spotifyClientId) { hint('Spotify sign-in isn’t set up yet.'); return; }
    var a = new Uint8Array(48); crypto.getRandomValues(a); var verifier = b64url(a.buffer);
    try { sessionStorage.setItem('radio-spotify-verifier', verifier); } catch (e) {}
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(function (hash) {
      // A script-driven navigation (not a tapped link) keeps iOS from opening the Spotify app.
      location.assign('https://accounts.spotify.com/authorize?' + new URLSearchParams({
        client_id: S.cfg.spotifyClientId, response_type: 'code', redirect_uri: spRedirectUri(), scope: SP_SCOPES,
        code_challenge_method: 'S256', code_challenge: b64url(hash), state: 'radio'
      }));
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
    history.replaceState(null, '', location.pathname + (DEBUG ? '?debug=1' : ''));
    if (q.has('error')) return Promise.reject(new Error('Spotify sign-in was ' + (q.get('error') === 'access_denied' ? 'cancelled.' : 'refused: ' + q.get('error'))));
    var verifier = ''; try { verifier = sessionStorage.getItem('radio-spotify-verifier') || ''; sessionStorage.removeItem('radio-spotify-verifier'); } catch (e) {}
    return spTokenRequest({ client_id: S.cfg.spotifyClientId, grant_type: 'authorization_code', code: q.get('code'), redirect_uri: spRedirectUri(), code_verifier: verifier }).then(function () { return true; });
  }
  function spSignedIn() { var t = spStored(); return !!(t && (Date.now() < t.exp || t.refresh)); }
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

  /* ---------- Spotify: full songs in our own player (Web Playback SDK, Premium) ---------- */
  function spotifyStart() {
    say('Connecting to Spotify…');
    return loadScript('https://sdk.scdn.co/spotify-player.js', function () { return !!(window.Spotify && window.Spotify.Player); }, 20000).then(function () {
      return new Promise(function (resolve, reject) {
        if (S.sp.player && S.sp.deviceId) return resolve();
        var player = new Spotify.Player({ name: 'Olisa’s radio', volume: parseFloat(els.volume.value), getOAuthToken: function (cb) { spAccessToken().then(cb).catch(function () { cb(''); }); } });
        S.sp.player = player;
        var settled = false;
        player.addListener('ready', function (e) { S.sp.deviceId = e.device_id; log('spotify player ready'); if (!settled) { settled = true; resolve(); } });
        player.addListener('not_ready', function () { S.sp.deviceId = null; });
        ['initialization_error', 'authentication_error', 'account_error', 'playback_error'].forEach(function (ev) {
          player.addListener(ev, function (e) { log('spotify ' + ev + ': ' + (e && e.message)); if (!settled && ev !== 'playback_error') { settled = true; reject(new Error(ev === 'account_error' ? 'premium' : ev)); } });
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
    // The run of songs finished (paused at 0 right after the end of a song): rejoin live.
    if (S.playing && state.paused && state.position === 0 && prev && !prev.paused && prev.duration && prev.position > prev.duration - 6000) setTimeout(spotifyTune, 300);
  }
  function spotifyTune() {
    if (S.source !== 'spotify' || !S.sp.deviceId) return Promise.resolve();
    S.timeline = 'full';
    var s = live('full'), guard = 0;
    while (!S.data.tracks[s.idx].spotifyId && guard++ < S.data.tracks.length) s = skipCurrent('full', false);
    var tracks = S.data.tracks;
    if (!tracks[s.idx].spotifyId) { say('This station isn’t on Spotify yet.'); return Promise.resolve(); }
    showTrack(s.idx);
    say('Full songs · Spotify');
    var uris = [], end = s.idx;
    for (var k = s.idx; k < tracks.length && uris.length < SP_WINDOW && tracks[k].spotifyId; k++) { uris.push('spotify:track:' + tracks[k].spotifyId); end = k; }
    S.sp.windowStart = s.idx; S.sp.windowEnd = end;
    clearTimeout(S.timers.slot);
    log('spotify play [' + s.idx + '..' + end + '] @' + Math.round(s.offset / 1000) + 's');
    return spApi('PUT', '/me/player/play?device_id=' + S.sp.deviceId, { uris: uris, offset: { position: 0 }, position_ms: Math.floor(s.offset) }).then(function (r) {
      if (r.status === 404) return new Promise(function (res) { setTimeout(res, 1200); }).then(spotifyTune);
      if (r.status === 403) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(/PREMIUM/i.test(JSON.stringify(j)) ? 'premium' : 'Spotify refused playback.'); });
      if (!r.ok && r.status !== 204) throw new Error('Spotify playback failed (' + r.status + ').');
    });
  }
  function spotifyDrift() {
    if (!S.playing || S.source !== 'spotify' || !S.sp.state || S.sp.state.paused) return;
    var want = live('full'); if (!want) return;
    var pos = position();
    if (S.idx !== want.idx) { if (want.idx < S.sp.windowStart || want.idx > S.sp.windowEnd || Math.abs(S.idx - want.idx) > 1) spotifyTune(); }
    else if (pos && Math.abs(pos.offset - want.offset) > DRIFT_MS) S.sp.player.seek(Math.floor(want.offset));
  }
  function spotifyStop() {
    if (S.sp.player) { try { S.sp.player.pause(); S.sp.player.disconnect(); } catch (e) {} }
    S.sp.player = null; S.sp.deviceId = null; S.sp.state = null;
  }

  /* ---------- Spotify's embedded player ---------- */
  function createEmbed(uri) {
    return new Promise(function (resolve, reject) {
      if (S.embed) { try { S.embed.destroy(); } catch (e) {} S.embed = null; }
      var slot = document.createElement('div'); els.embed.innerHTML = ''; els.embed.appendChild(slot);
      var done = false;
      try {
        window.__spIframeApi.createController(slot, { uri: uri, width: '100%', height: 80 }, function (controller) {
          done = true;
          S.embed = controller; log('spotify embed ready');
          controller.addListener('playback_update', function (e) {
            var d = e.data || {}; S.embedUpdate = d; S.embedAt = Date.now();
            if (!S.playing || S.source !== 'embed') return;
            if (S.embedArmed && d.duration > 0) {
              S.embedArmed = false;
              var want = S.data.tracks[S.idx];
              var preview = want && d.duration < want.duration - 5000;   // Spotify served a 30-second preview
              S.timeline = preview ? 'preview' : 'full';
              var sc = live(S.timeline);
              if (sc.idx !== S.idx) return embedTune();
              if (S.audio) S.audio.pause();
              controller.seek(Math.floor(sc.offset / 1000)); controller.play();
              els.login.hidden = !preview;
              say(preview ? 'Previews \u00b7 log in to Spotify for full songs' : 'Full songs \u00b7 Spotify');
              setTimeout(function () { if (S.playing && S.embedUpdate && S.embedUpdate.isPaused) { say('Press play on the Spotify player below.'); revealControls(); } }, 2500);
            }
            if (d.duration > 0 && d.isPaused && d.position >= d.duration - 1500 && d.position > 0) embedTune();
          });
          resolve();
        });
      } catch (e) { reject(e); }
      setTimeout(function () { if (!done) reject(new Error('Spotify\u2019s player did not start.')); }, 20000);
    });
  }
  function firstMatchedFrom(idx) {
    var t = S.data.tracks;
    return t.slice(idx).concat(t.slice(0, idx)).find(function (x) { return x.spotifyId; });
  }
  function embedStart() {
    say('Loading Spotify\u2019s player\u2026');
    els.embed.hidden = false; document.body.classList.add('embed-mode');
    var apiReady = function () { return !!window.__spIframeApi; };
    return loadScript('https://open.spotify.com/embed/iframe-api/v1', apiReady, 25000)
      .catch(function (e) { log('spotify api load failed (' + (e && e.message) + '); retrying'); return loadScript('https://open.spotify.com/embed/iframe-api/v1?retry=' + Date.now(), apiReady, 25000); })
      .then(function () {
        if (S.embed) return;
        // Create the player with a song Spotify knows; the live song may not be matched yet.
        var first = firstMatchedFrom(live(S.timeline).idx);
        if (!first) throw new Error('This station isn\u2019t on Spotify yet.');
        return createEmbed('spotify:track:' + first.spotifyId);
      })
      .then(embedTune);
  }
  // Back from Spotify's login page: rebuild the player so it picks up the login, no reload needed.
  var spLoginPending = false;
  function embedRefreshAfterLogin() {
    if (!spLoginPending || S.source !== 'embed' || !window.__spIframeApi) return;
    spLoginPending = false;
    var first = firstMatchedFrom(live(S.timeline).idx); if (!first) return;
    log('back from Spotify login; rebuilding player');
    say('Welcome back \u2014 press play for full songs');
    createEmbed('spotify:track:' + first.spotifyId).then(function () { S.timeline = 'full'; embedTune(); revealControls(); }).catch(function (e) { log('rebuild failed: ' + (e && e.message)); });
  }

  function embedTune() {
    if (S.source !== 'embed' || !S.embed) return;
    var s = live(S.timeline), guard = 0;
    // Songs with no Spotify match are skipped, so Spotify listeners never hit a gap.
    while (!S.data.tracks[s.idx].spotifyId && guard++ < S.data.tracks.length) s = skipCurrent(S.timeline, false);
    var t = S.data.tracks[s.idx];
    if (!t.spotifyId) { say('This station isn\u2019t on Spotify yet.'); S.embed.pause(); return; }
    showTrack(s.idx);
    slotTimer(s, embedTune);
    if (S.audio) S.audio.pause();
    S.embedArmed = true; S.embedUpdate = null;
    S.embed.loadUri('spotify:track:' + t.spotifyId);
    try { S.embed.play(); } catch (e) {}
    clearTimeout(S.timers.embedNudge);
    S.timers.embedNudge = setTimeout(function () {
      if (S.playing && S.source === 'embed' && S.embedArmed) { say('Press play on the Spotify player below.'); revealControls(); }
    }, 1800);
  }

  /* ---------- transport ---------- */
  function start(source) {
    S.source = source; els.source.textContent = sourceLabel();
    setTransport(true);
    var p;
    if (source === 'apple') { say('Full songs · Apple Music'); p = appleTune(); }
    else if (source === 'spotify') { p = spotifyStart(); }
    else if (source === 'embed') { p = embedStart(); }
    else { say('30-second previews'); previewTune(); p = Promise.resolve(); }
    return p.catch(function (e) {
      log(source + ' failed: ' + ((e && (e.errorCode || e.message)) || e));
      if (source === 'spotify') {
        // No Premium, not on the app's allow-list, or the player wouldn't start: use Spotify's embedded player instead.
        spotifyStop();
        var m = (e && e.message) || '';
        if (/authentication/.test(m)) spStore(null);
        say(m === 'premium' ? 'Full songs need Spotify Premium \u2014 using Spotify\u2019s player instead.' : 'Using Spotify\u2019s player instead.');
        return start('embed');
      }
      S.source = 'preview'; els.source.textContent = sourceLabel();
      els.embed.hidden = true; document.body.classList.remove('embed-mode');
      var why = (e && /station/.test(e.message || '')) ? e.message.replace(/\.$/, '') : (source === 'apple' ? 'Apple Music couldn\u2019t play here' : 'Spotify\u2019s player couldn\u2019t load');
      say(why + ', so you\u2019re hearing previews.');
      previewTune();
    });
  }
  function pause() {
    setTransport(false);
    clearTimeout(S.timers.slot);
    if (S.source === 'apple' && S.music) S.music.pause();
    if (S.source === 'spotify' && S.sp.player) S.sp.player.pause();
    if (S.source === 'embed' && S.embed) S.embed.pause();
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
    if (S.embed) { try { S.embed.pause(); } catch (e) {} }
    spotifyStop();
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
      .catch(function (e) { els.pickApple.disabled = false; hint((e && e.message) || 'Apple Music sign-in was cancelled.'); });
  }
  function pickSpotify() {
    if (!S.cfg || !S.cfg.spotifyClientId) { showPlayer(); start('embed'); return; }
    if (spSignedIn()) { showPlayer(); start('spotify'); return; }
    hint('Taking you to Spotify\u2026');
    spLogin();
  }
  function switchService() {
    stopAll();
    document.body.classList.remove('on-radio', 'show-controls', 'embed-mode');
    els.embed.hidden = true; els.login.hidden = true;
    els.stage.hidden = true; els.dock.hidden = true;
    els.choose.hidden = false; els.choose.classList.remove('leaving');
    hint('');
    S.source = null; S.timeline = 'preview'; S.shift = 0; S.skips = 0;
  }

  /* ---------- station changes ---------- */
  function poll() {
    fetchJson('/radio.json').then(function (d) {
      if (!S.data || d.startedAt !== S.data.startedAt || d.station.id !== S.data.station.id) {
        var switching = !!S.data;
        S.data = d; S.shift = 0; S.skips = 0;
        els.station.textContent = d.station.name;
        if (switching && S.playing) { say('Switching to ' + d.station.name + '…'); resume(); }
        if (!S.playing) { var s = live('preview'); if (s) showTrack(s.idx); }
      } else if (S.data && d.updated !== S.data.updated) {
        S.data = d; // same station, refreshed details (Spotify matches filling in)
      }
    }).catch(function () {});
  }

  /* ---------- boot ---------- */
  function init() {
    ['status', 'station', 'title', 'artist', 'link', 'login', 'art', 'back', 'progress', 'play', 'pause', 'volume', 'onair', 'stage', 'choose', 'source', 'switch', 'start', 'embed', 'dock'].forEach(function (k) { els[k] = $('rd-' + k); });
    els.pickApple = $('rd-pick-apple'); els.pickSpotify = $('rd-pick-spotify');
    els.chooseHint = $('rd-choose-hint'); els.embedSlot = $('rd-embed-slot');
    if (DEBUG) { els.debug = document.createElement('pre'); els.debug.id = 'rd-debug'; document.body.appendChild(els.debug); log('debug on'); }

    els.pickApple.addEventListener('click', pickApple);
    els.pickSpotify.addEventListener('click', pickSpotify);
    els.play.addEventListener('click', resume);
    els.pause.addEventListener('click', pause);
    els.switch.addEventListener('click', switchService);
    els.volume.addEventListener('input', function () { setVolume(parseFloat(els.volume.value)); });
    els.login.addEventListener('click', function (e) {
      e.preventDefault();
      if (S.cfg && S.cfg.spotifyClientId) { spLogin(); return; }     // proper sign-in when the app exists
      spLoginPending = true; location.assign(els.login.href);        // otherwise Spotify's site, same tab, no app
    });
    els.start.addEventListener('click', function () { start('spotify'); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') setTimeout(embedRefreshAfterLogin, 300); });
    window.addEventListener('focus', function () { setTimeout(embedRefreshAfterLogin, 300); });
    window.addEventListener('pageshow', function () { setTimeout(embedRefreshAfterLogin, 300); });
    document.addEventListener('keydown', function (e) { if (e.key === ' ' && S.source && e.target === document.body) { e.preventDefault(); S.playing ? pause() : resume(); } });
    try { var v = localStorage.getItem('radio-volume'); if (v) els.volume.value = v; } catch (e) {}
    ['mousemove', 'touchstart', 'keydown'].forEach(function (ev) { document.addEventListener(ev, function () { if (document.body.classList.contains('on-radio')) revealControls(); }, { passive: true }); });
    els.stage.addEventListener('click', function (e) { if (e.target === els.stage || e.target.closest('.rd-frame') || e.target === els.title) { if (!document.body.classList.contains('show-controls')) revealControls(); } });

    Promise.all([fetchJson('/radio.json'), fetchJson('/radio-token.json').catch(function () { return {}; })])
      .then(function (r) {
        S.data = r[0]; S.cfg = r[1] || {};
        els.station.textContent = S.data.station.name;
        var s = live('preview'); if (s) showTrack(s.idx);
        S.timers.ui = setInterval(tickUI, 500);
        S.timers.poll = setInterval(poll, POLL_MS);
        S.timers.drift = setInterval(function () { appleDrift(); spotifyDrift(); }, 30000);
        // Back from Spotify's sign-in page: show the player and wait for a tap (browsers need one before audio).
        spHandleCallback().then(function (cameBack) {
          if (!cameBack) return;
          showPlayer(); S.source = 'spotify'; els.source.textContent = sourceLabel();
          els.start.hidden = false; els.play.hidden = true; els.pause.hidden = true; say('Signed in to Spotify \u2014 tap to start');
          revealControls();
        }).catch(function (e) { hint((e && e.message) || 'Spotify sign-in failed.'); });
        // Warm Apple's player in the background so the tap only has to start playback.
        if (S.cfg.token) setTimeout(function () { musicInstance().then(function () { log('apple player warmed'); }).catch(function () {}); }, 500);
      })
      .catch(function () {
        hint('Off air \u2014 no station yet.');
        els.pickApple.disabled = els.pickSpotify.disabled = true;
      });
  }

  window.onSpotifyIframeApiReady = function (api) { window.__spIframeApi = api; };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.OlisaRadio = { schedule: schedule, state: S };
})();
