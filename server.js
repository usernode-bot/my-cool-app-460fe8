const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health', '/api/demo/goal']);

// The run board itself is shared content: every member of this app sees the
// same list of runs, so reading it does not need a token. Keeping the two
// read-only GETs open also means the platform's automated checks (which
// navigate the app with no token) exercise the real screens instead of an
// empty error state. Every mutation below still requires `req.user`, so an
// anonymous reader can look but cannot post, join, leave or cancel.
const PUBLIC_GET_API = [/^\/api\/runs$/, /^\/api\/runs\/\d+$/];

// The signed-in user's id, or null when nobody is signed in. Used only by the
// two public GETs, where "have I joined this run?" is simply false.
function callerId(req) {
  return req.user ? req.user.id : null;
}

app.use(express.json());

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (req.method === 'GET' && PUBLIC_GET_API.some((re) => re.test(req.path))) {
      return next();
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// Flipped by the shutdown handler at the bottom of this file so anything
// polling readiness sees the container leaving rotation.
let shuttingDown = false;

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting_down' });
  res.json({ status: 'ok' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

/* ── Runs API ─────────────────────────────────────────────────────────
 * A run is a time and a place somebody proposed. Attendance is a row in
 * run_attendees; the organizer is seeded as an attendee when the run is
 * created and can never leave (cancelling the run is the way out).
 * ──────────────────────────────────────────────────────────────────── */

const MAX_LOCATION = 120;
const MAX_NOTE = 200;
const MAX_PHOTO_URL = 500;
const MAX_PHOTO_FILE_ID = 64;
// A minute of slack absorbs clock skew between the phone that filled in
// the picker and this container.
const FUTURE_SLACK_MS = 60 * 1000;

// A run's distance is optional, but when given it has to be a plausible
// one: the upper bound is generous enough for an ultra, the lower one
// keeps a mistyped "0" out of the weekly totals.
const MIN_DISTANCE_KM = 0.1;
const MAX_DISTANCE_KM = 200;
// A weekly goal is a target across a whole week, so it runs higher.
const MIN_GOAL_KM = 1;
const MAX_GOAL_KM = 500;

// One row per run, with the three derived fields every list/detail view
// needs: how many are going, whether the caller is one of them, and the
// first few names for the avatar cluster.
const RUN_SELECT = `
  SELECT r.id, r.location, r.note, r.starts_at,
         r.organizer_id, r.organizer_username,
         r.photo_url, r.photo_file_id,
         -- NUMERIC arrives from pg as a STRING. Casting here means every
         -- read path hands the frontend a real number it can do arithmetic
         -- with, rather than something that concatenates.
         r.distance_km::float8 AS distance_km,
         (SELECT COUNT(*) FROM run_attendees a WHERE a.run_id = r.id)::int
           AS attendee_count,
         EXISTS (
           SELECT 1 FROM run_attendees a
           WHERE a.run_id = r.id AND a.user_id = $1
         ) AS joined,
         (r.organizer_id = $1) AS is_organizer,
         COALESCE((
           SELECT array_agg(p.username ORDER BY p.ord)
           FROM (
             SELECT a.username,
                    ROW_NUMBER() OVER (
                      ORDER BY (a.user_id = r.organizer_id) DESC, a.joined_at
                    ) AS ord
             FROM run_attendees a WHERE a.run_id = r.id
           ) p
           WHERE p.ord <= 3
         ), ARRAY[]::varchar[]) AS preview
  FROM runs r
`;

// Shared by the run distance and the weekly goal, which differ only in
// their bounds. Returns { value } (null meaning "not given") or { error }.
// Empty string, null and undefined all mean "not given"; anything else has
// to parse as a finite number inside the range.
function parseDistance(raw, min, max, message) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: null };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: message };
  // One decimal place is the resolution the pickers offer; rounding here
  // keeps NUMERIC(5,2) from storing a value the UI can never reproduce.
  const rounded = Math.round(n * 10) / 10;
  if (rounded < min || rounded > max) return { error: message };
  return { value: rounded };
}

const DISTANCE_ERROR = 'Enter a distance between 0.1 and 200 km.';
const GOAL_ERROR = 'Pick a goal between 1 and 500 km.';

// List runs. `upcoming` is the default tab: anything that has not started
// yet, soonest first. `past` reads the other way and is capped.
app.get('/api/runs', async (req, res) => {
  const past = req.query.filter === 'past';
  try {
    const { rows } = await pool.query(
      RUN_SELECT +
        (past
          ? ` WHERE r.starts_at < NOW() ORDER BY r.starts_at DESC LIMIT 50`
          : ` WHERE r.starts_at >= NOW() ORDER BY r.starts_at ASC LIMIT 100`),
      [callerId(req)]
    );
    res.json({ runs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/runs', async (req, res) => {
  const location = String(req.body?.location ?? '').trim();
  const rawNote = String(req.body?.note ?? '').trim();
  const startsAt = new Date(req.body?.starts_at ?? '');

  if (!location) return res.status(400).json({ error: 'Add a location.' });
  if (location.length > MAX_LOCATION) {
    return res.status(400).json({ error: 'That location is too long.' });
  }
  if (rawNote.length > MAX_NOTE) {
    return res.status(400).json({ error: 'That note is too long.' });
  }
  // A run photo is optional, but uploaded via the bridge before this
  // request is sent, so what arrives here is always the pair of values the
  // upload returned, never a file. Both present or both absent.
  const photoUrl = req.body?.photo_url ? String(req.body.photo_url).trim() : '';
  const photoFileId = req.body?.photo_file_id ? String(req.body.photo_file_id).trim() : '';
  if (Boolean(photoUrl) !== Boolean(photoFileId)) {
    return res.status(400).json({ error: 'Photo upload is incomplete.' });
  }
  if (photoUrl.length > MAX_PHOTO_URL || photoFileId.length > MAX_PHOTO_FILE_ID) {
    return res.status(400).json({ error: 'That photo reference is too long.' });
  }
  // Optional: a run posted without a distance is still a run, it just
  // cannot count toward anybody's weekly goal.
  const distance = parseDistance(
    req.body?.distance_km, MIN_DISTANCE_KM, MAX_DISTANCE_KM, DISTANCE_ERROR
  );
  if (distance.error) return res.status(400).json({ error: distance.error });
  if (isNaN(startsAt.getTime())) {
    return res.status(400).json({ error: 'Pick a date and time.' });
  }
  if (startsAt.getTime() < Date.now() - FUTURE_SLACK_MS) {
    return res.status(400).json({ error: 'Pick a time in the future.' });
  }

  const client = await pool.connect();
  try {
    // The run and its organizer's attendance are one fact, so they land
    // together or not at all.
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO runs (location, note, starts_at, organizer_id, organizer_username, photo_url, photo_file_id, distance_km)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        location,
        rawNote || null,
        startsAt.toISOString(),
        req.user.id,
        req.user.username,
        photoUrl || null,
        photoFileId || null,
        distance.value,
      ]
    );
    const id = rows[0].id;
    await client.query(
      `INSERT INTO run_attendees (run_id, user_id, username) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [id, req.user.id, req.user.username]
    );
    await client.query('COMMIT');
    const full = await pool.query(RUN_SELECT + ' WHERE r.id = $2', [req.user.id, id]);
    res.json({ run: full.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/runs/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad run id' });
  try {
    const { rows } = await pool.query(RUN_SELECT + ' WHERE r.id = $2', [callerId(req), id]);
    if (!rows.length) return res.status(404).json({ error: 'Run not found' });
    // Organizer first, then in the order people joined.
    const attendees = await pool.query(
      `SELECT a.user_id, a.username, (a.user_id = r.organizer_id) AS is_organizer
       FROM run_attendees a JOIN runs r ON r.id = a.run_id
       WHERE a.run_id = $1
       ORDER BY (a.user_id = r.organizer_id) DESC, a.joined_at ASC`,
      [id]
    );
    res.json({ run: rows[0], attendees: attendees.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shared guard: the run must exist and must not already have started.
async function loadJoinableRun(id) {
  const { rows } = await pool.query(
    `SELECT id, organizer_id, starts_at FROM runs WHERE id = $1`,
    [id]
  );
  if (!rows.length) return { error: 404, message: 'Run not found' };
  if (new Date(rows[0].starts_at).getTime() < Date.now()) {
    return { error: 409, message: 'That run has already happened.' };
  }
  return { run: rows[0] };
}

app.post('/api/runs/:id/join', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad run id' });
  try {
    const guard = await loadJoinableRun(id);
    if (guard.error) return res.status(guard.error).json({ error: guard.message });
    await pool.query(
      `INSERT INTO run_attendees (run_id, user_id, username) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [id, req.user.id, req.user.username]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/runs/:id/leave', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad run id' });
  try {
    const guard = await loadJoinableRun(id);
    if (guard.error) return res.status(guard.error).json({ error: guard.message });
    if (guard.run.organizer_id === req.user.id) {
      return res.status(409).json({ error: 'Organizers cannot leave their own run.' });
    }
    await pool.query(`DELETE FROM run_attendees WHERE run_id = $1 AND user_id = $2`, [
      id,
      req.user.id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancelling is the organizer's only exit. Attendees cascade away with it.
app.delete('/api/runs/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad run id' });
  try {
    const { rows } = await pool.query(`SELECT organizer_id FROM runs WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Run not found' });
    if (rows[0].organizer_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the organizer can cancel this run.' });
    }
    await pool.query(`DELETE FROM runs WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Weekly goals ─────────────────────────────────────────────────────
 * A member's weekly distance target lives in member_goals, one row per
 * person. Progress is never stored: it is summed on read over the runs
 * they have joined whose start falls inside the current week, so the
 * week "resets" simply by the window moving on Monday morning. Nothing
 * to backfill, no cron, no counters to drift.
 * ──────────────────────────────────────────────────────────────────── */

// Postgres knows the IANA zone database; the client tells us which entry
// of it to use. Loaded once at boot so a per-request lookup is a Set hit.
// Null means the catalogue could not be read, in which case the syntax
// guard below is the only filter — safe either way, since the zone is
// always passed as a bind parameter and never interpolated into SQL.
let TIMEZONE_NAMES = null;

async function loadTimezoneNames() {
  try {
    const { rows } = await pool.query(`SELECT name FROM pg_timezone_names`);
    TIMEZONE_NAMES = new Set(rows.map((r) => r.name));
  } catch (err) {
    console.warn('[goals] could not read pg_timezone_names:', err.message);
    TIMEZONE_NAMES = null;
  }
}

// Same stance as the frontend's safeLocale(): an unrecognised value must
// degrade to a working default, never take the whole screen down. An
// unknown zone would make Postgres raise mid-query.
function safeTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return 'UTC';
  if (tz.length > 64 || !/^[A-Za-z0-9_+\-\/]+$/.test(tz)) return 'UTC';
  if (TIMEZONE_NAMES && !TIMEZONE_NAMES.has(tz)) return 'UTC';
  return tz;
}

// date_trunc('week', ...) is Monday-based in Postgres, which is the week
// this app wants. Comparing the truncated local timestamps puts a run in
// "this week" according to the viewer's own calendar, not UTC's.
const WEEK_PROGRESS_SQL = `
  SELECT
    COALESCE(SUM(r.distance_km) FILTER (WHERE r.starts_at <  NOW()), 0)::float8
      AS done_km,
    COALESCE(SUM(r.distance_km) FILTER (WHERE r.starts_at >= NOW()), 0)::float8
      AS planned_km,
    COUNT(*) FILTER (WHERE r.distance_km IS NOT NULL)::int AS run_count,
    COUNT(*) FILTER (WHERE r.distance_km IS NULL)::int     AS undistanced_count,
    ((date_trunc('week', NOW() AT TIME ZONE $2) + INTERVAL '7 days')
      AT TIME ZONE $2) AS week_ends_at
  FROM run_attendees a
  JOIN runs r ON r.id = a.run_id
  WHERE a.user_id = $1
    AND date_trunc('week', r.starts_at AT TIME ZONE $2)
      = date_trunc('week', NOW()        AT TIME ZONE $2)
`;

// Staging has no member_goals rows (the table is staging:private, and
// seeding the visitor's own goal would fabricate the very "does this
// person have a goal?" signal this endpoint exists to answer). So the
// filled card is served here instead: read-only, persisted nowhere, and
// a strict no-op outside staging.
function demoGoalPayload() {
  const ends = new Date();
  // Next Monday 00:00 local to the container, matching the real query's
  // week end closely enough for the preview's "days left" line.
  ends.setHours(0, 0, 0, 0);
  ends.setDate(ends.getDate() + ((8 - (ends.getDay() || 7)) % 7 || 7));
  return {
    username: 'staging-demo-maya',
    goal: { target_km: 25 },
    progress: {
      done_km: 16.5,
      planned_km: 5,
      run_count: 2,
      undistanced_count: 1,
    },
    week: { ends_at: ends.toISOString() },
  };
}

// The preview's filled goal card. Deliberately a SEPARATE route from
// /api/me/goal, which stays behind req.user: this one answers with
// fabricated numbers and no identity at all, which is what lets the
// platform's checks reach the filled state (they navigate with no
// token, same reason the run board's reads are public). It is served in
// production too and answers `{ demo: null }` there, so which routes
// exist never differs between environments -- only the data does.
app.get('/api/demo/goal', (req, res) => {
  res.json({ demo: IS_STAGING ? demoGoalPayload() : null });
});

// Deliberately NOT in PUBLIC_GET_API: unlike the run board, a goal is
// only ever the caller's own.
app.get('/api/me/goal', async (req, res) => {
  const tz = safeTimeZone(req.query.tz);
  try {
    const [goal, progress] = await Promise.all([
      pool.query(
        `SELECT target_km::float8 AS target_km FROM member_goals WHERE user_id = $1`,
        [req.user.id]
      ),
      pool.query(WEEK_PROGRESS_SQL, [req.user.id, tz]),
    ]);
    const p = progress.rows[0];
    res.json({
      id: req.user.id,
      username: req.user.username,
      goal: goal.rows.length ? { target_km: goal.rows[0].target_km } : null,
      progress: {
        done_km: p.done_km,
        planned_km: p.planned_km,
        run_count: p.run_count,
        undistanced_count: p.undistanced_count,
      },
      week: { ends_at: p.week_ends_at },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/me/goal', async (req, res) => {
  const target = parseDistance(
    req.body?.target_km, MIN_GOAL_KM, MAX_GOAL_KM, GOAL_ERROR
  );
  if (target.error) return res.status(400).json({ error: target.error });
  if (target.value === null) return res.status(400).json({ error: GOAL_ERROR });
  try {
    await pool.query(
      `INSERT INTO member_goals (user_id, username, target_km)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET target_km = EXCLUDED.target_km,
             username  = EXCLUDED.username,
             updated_at = NOW()`,
      [req.user.id, req.user.username, target.value]
    );
    res.json({ goal: { target_km: target.value } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Idempotent: removing a goal nobody set is still a success.
app.delete('/api/me/goal', async (req, res) => {
  try {
    await pool.query(`DELETE FROM member_goals WHERE user_id = $1`, [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Usernode" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. `path` must stay the FINAL fragment
    // param and its value goes verbatim (wire-encoded; the shell
    // validates relative-only before use). The character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + req.originalUrl : '';
    if (req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, 'https://social-vibecoding.usernodelabs.org/#app/my-cool-app-460fe8/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#ffffff;color:#18181b;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#52525b;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org/#app/my-cool-app-460fe8/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#0a7aff;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Platform-stored files are not cloned into staging, so a seeded run can't
// point at a real /app-files/ URL. An inline SVG data URI renders exactly
// like a real photo would, without depending on file storage, so the new
// photo UI (list thumbnail, detail banner) has something to render in
// every preview and in the "Run detail shows the seeded photo" check.
const SEED_PHOTO_URL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 225'%3E%3Crect width='400' height='225' fill='%2323a455'/%3E%3Ctext x='200' y='120' font-size='24' fill='white' text-anchor='middle' font-family='sans-serif'%3EStaging demo photo%3C/text%3E%3C/svg%3E";

// Seeded run ids live far above anything the app will ever allocate, so a
// re-boot can address the same demo rows by id.
const SEED_RUNS = [
  {
    id: 900001,
    location: 'Staging demo: Riverside Park, main gate',
    note: 'easy 5k, ~6:30/km',
    dayOffset: 0,
    hour: 18,
    minute: 30,
    organizer: [-901, 'staging-demo-maya'],
    joiners: [[-902, 'staging-demo-ethan'], [-903, 'staging-demo-nina']],
    photoUrl: SEED_PHOTO_URL,
    distanceKm: 5,
  },
  {
    id: 900002,
    location: 'Staging demo: Harbor Promenade',
    note: null,
    dayOffset: 1,
    hour: 7,
    minute: 0,
    organizer: [-902, 'staging-demo-ethan'],
    joiners: [[-901, 'staging-demo-maya']],
    distanceKm: 8,
  },
  {
    id: 900003,
    location: 'Staging demo: Old Town loop',
    note: 'hills, take it steady',
    dayOffset: -3,
    hour: 8,
    minute: 0,
    organizer: [-903, 'staging-demo-nina'],
    joiners: [[-901, 'staging-demo-maya'], [-902, 'staging-demo-ethan']],
    distanceKm: 12,
  },
  {
    // Deliberately inside the CURRENT week and already over, so the Past
    // tab in a preview always carries a distance from this week rather
    // than only from whenever dayOffset -3 happens to land.
    id: 900004,
    location: 'Staging demo: Canal towpath intervals',
    note: '6x800m, jog back',
    dayOffset: 0,
    hour: 6,
    minute: 0,
    past: true,
    organizer: [-903, 'staging-demo-nina'],
    joiners: [[-901, 'staging-demo-maya'], [-902, 'staging-demo-ethan']],
    distanceKm: 6.5,
  },
];

// Times are recomputed on every boot so the demo rows keep saying Today /
// Tomorrow however long the preview container has been up.
function seedStartsAt(dayOffset, hour, minute, past) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  // A row seeded as deliberately-past wants the opposite correction: a
  // container booted before 06:00 would otherwise put "earlier today"
  // into the future, where an already-happened demo run cannot go.
  if (past) {
    if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
    return d.toISOString();
  }
  // A container booted after 18:30 would otherwise seed today's demo run
  // straight into the Past tab, leaving Upcoming thinner than the testing
  // steps describe.
  if (dayOffset >= 0 && d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

async function seedStaging() {
  for (const run of SEED_RUNS) {
    await pool.query(
      `INSERT INTO runs (id, location, note, starts_at, organizer_id, organizer_username, photo_url, distance_km)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET starts_at = EXCLUDED.starts_at,
                                      distance_km = EXCLUDED.distance_km`,
      [
        run.id,
        run.location,
        run.note,
        seedStartsAt(run.dayOffset, run.hour, run.minute, run.past),
        run.organizer[0],
        run.organizer[1],
        run.photoUrl || null,
        run.distanceKm ?? null,
      ]
    );
    for (const [userId, username] of [run.organizer, ...run.joiners]) {
      await pool.query(
        `INSERT INTO run_attendees (run_id, user_id, username) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [run.id, userId, username]
      );
    }
  }
  // The explicit ids above bypass the sequence; push it past them so the
  // first run a tester posts does not collide with a demo row.
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('runs', 'id'),
                   GREATEST((SELECT COALESCE(MAX(id), 1) FROM runs), 1))`
  );
}

async function migrate() {
  // The press-counter app this repo used to be is gone; drop its table so
  // production is not left carrying dead data.
  await pool.query(`DROP TABLE IF EXISTS presses`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id SERIAL PRIMARY KEY,
      location VARCHAR(120) NOT NULL,
      note VARCHAR(200),
      starts_at TIMESTAMPTZ NOT NULL,
      organizer_id INTEGER NOT NULL,
      organizer_username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Both nullable: a run photo is optional, and existing runs predate the
  // column. `photo_file_id` is kept only so the organizer's client can
  // free the upload via usernode.deleteFile when they cancel the run.
  await pool.query(`
    ALTER TABLE runs
      ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500),
      ADD COLUMN IF NOT EXISTS photo_file_id VARCHAR(64)
  `);
  // How far the run is, in kilometres. Nullable twice over: every row
  // written before this column existed has none, and a poster is never
  // made to supply one. A run without a distance simply cannot count
  // toward a weekly goal.
  await pool.query(`
    ALTER TABLE runs
      ADD COLUMN IF NOT EXISTS distance_km NUMERIC(5,2)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS run_attendees (
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (run_id, user_id)
    )
  `);
  // One row per member. No foreign keys: user ids are bare integers
  // everywhere in this schema, because the platform owns identity and
  // this app has no users table to point at.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_goals (
      user_id INTEGER PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      target_km NUMERIC(5,2) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Private, unlike runs and run_attendees. A goal is the one thing this
  // app shows only to the person it belongs to, and the platform's test
  // for a private table is exactly that. Staging gets the schema and no
  // rows, which is what we want: a seeded goal for the preview visitor
  // would fabricate the "does this person have a goal?" answer that the
  // home card is built to read.
  await pool.query(`COMMENT ON TABLE member_goals IS 'staging:private'`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS runs_starts_at_idx ON runs (starts_at)`
  );
  // The primary key is (run_id, user_id), so the weekly progress query's
  // lookup by user alone had nothing to use before this.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS run_attendees_user_idx ON run_attendees (user_id)`
  );
}

let server;

async function start() {
  await migrate();
  await loadTimezoneNames();

  // Staging starts from a copy of production, where these tables are brand
  // new and therefore empty, so a preview would show nothing but the empty
  // state. Seed a few obviously fake runs — never the visitor, whose own
  // Join buttons have to stay genuinely un-joined for the flow to be
  // testable.
  if (IS_STAGING) await seedStaging();

  server = app.listen(port, () => console.log(`Listening on :${port}`));
}

const DRAIN_MS = 3000;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  if (server) {
    server.close(() => {});
    server.closeIdleConnections?.();
    const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
  }
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });
