// app.js — full-screen generative sun-position visualizer.
// Layers (back to front): sky gradient keyed to solar altitude, star field,
// sun glow, today's sun arc, sun disc, procedural ridge landscape seeded
// from the coordinates, haze bands + film grain. All astronomy comes from
// window.Solar (public/solar.js); city fallback list from window.CITIES.
(function () {
  'use strict';

  // ---------- query params (deterministic deep links for tests) ----------
  var params = new URLSearchParams(location.search);
  function numParam(k, min, max) {
    var raw = params.get(k);
    if (raw === null || raw === '') return null;
    var v = Number(raw);
    return (isFinite(v) && v >= min && v <= max) ? v : null;
  }
  var urlLat = numParam('lat', -90, 90);
  var urlLon = numParam('lon', -180, 180);
  var fixedTime = null;
  if (params.get('t')) {
    var parsed = new Date(params.get('t')); // ISO local time
    if (!isNaN(parsed.getTime())) fixedTime = parsed;
  }
  var startHudHidden = params.get('hud') === '0';

  // ---------- DOM ----------
  var canvas = document.getElementById('sky-canvas');
  var ctx = canvas.getContext('2d');
  var hud = document.getElementById('hud');
  var el = {
    live: document.getElementById('hud-live'),
    now: document.getElementById('btn-now'),
    loc: document.getElementById('hud-loc'),
    changeLoc: document.getElementById('btn-loc'),
    alt: document.getElementById('hud-alt'),
    az: document.getElementById('hud-az'),
    sunrise: document.getElementById('hud-sunrise'),
    noon: document.getElementById('hud-noon'),
    sunset: document.getElementById('hud-sunset'),
    daylen: document.getElementById('hud-daylen'),
    countdown: document.getElementById('hud-countdown'),
    panel: document.getElementById('loc-panel'),
    cityInput: document.getElementById('city-input'),
    cityResults: document.getElementById('city-results'),
    latInput: document.getElementById('lat-input'),
    lonInput: document.getElementById('lon-input'),
    geoBtn: document.getElementById('btn-geo'),
    setBtn: document.getElementById('btn-set'),
    coordErr: document.getElementById('coord-error'),
    closePanel: document.getElementById('btn-close-panel'),
  };
  if (startHudHidden) hud.classList.add('hidden');

  // ---------- state ----------
  var loc = null; // { lat, lon, label, source }
  var locating = false;
  var scrubMs = null;        // ms epoch while dragging the bottom scrubber
  var ease = null;           // { fromMs, start } easing back to live
  var W = 0, H = 0, DPR = 1;
  var rafId = null;

  var PLACEHOLDER = { lat: 0, lon: 0, label: 'No location set', placeholder: true };
  function currentLoc() { return loc || PLACEHOLDER; }

  // ---------- deterministic PRNG / noise ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function latticeHash(n, seed) {
    var s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return s - Math.floor(s);
  }
  function vnoise(x, seed) {
    var i = Math.floor(x), f = x - i;
    var u = f * f * (3 - 2 * f);
    return latticeHash(i, seed) * (1 - u) + latticeHash(i + 1, seed) * u;
  }

  // ---------- precomputed generative assets ----------
  // Stars: constant seed so a frozen-time frame is fully reproducible.
  var STARS = (function () {
    var rnd = mulberry32(1337);
    var out = [];
    for (var i = 0; i < 420; i++) {
      out.push({
        x: rnd(), y: rnd(),                 // fractions of (width, sky height)
        r: 0.4 + rnd() * 1.1,
        phase: rnd() * Math.PI * 2,
        speed: 0.4 + rnd() * 1.6,
        base: 0.35 + rnd() * 0.65,
      });
    }
    return out;
  })();

  // Film grain: generated once into an offscreen canvas, seeded.
  var grainPattern = null;
  function makeGrain() {
    var g = document.createElement('canvas');
    g.width = 160; g.height = 160;
    var gc = g.getContext('2d');
    var img = gc.createImageData(160, 160);
    var rnd = mulberry32(4242);
    for (var i = 0; i < img.data.length; i += 4) {
      var v = Math.floor(rnd() * 255);
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v;
      img.data[i + 3] = 26;
    }
    gc.putImageData(img, 0, 0);
    grainPattern = ctx.createPattern(g, 'repeat');
  }

  // Landscape seed derives from the coordinates: same place, same ridges.
  function ridgeSeed() {
    var L = currentLoc();
    return ((Math.round(L.lat * 100) * 73856.093) + (Math.round(L.lon * 100) * 19349.663)) % 100000;
  }

  // ---------- time model ----------
  function easeInOut(k) { return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; }
  function viewTime() {
    if (fixedTime) return fixedTime;
    if (scrubMs !== null) return new Date(scrubMs);
    if (ease) {
      var k = Math.min(1, (performance.now() - ease.start) / 2000);
      var target = Date.now();
      if (k >= 1) { ease = null; return new Date(target); }
      return new Date(ease.fromMs + (target - ease.fromMs) * easeInOut(k));
    }
    return new Date();
  }
  function isLive() { return !fixedTime && scrubMs === null && !ease; }
  // Animation clock: frozen at 0 under a `t` deep link so screenshots of the
  // same URL are identical frame to frame (no twinkle/haze drift).
  function animT() { return fixedTime ? 0 : performance.now() / 1000; }

  // ---------- solar event cache ----------
  var evCache = { key: '', ev: null, noonAz: 180 };
  function eventsFor(t) {
    var L = currentLoc();
    var key = t.getFullYear() + '-' + t.getMonth() + '-' + t.getDate() + '|' + L.lat + ',' + L.lon;
    if (evCache.key !== key) {
      var ev = Solar.events(t, L.lat, L.lon);
      evCache = {
        key: key,
        ev: ev,
        noonAz: Solar.position(ev.solarNoon, L.lat, L.lon).azimuth,
      };
    }
    return evCache;
  }

  // ---------- projection ----------
  function horizonY() { return H * 0.62; }
  function project(az, alt, centerAz) {
    var dAz = ((az - centerAz + 540) % 360) - 180;
    var x = W / 2 + (dAz / 110) * (W / 2);
    var hy = horizonY();
    var y = alt >= 0
      ? hy - (alt / 90) * (hy - H * 0.05)
      : hy + (-alt / 90) * (H - hy) * 0.85;
    return { x: x, y: y };
  }

  // ---------- palette ----------
  // Keyframes keyed to SOLAR ALTITUDE (correct at every latitude/season).
  // Each entry: [altitude, [top, upper, lower, horizon] as [h, s, l]].
  var PALETTE = [
    [-90, [[232, 50, 3], [233, 45, 5], [234, 40, 8], [230, 32, 11]]],
    [-18, [[232, 50, 4], [233, 45, 7], [234, 42, 10], [228, 35, 14]]],
    [-12, [[230, 55, 6], [232, 50, 10], [236, 45, 15], [252, 35, 22]]],
    [-6,  [[224, 60, 10], [228, 55, 17], [250, 42, 28], [278, 38, 34]]],
    [-2,  [[221, 55, 16], [233, 45, 26], [292, 36, 38], [18, 82, 52]]],
    [2,   [[212, 58, 32], [218, 50, 44], [26, 74, 58], [36, 94, 62]]],
    [10,  [[208, 62, 48], [206, 58, 58], [36, 58, 68], [44, 78, 74]]],
    [25,  [[210, 68, 52], [205, 62, 62], [200, 50, 72], [46, 48, 80]]],
    [60,  [[214, 72, 44], [208, 66, 58], [200, 55, 70], [195, 45, 80]]],
  ];
  function lerp(a, b, k) { return a + (b - a) * k; }
  function lerpHue(a, b, k) {
    var d = ((b - a + 540) % 360) - 180;
    return (a + d * k + 360) % 360;
  }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function paletteFor(alt, isMorning) {
    var i = 0;
    while (i < PALETTE.length - 2 && alt > PALETTE[i + 1][0]) i++;
    var a = PALETTE[i], b = PALETTE[i + 1];
    var k = clamp((alt - a[0]) / (b[0] - a[0]), 0, 1);
    var stops = [];
    for (var s = 0; s < 4; s++) {
      var h = lerpHue(a[1][s][0], b[1][s][0], k);
      var sat = lerp(a[1][s][1], b[1][s][1], k);
      var lig = lerp(a[1][s][2], b[1][s][2], k);
      // Dawn/dusk bias on the lower sky: mornings cooler/pinker, evenings
      // warmer/redder — only near the horizon-crossing window.
      if (s >= 2 && Math.abs(alt) < 12 && (h < 70 || h > 300)) {
        h = (h + (isMorning ? -9 : 5) + 360) % 360;
        if (!isMorning) sat = clamp(sat + 4, 0, 100);
      }
      stops.push([h, sat, lig]);
    }
    return stops;
  }
  function hsl(c, a) {
    return a === undefined
      ? 'hsl(' + c[0].toFixed(1) + ',' + c[1].toFixed(1) + '%,' + c[2].toFixed(1) + '%)'
      : 'hsla(' + c[0].toFixed(1) + ',' + c[1].toFixed(1) + '%,' + c[2].toFixed(1) + '%,' + a + ')';
  }

  // ---------- drawing ----------
  function drawFrame() {
    var t = viewTime();
    var L = currentLoc();
    var cache = eventsFor(t);
    var ev = cache.ev;
    var centerAz = cache.noonAz;
    var pos = Solar.position(t, L.lat, L.lon);
    var isMorning = t < ev.solarNoon;
    var pal = paletteFor(pos.altitude, isMorning);
    var hy = horizonY();
    var at = animT();

    // 1. Sky gradient
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, hsl(pal[0]));
    grad.addColorStop(0.32, hsl(pal[1]));
    grad.addColorStop(hy / H, hsl(pal[3]));
    grad.addColorStop(1, hsl(pal[2]));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 2. Stars (fade in through twilight; frozen when time is frozen)
    var starAlpha = clamp((-4 - pos.altitude) / 8, 0, 1);
    if (starAlpha > 0) {
      for (var i = 0; i < STARS.length; i++) {
        var st = STARS[i];
        var y = st.y * (hy - 6);
        var tw = 0.6 + 0.4 * Math.sin(at * st.speed + st.phase);
        ctx.fillStyle = 'rgba(230,238,255,' + (starAlpha * st.base * tw).toFixed(3) + ')';
        ctx.fillRect(st.x * W, y, st.r, st.r);
      }
    }

    var sp = project(pos.azimuth, pos.altitude, centerAz);

    // 3. Sun glow (also below the horizon, as the pre-dawn / post-dusk hint)
    var warm = clamp(1 - pos.altitude / 25, 0, 1); // 1 near/below horizon
    var glowA = pos.altitude >= 0
      ? 0.55
      : 0.55 * clamp(1 + pos.altitude / 14, 0, 1); // fades out by ~-14°
    if (glowA > 0.01) {
      var glowR = W * (0.28 + 0.2 * warm);
      var glowCol = [lerp(48, 20, warm), lerp(90, 100, warm), lerp(80, 58, warm)];
      var rg = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, glowR);
      rg.addColorStop(0, hsl(glowCol, glowA));
      rg.addColorStop(0.4, hsl(glowCol, glowA * 0.25));
      rg.addColorStop(1, hsl(glowCol, 0));
      ctx.fillStyle = rg;
      ctx.fillRect(sp.x - glowR, sp.y - glowR, glowR * 2, glowR * 2);
    }

    // 4. Today's sun arc (sampled every 10 min over 24h)
    var midnight = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    ctx.save();
    ctx.setLineDash([2, 6]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    var started = false;
    for (var m = 0; m <= 1440; m += 10) {
      var pt = Solar.position(new Date(midnight.getTime() + m * 60000), L.lat, L.lon);
      var pp = project(pt.azimuth, pt.altitude, centerAz);
      if (!started) { ctx.moveTo(pp.x, pp.y); started = true; }
      else ctx.lineTo(pp.x, pp.y);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.stroke();
    ctx.restore();

    // Markers: sunrise / sunset on the horizon, solar noon at the top.
    function marker(when, fill) {
      if (!when) return;
      var mpos = Solar.position(when, L.lat, L.lon);
      var mp = project(mpos.azimuth, mpos.altitude, centerAz);
      ctx.beginPath();
      ctx.arc(mp.x, mp.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
    }
    marker(ev.sunrise, 'rgba(255,200,120,0.8)');
    marker(ev.sunset, 'rgba(255,150,90,0.8)');
    marker(ev.solarNoon, 'rgba(255,255,255,0.55)');

    // 5. Sun disc — larger and warmer near the horizon.
    if (pos.altitude > -6) {
      var discR = (10 + 10 * warm) * Math.min(1, (pos.altitude + 6) / 6);
      if (discR > 0.5) {
        var discCol = [lerp(46, 22, warm), 100, lerp(88, 62, warm)];
        ctx.save();
        ctx.shadowColor = hsl(discCol, 0.9);
        ctx.shadowBlur = 24 + 30 * warm;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, discR, 0, Math.PI * 2);
        ctx.fillStyle = hsl(discCol);
        ctx.fill();
        ctx.restore();
      }
    }

    // 6. Landscape — 3 ridge silhouettes from seeded value noise, tinted
    // from the current horizon color so they read as backlit at dusk.
    var seed = ridgeSeed();
    var ridgeDefs = [
      { off: 0.005, amp: 0.055, freq: 0.0026, lk: 0.34 },
      { off: 0.050, amp: 0.075, freq: 0.0041, lk: 0.20 },
      { off: 0.115, amp: 0.090, freq: 0.0060, lk: 0.10 },
    ];
    for (var r = 0; r < 3; r++) {
      var rd = ridgeDefs[r];
      var base = hy + rd.off * H;
      var rSeed = seed + r * 101.7;
      ctx.beginPath();
      ctx.moveTo(-2, H + 2);
      for (var x = -2; x <= W + 4; x += 4) {
        var n = vnoise(x * rd.freq, rSeed) * 0.65 + vnoise(x * rd.freq * 2.7, rSeed + 7.3) * 0.35;
        ctx.lineTo(x, base - n * rd.amp * H);
      }
      ctx.lineTo(W + 2, H + 2);
      ctx.closePath();
      ctx.fillStyle = hsl([pal[3][0], pal[3][1] * 0.5, Math.max(2.5, pal[3][2] * rd.lk)]);
      ctx.fill();
    }

    // 7. Atmosphere — drifting haze bands (daytime only) + film grain.
    var daylight = clamp((pos.altitude + 6) / 12, 0, 1);
    if (daylight > 0.02) {
      for (var b = 0; b < 3; b++) {
        var by = hy - H * (0.055 + 0.085 * b);
        var bh = H * (0.018 + 0.012 * b);
        var drift = ((at * (4 + b * 3) + b * 997) % (W * 2)) - W * 0.5;
        var hg = ctx.createLinearGradient(drift - W * 0.5, 0, drift + W * 0.9, 0);
        hg.addColorStop(0, 'rgba(255,255,255,0)');
        hg.addColorStop(0.5, 'rgba(255,255,255,' + (0.055 * daylight).toFixed(3) + ')');
        hg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = hg;
        ctx.fillRect(0, by, W, bh);
      }
    }
    if (grainPattern) {
      ctx.save();
      ctx.globalAlpha = 0.05;
      ctx.fillStyle = grainPattern;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // Scrub timeline while dragging
    if (scrubMs !== null) {
      var frac = (scrubMs - midnight.getTime()) / 86400000;
      var barY = H - 34;
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(W * 0.06, barY, W * 0.88, 2);
      ctx.beginPath();
      ctx.arc(W * 0.06 + W * 0.88 * clamp(frac, 0, 1), barY + 1, 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(fmtTime(new Date(scrubMs)), W / 2, barY - 12);
    }

    updateHud(t, pos, ev);
  }

  // ---------- HUD ----------
  function fmtTime(d) {
    return d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
  }
  function fmtDur(ms) {
    var mins = Math.round(ms / 60000);
    return Math.floor(mins / 60) + 'h ' + String(mins % 60).padStart(2, '0') + 'm';
  }
  function cardinal(az) {
    var dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(az / 22.5) % 16];
  }
  var lastHudKey = '';
  function updateHud(t, pos, ev) {
    var key = Math.floor(t.getTime() / 1000) + '|' + currentLoc().label + '|' + (scrubMs !== null) + '|' + isLive();
    if (key === lastHudKey) return;
    lastHudKey = key;

    var L = currentLoc();
    el.loc.textContent = locating ? 'Locating…' : L.label;
    el.alt.textContent = pos.altitude.toFixed(1) + '°';
    el.az.textContent = pos.azimuth.toFixed(0) + '° ' + cardinal(pos.azimuth);

    if (ev.polar) {
      var polarLabel = ev.polar === 'day' ? 'Sun up all day' : 'Polar night';
      el.sunrise.textContent = '—';
      el.sunset.textContent = '—';
      el.daylen.textContent = ev.polar === 'day' ? '24h 00m' : '0h 00m';
      el.countdown.textContent = polarLabel;
    } else {
      el.sunrise.textContent = fmtTime(ev.sunrise);
      el.sunset.textContent = fmtTime(ev.sunset);
      el.daylen.textContent = fmtDur(ev.dayLengthMs);
      if (pos.altitude < -0.833) {
        var next = ev.sunrise;
        if (!next || t >= next) {
          var tomorrow = Solar.events(new Date(t.getTime() + 86400000), L.lat, L.lon);
          next = tomorrow.sunrise;
        }
        el.countdown.textContent = next ? 'Sunrise in ' + fmtDur(next - t) : '';
      } else {
        el.countdown.textContent = '';
      }
    }
    el.noon.textContent = fmtTime(ev.solarNoon);

    // LIVE / SCRUB indicator
    if (isLive()) {
      el.live.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>LIVE';
      el.live.className = 'inline-flex items-center gap-1 text-[11px] font-semibold tracking-wide text-emerald-400';
      el.now.classList.add('hidden');
    } else if (fixedTime) {
      el.live.textContent = 'FIXED ' + fmtTime(fixedTime);
      el.live.className = 'inline-flex items-center gap-1 text-[11px] font-semibold tracking-wide text-sky-300';
      el.now.classList.add('hidden');
    } else {
      el.live.textContent = 'SCRUB ' + fmtTime(t);
      el.live.className = 'inline-flex items-center gap-1 text-[11px] font-semibold tracking-wide text-amber-300';
      el.now.classList.remove('hidden');
    }
  }

  // ---------- location flow ----------
  function fmtCoords(lat, lon) {
    return Math.abs(lat).toFixed(2) + '°' + (lat >= 0 ? 'N' : 'S') + ', ' +
           Math.abs(lon).toFixed(2) + '°' + (lon >= 0 ? 'E' : 'W');
  }
  function saveLoc(l) {
    try { localStorage.setItem('sunviz.location', JSON.stringify(l)); } catch (_) {}
  }
  function loadLoc() {
    try {
      var v = JSON.parse(localStorage.getItem('sunviz.location'));
      if (v && isFinite(v.lat) && isFinite(v.lon) &&
          Math.abs(v.lat) <= 90 && Math.abs(v.lon) <= 180) return v;
    } catch (_) {}
    return null;
  }
  function setLocation(l, persist) {
    loc = l;
    locating = false;
    evCache.key = ''; // invalidate solar event cache
    lastHudKey = '';
    if (persist) saveLoc(l);
    hidePanel();
  }
  function tryGeolocate(openPanelOnFail) {
    var done = false;
    function fail() {
      if (done) return;
      done = true;
      locating = false;
      lastHudKey = '';
      if (openPanelOnFail && !loc) showPanel();
    }
    try {
      if (!navigator.geolocation) return fail();
      locating = true;
      lastHudKey = '';
      navigator.geolocation.getCurrentPosition(function (p) {
        if (done) return;
        done = true;
        setLocation({
          lat: +p.coords.latitude.toFixed(4),
          lon: +p.coords.longitude.toFixed(4),
          label: 'Your location (' + fmtCoords(p.coords.latitude, p.coords.longitude) + ')',
          source: 'geo',
        }, true);
      }, fail, { timeout: 8000, maximumAge: 600000, enableHighAccuracy: false });
      // Belt and braces: some environments (iframe permissions policy)
      // neither resolve nor reject — treat that exactly like a denial.
      setTimeout(fail, 9000);
    } catch (_) { fail(); }
  }

  function showPanel() {
    el.panel.classList.remove('hidden');
    el.panel.classList.add('flex');
  }
  function hidePanel() {
    el.panel.classList.add('hidden');
    el.panel.classList.remove('flex');
  }
  function renderCityResults(q) {
    var out = [];
    if (q.length >= 2) {
      var needle = q.toLowerCase();
      for (var i = 0; i < window.CITIES.length && out.length < 8; i++) {
        var c = window.CITIES[i];
        if (c[0].toLowerCase().indexOf(needle) !== -1 ||
            c[1].toLowerCase().indexOf(needle) !== -1) out.push(c);
      }
    }
    el.cityResults.innerHTML = '';
    out.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'w-full text-left px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-sm text-zinc-200';
      b.textContent = c[0] + ', ' + c[1];
      b.addEventListener('click', function () {
        setLocation({ lat: c[2], lon: c[3], label: c[0] + ', ' + c[1], source: 'city' }, true);
      });
      el.cityResults.appendChild(b);
    });
  }

  el.changeLoc.addEventListener('click', showPanel);
  el.closePanel.addEventListener('click', hidePanel);
  el.geoBtn.addEventListener('click', function () { tryGeolocate(false); hidePanel(); });
  el.cityInput.addEventListener('input', function () { renderCityResults(el.cityInput.value.trim()); });
  el.setBtn.addEventListener('click', function () {
    var la = Number(el.latInput.value), lo = Number(el.lonInput.value);
    if (!isFinite(la) || !isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180) {
      el.coordErr.classList.remove('hidden');
      return;
    }
    el.coordErr.classList.add('hidden');
    setLocation({ lat: la, lon: lo, label: fmtCoords(la, lo), source: 'manual' }, true);
  });

  // ---------- interaction: HUD toggle + time scrubber ----------
  var pointer = null; // { id, x0, y0, scrubbing, moved }
  canvas.addEventListener('pointerdown', function (e) {
    if (pointer) return;
    var scrubZone = e.clientY > window.innerHeight * 0.85;
    pointer = { id: e.pointerId, x0: e.clientX, y0: e.clientY, scrubbing: false, moved: false };
    if (scrubZone && !fixedTime) {
      pointer.scrubbing = true;
      ease = null;
      applyScrub(e.clientX);
    }
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!pointer || e.pointerId !== pointer.id) return;
    if (Math.abs(e.clientX - pointer.x0) + Math.abs(e.clientY - pointer.y0) > 8) pointer.moved = true;
    if (pointer.scrubbing) applyScrub(e.clientX);
  });
  function endPointer(e) {
    if (!pointer || e.pointerId !== pointer.id) return;
    if (pointer.scrubbing) {
      if (scrubMs !== null) ease = { fromMs: scrubMs, start: performance.now() };
      scrubMs = null;
      lastHudKey = '';
    } else if (!pointer.moved) {
      hud.classList.toggle('hidden');
    }
    pointer = null;
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  el.now.addEventListener('click', function () {
    scrubMs = null;
    ease = null;
    lastHudKey = '';
  });
  function applyScrub(clientX) {
    var frac = clamp((clientX / window.innerWidth - 0.06) / 0.88, 0, 1);
    var base = new Date();
    var midnight = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    scrubMs = midnight.getTime() + frac * 86400000;
    lastHudKey = '';
  }

  // ---------- boot ----------
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);

  function loop() {
    drawFrame();
    rafId = requestAnimationFrame(loop);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    } else if (rafId === null) {
      loop();
    }
  });

  resize();
  makeGrain();

  if (urlLat !== null && urlLon !== null) {
    // Deterministic deep link: bypasses geolocation AND storage, no persist.
    setLocation({ lat: urlLat, lon: urlLon, label: fmtCoords(urlLat, urlLon), source: 'url' }, false);
  } else {
    var stored = loadLoc();
    if (stored) setLocation(stored, false);
    else tryGeolocate(true);
  }

  loop();
})();
