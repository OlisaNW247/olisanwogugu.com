/* Olisa's radio — a synchronized 24/7 station built from whichever playlist Olisa last played.
   Everyone hears the same song at the same moment: the position is computed from the station's
   start time, never streamed. Three ways to hear it:
     apple    full songs through Apple Music (MusicKit JS), needs a subscription
     embed    Spotify's embedded player (full songs when logged in to Spotify there, previews otherwise)
     preview  Apple's 30-second previews, no sign-in */
(function () {
  'use strict';

  var PREVIEW_MS = 30000, POLL_MS = 60000, DRIFT_MS = 4000;

  var S = {
    data: null, cfg: null,
    source: null,          // 'apple' | 'embed' | 'preview'
    timeline: 'preview',   // 'full' | 'preview' — which clock the current source follows
    playing: false, idx: -1,
    music: null, audio: null,
    embed: null, embedUpdate: null, embedAt: 0, embedArmed: false,
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
  function sourceLabel() { return { apple: 'Apple Music', embed: 'Spotify', preview: 'Previews' }[S.source] || ''; }

  function showTrack(i) {
    var t = S.data.tracks[i]; if (!t) return;
    S.idx = i;
    els.title.textContent = t.song;
    els.artist.textContent = t.artist + (t.album ? '  —  ' + t.album : '');
    var link = S.source === 'embed' && t.spotifyId ? 'https://open.spotify.com/track/' + t.spotifyId : t.url;
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
  var appleSeq = 0, lastTuneAt = 0, lastErrorAt = 0, retriedSame = false, indexFixes = 0;
  function appleTune() {
    S.timeline = 'full';
    var s = live('full'); if (!s) return Promise.resolve();
    var bad = badSet(), guard = 0;
    while (bad.has(S.data.tracks[s.idx].id) && guard++ < S.data.tracks.length) s = skipCurrent('full', false);
    var music = S.music, seq = ++appleSeq;
    showTrack(s.idx);
    clearTimeout(S.timers.slot);
    if (S.audio) S.audio.pause();
    lastTuneAt = Date.now(); indexFixes = 0;
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

  /* ---------- Spotify's embedded player ---------- */
  function embedStart() {
    say('Loading Spotify’s player…');
    els.embed.hidden = false; document.body.classList.add('embed-mode');
    var apiReady = function () { return !!window.__spIframeApi; };
    return loadScript('https://open.spotify.com/embed/iframe-api/v1', apiReady, 25000)
      .catch(function (e) { log('spotify api load failed (' + (e && e.message) + '); retrying'); return loadScript('https://open.spotify.com/embed/iframe-api/v1?retry=' + Date.now(), apiReady, 25000); })
      .then(function () {
      return new Promise(function (resolve) {
        if (S.embed) return resolve();
        var s = live(S.timeline), t = S.data.tracks[s.idx];
        window.__spIframeApi.createController(els.embedSlot, { uri: 'spotify:track:' + (t.spotifyId || ''), width: '100%', height: 80 }, function (controller) {
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
              say(preview ? 'Previews \u00b7 log in to Spotify, then reload, for full songs' : 'Full songs \u00b7 Spotify');
              setTimeout(function () { if (S.playing && S.embedUpdate && S.embedUpdate.isPaused) { say('Press play on the Spotify player below.'); revealControls(); } }, 2500);
            }
            if (d.duration > 0 && d.isPaused && d.position >= d.duration - 1500 && d.position > 0) embedTune();
          });
          resolve();
        });
      });
    }).then(embedTune);
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
    else if (source === 'embed') { p = embedStart(); }
    else { say('30-second previews'); previewTune(); p = Promise.resolve(); }
    return p.catch(function (e) {
      log(source + ' failed: ' + ((e && (e.errorCode || e.message)) || e));
      S.source = 'preview'; els.source.textContent = sourceLabel();
      els.embed.hidden = true; document.body.classList.remove('embed-mode');
      say((source === 'apple' ? 'Apple Music couldn’t play here' : 'Spotify’s player couldn’t load') + ', so you’re hearing previews.');
      previewTune();
    });
  }
  function pause() {
    setTransport(false);
    clearTimeout(S.timers.slot);
    if (S.source === 'apple' && S.music) S.music.pause();
    if (S.source === 'embed' && S.embed) S.embed.pause();
    if (S.audio) S.audio.pause();
    say('Paused. Press play to rejoin live.');
  }
  function resume() {
    setTransport(true);
    if (S.source === 'apple') { say('Full songs · Apple Music'); appleTune(); }
    else if (S.source === 'embed') { embedTune(); }
    else { say('30-second previews'); previewTune(); }
  }
  function stopAll() {
    S.playing = false; clearTimeout(S.timers.slot);
    if (S.music) { try { S.music.stop(); } catch (e) {} }
    if (S.embed) { try { S.embed.pause(); } catch (e) {} }
    if (S.audio) S.audio.pause();
  }
  function setVolume(v) {
    if (S.music) S.music.volume = v;
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
  function pickSpotify() { showPlayer(); start('embed'); }
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
        S.timers.drift = setInterval(appleDrift, 30000);
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
