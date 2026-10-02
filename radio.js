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
    var s = schedule(S.data, 'preview'); if (!s) return;
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

  /* ---------- Spotify's embedded player ---------- */
  function embedStart() {
    say('Loading Spotify’s player…');
    els.embed.hidden = false; document.body.classList.add('embed-mode');
    return loadScript('https://open.spotify.com/embed/iframe-api/v1', function () { return !!window.__spIframeApi; }).then(function () {
      return new Promise(function (resolve) {
        if (S.embed) return resolve();
        var s = schedule(S.data, S.timeline), t = S.data.tracks[s.idx];
        window.__spIframeApi.createController(els.embedSlot, { uri: 'spotify:track:' + (t.spotifyId || ''), width: '100%', height: 80 }, function (controller) {
          S.embed = controller;
          controller.addListener('playback_update', function (e) {
            var d = e.data || {}; S.embedUpdate = d; S.embedAt = Date.now();
            if (!S.playing || S.source !== 'embed') return;
            if (S.embedArmed && d.duration > 0) {
              S.embedArmed = false;
              var want = S.data.tracks[S.idx];
              var preview = want && d.duration < want.duration - 5000;   // Spotify served a 30-second preview
              S.timeline = preview ? 'preview' : 'full';
              var sc = schedule(S.data, S.timeline);
              if (sc.idx !== S.idx) return embedTune();
              if (S.audio) S.audio.pause();
              controller.seek(Math.floor(sc.offset / 1000)); controller.play();
              say(preview ? 'Spotify previews · log in to Spotify in the player for full songs' : 'Full songs · Spotify');
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
    var s = schedule(S.data, S.timeline), t = S.data.tracks[s.idx];
    showTrack(s.idx);
    slotTimer(s, embedTune);
    if (S.audio) S.audio.pause();
    if (!t.spotifyId) {
      // Not matched to Spotify (yet): fill the slot with Apple's 30-second preview rather than silence.
      S.embed.pause();
      say('Not on Spotify yet \u2014 playing the preview');
      if (t.preview && s.offset < PREVIEW_MS - 1500) { var a = ensureAudio(); a.src = t.preview; seekPreview(a, s.offset); a.play().catch(function () {}); }
      return;
    }
    S.embedArmed = true; S.embedUpdate = null;
    S.embed.loadUri('spotify:track:' + t.spotifyId);
  }

  /* ---------- transport ---------- */
  function start(source) {
    S.source = source; els.source.textContent = sourceLabel();
    setTransport(true);
    var p;
    if (source === 'apple') { say('Full songs · Apple Music'); p = appleTune(); }
    else if (source === 'embed') { p = embedStart(); }
    else { say('30-second previews'); previewTune(); p = Promise.resolve(); }
    return p.catch(function () {
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
      .catch(function (e) { els.pickApple.disabled = false; els.chooseHint.textContent = (e && e.message) || 'Apple Music sign-in was cancelled.'; });
  }
  function pickSpotify() { showPlayer(); start('embed'); }
  function pickPreviews() { showPlayer(); start('preview'); }
  function switchService() {
    stopAll();
    document.body.classList.remove('on-radio', 'show-controls', 'embed-mode');
    els.embed.hidden = true;
    els.stage.hidden = true; els.dock.hidden = true;
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
    ['status', 'station', 'title', 'artist', 'link', 'art', 'back', 'progress', 'play', 'pause', 'volume', 'onair', 'stage', 'choose', 'source', 'switch', 'start', 'embed', 'dock'].forEach(function (k) { els[k] = $('rd-' + k); });
    els.pickApple = $('rd-pick-apple'); els.pickSpotify = $('rd-pick-spotify'); els.pickPreviews = $('rd-pick-previews');
    els.chooseStation = $('rd-choose-station'); els.chooseHint = document.querySelector('.rd-choose-hint'); els.embedSlot = $('rd-embed-slot');

    els.pickApple.addEventListener('click', pickApple);
    els.pickSpotify.addEventListener('click', pickSpotify);
    els.pickPreviews.addEventListener('click', pickPreviews);
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
        els.station.textContent = S.data.station.name; els.chooseStation.textContent = S.data.station.name;
        var s = schedule(S.data, 'preview'); if (s) showTrack(s.idx);
        if (!S.data.tracks.some(function (t) { return t.spotifyId; })) els.pickSpotify.querySelector('.rd-half-sub').textContent = 'Still matching songs…';
        S.timers.ui = setInterval(tickUI, 500);
        S.timers.poll = setInterval(poll, POLL_MS);
        S.timers.drift = setInterval(appleDrift, 30000);
      })
      .catch(function () {
        els.chooseStation.textContent = 'Off air';
        els.chooseHint.textContent = 'No station yet. Olisa hasn’t played a playlist recently.';
        els.pickApple.disabled = els.pickSpotify.disabled = els.pickPreviews.disabled = true;
      });
  }

  window.onSpotifyIframeApiReady = function (api) { window.__spIframeApi = api; };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.OlisaRadio = { schedule: schedule, state: S };
})();
