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
const PUBLIC_API_PATHS = new Set(['/health']);

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
// A minute of slack absorbs clock skew between the phone that filled in
// the picker and this container.
const FUTURE_SLACK_MS = 60 * 1000;

// One row per run, with the three derived fields every list/detail view
// needs: how many are going, whether the caller is one of them, and the
// first few names for the avatar cluster.
const RUN_SELECT = `
  SELECT r.id, r.location, r.note, r.starts_at,
         r.organizer_id, r.organizer_username,
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
      `INSERT INTO runs (location, note, starts_at, organizer_id, organizer_username)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [location, rawNote || null, startsAt.toISOString(), req.user.id, req.user.username]
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
  },
];

// Times are recomputed on every boot so the demo rows keep saying Today /
// Tomorrow however long the preview container has been up.
function seedStartsAt(dayOffset, hour, minute) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  // A container booted after 18:30 would otherwise seed today's demo run
  // straight into the Past tab, leaving Upcoming thinner than the testing
  // steps describe.
  if (dayOffset >= 0 && d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

async function seedStaging() {
  for (const run of SEED_RUNS) {
    await pool.query(
      `INSERT INTO runs (id, location, note, starts_at, organizer_id, organizer_username)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET starts_at = EXCLUDED.starts_at`,
      [
        run.id,
        run.location,
        run.note,
        seedStartsAt(run.dayOffset, run.hour, run.minute),
        run.organizer[0],
        run.organizer[1],
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS run_attendees (
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (run_id, user_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS runs_starts_at_idx ON runs (starts_at)`
  );
}

let server;

async function start() {
  await migrate();

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
