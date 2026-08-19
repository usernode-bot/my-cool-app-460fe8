// solar.js — self-contained solar position math (Meeus / NOAA low-precision,
// same approach as the SunCalc library, implemented here so the app has no
// dependency and no external API). All functions are pure functions of
// (Date, lat, lon) — no globals, no Date.now() — so the renderer can call
// them for the current time, scrubbed times, and arc sampling alike.
//
// Exposed as window.Solar:
//   Solar.position(date, lat, lon) -> { altitude, azimuth }   (degrees;
//       azimuth clockwise from north, 0–360; altitude refraction-corrected)
//   Solar.events(date, lat, lon)   -> { solarNoon, sunrise, sunset,
//       civilDawn, civilDusk, polar, dayLengthMs }
//       sunrise/sunset/dawn/dusk are Date or null; polar is null | 'day'
//       | 'night' when the sun never crosses the -0.833° horizon that day.
(function () {
  'use strict';

  var rad = Math.PI / 180;
  var dayMs = 86400000;
  var J1970 = 2440588;
  var J2000 = 2451545;

  function toJulian(date) { return date.valueOf() / dayMs - 0.5 + J1970; }
  function fromJulian(j) { return new Date((j + 0.5 - J1970) * dayMs); }
  function toDays(date) { return toJulian(date) - J2000; }

  // Obliquity of the ecliptic
  var e = rad * 23.4397;

  function rightAscension(l, b) {
    return Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  }
  function declination(l, b) {
    return Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  }
  function azimuthRad(H, phi, dec) {
    return Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  }
  function altitudeRad(H, phi, dec) {
    return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  }
  function siderealTime(d, lw) { return rad * (280.16 + 360.9856235 * d) - lw; }

  function solarMeanAnomaly(d) { return rad * (357.5291 + 0.98560028 * d); }
  function eclipticLongitude(M) {
    var C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    var P = rad * 102.9372; // perihelion of Earth
    return M + C + P + Math.PI;
  }
  function sunCoords(d) {
    var M = solarMeanAnomaly(d);
    var L = eclipticLongitude(M);
    return { dec: declination(L, 0), ra: rightAscension(L, 0) };
  }

  // Sæmundsson's refraction formula (degrees in, degrees out). Only
  // meaningful near/above the horizon; tapers to 0 below -1°.
  function refractionDeg(hDeg) {
    if (hDeg < -1) return 0;
    var h = Math.max(hDeg, -0.9);
    var r = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * rad) / 60; // arcmin -> deg
    return r > 0 ? r : 0;
  }

  function position(date, lat, lon) {
    var lw = rad * -lon;
    var phi = rad * lat;
    var d = toDays(date);
    var c = sunCoords(d);
    var H = siderealTime(d, lw) - c.ra;
    var alt = altitudeRad(H, phi, c.dec) / rad;
    alt += refractionDeg(alt);
    var az = azimuthRad(H, phi, c.dec) / rad + 180; // from-south -> from-north CW
    az = ((az % 360) + 360) % 360;
    return { altitude: alt, azimuth: az };
  }

  // ---- event times (hour-angle inversion, SunCalc-style) ----
  var J0 = 0.0009;
  function julianCycle(d, lw) { return Math.round(d - J0 - lw / (2 * Math.PI)); }
  function approxTransit(Ht, lw, n) { return J0 + (Ht + lw) / (2 * Math.PI) + n; }
  function solarTransitJ(ds, M, L) {
    return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  }
  function hourAngle(h, phi, dec) {
    return Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(dec)) /
                     (Math.cos(phi) * Math.cos(dec)));
  }

  function events(date, lat, lon) {
    var lw = rad * -lon;
    var phi = rad * lat;
    var d = toDays(date);
    var n = julianCycle(d, lw);
    var ds = approxTransit(0, lw, n);
    var M = solarMeanAnomaly(ds);
    var L = eclipticLongitude(M);
    var dec = declination(L, 0);
    var Jnoon = solarTransitJ(ds, M, L);
    var solarNoon = fromJulian(Jnoon);

    function pair(angleDeg) {
      var w = hourAngle(angleDeg * rad, phi, dec);
      if (isNaN(w)) return null; // sun never crosses this altitude today
      var Jset = solarTransitJ(approxTransit(w, lw, n), M, L);
      var Jrise = Jnoon - (Jset - Jnoon);
      return { rise: fromJulian(Jrise), set: fromJulian(Jset) };
    }

    var sun = pair(-0.833);
    var civil = pair(-6);
    var polar = null;
    if (!sun) {
      polar = position(solarNoon, lat, lon).altitude > -0.833 ? 'day' : 'night';
    }
    return {
      solarNoon: solarNoon,
      sunrise: sun ? sun.rise : null,
      sunset: sun ? sun.set : null,
      civilDawn: civil ? civil.rise : null,
      civilDusk: civil ? civil.set : null,
      polar: polar,
      dayLengthMs: sun ? (sun.set - sun.rise)
                       : (polar === 'day' ? dayMs : 0),
    };
  }

  window.Solar = { position: position, events: events };
})();
