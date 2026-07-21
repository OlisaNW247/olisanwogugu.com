/* Floating glowing squares background — black & white.
   Inspired by a field of translucent, overlapping neon squares, rendered
   in grayscale: white outlines of varying opacity that drift and pulse. */
(function () {
  "use strict";

  var canvas = document.getElementById("bg");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");

  // Respect "reduce motion" by calming the animation (slower drift, no
  // brightness pulsing) rather than freezing it outright, so the background
  // still moves everywhere while staying gentle for motion-sensitive users.
  var reduceMotionQuery =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)");
  var reduceMotion = reduceMotionQuery ? reduceMotionQuery.matches : false;

  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var W = 0,
    H = 0;
  var squares = [];

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function targetCount() {
    // Density scales with screen area, capped for performance.
    var area = window.innerWidth * window.innerHeight;
    return Math.max(60, Math.min(210, Math.round(area / 6200)));
  }

  function makeSquare() {
    var size = rand(10, 104);
    // A handful of brighter "hero" squares carry the glow.
    var hero = Math.random() < 0.18;
    return {
      x: rand(0, window.innerWidth),
      y: rand(0, window.innerHeight),
      size: size,
      vx: rand(-0.18, 0.18),
      vy: rand(-0.18, 0.18),
      base: hero ? rand(0.4, 0.72) : rand(0.08, 0.4), // base opacity
      amp: rand(0.06, 0.28), // pulse amplitude
      // Some squares get a faint fill for the "lit" look.
      fill: Math.random() < 0.28,
      phase: rand(0, Math.PI * 2),
      speed: rand(0.4, 1.5), // pulse speed
      hero: hero,
    };
  }

  function build() {
    squares = [];
    var n = targetCount();
    for (var i = 0; i < n; i++) squares.push(makeSquare());
  }

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build();
  }

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1.25;

    for (var i = 0; i < squares.length; i++) {
      var s = squares[i];

      // Drift (calmer when reduced motion is preferred).
      var motionScale = reduceMotion ? 0.4 : 1;
      s.x += s.vx * motionScale;
      s.y += s.vy * motionScale;

      // Wrap around edges (with margin so squares fade in/out off-screen).
      var m = s.size + 20;
      if (s.x < -m) s.x = W + m;
      else if (s.x > W + m) s.x = -m;
      if (s.y < -m) s.y = H + m;
      else if (s.y > H + m) s.y = -m;

      // Pulsing opacity.
      var pulse = reduceMotion
        ? 0
        : Math.sin(t * 0.001 * s.speed + s.phase);
      var alpha = Math.max(0.02, s.base + s.amp * pulse);

      var half = s.size / 2;
      var x = s.x - half;
      var y = s.y - half;

      ctx.shadowColor = "rgba(255,255,255," + Math.min(0.85, alpha) + ")";
      ctx.shadowBlur = (s.hero ? 12 : 6) + s.size * 0.18;

      if (s.fill) {
        ctx.fillStyle = "rgba(255,255,255," + alpha * 0.16 + ")";
        ctx.fillRect(x, y, s.size, s.size);
      }

      ctx.lineWidth = s.hero ? 1.6 : 1.15;
      ctx.strokeStyle = "rgba(255,255,255," + alpha + ")";
      ctx.strokeRect(x, y, s.size, s.size);
    }

    ctx.shadowBlur = 0;
  }

  var running = true;
  function loop(t) {
    draw(t);
    if (running) requestAnimationFrame(loop);
  }

  var resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });

  // Pause when the tab is hidden to save battery.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      running = false;
    } else if (!running) {
      running = true;
      requestAnimationFrame(loop);
    }
  });

  // Update live if the user toggles the OS "reduce motion" setting.
  if (reduceMotionQuery) {
    var onChange = function (e) {
      reduceMotion = e.matches;
    };
    if (reduceMotionQuery.addEventListener) {
      reduceMotionQuery.addEventListener("change", onChange);
    } else if (reduceMotionQuery.addListener) {
      reduceMotionQuery.addListener(onChange); // older Safari
    }
  }

  resize();
  requestAnimationFrame(loop);
})();
