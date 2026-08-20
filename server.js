const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Staging previews get a copy of production data, but tables this change
// creates land EMPTY there — so a boot-time seed (below) fills them with
// obviously-fake demo runs. Strictly a no-op in production.
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

// A run is "past" one hour after it starts, so people arriving right on time
// still see it in Upcoming. ONE definition, reused by every query and by the
// photo-eligibility check.
const PAST_PREDICATE = "starts_at < NOW() - INTERVAL '1 hour'";
const UPCOMING_PREDICATE = "starts_at >= NOW() - INTERVAL '1 hour'";

// Photos live on platform storage; we persist only the id + URL it returns.
// Registering an arbitrary third-party URL would make this app render remote
// images for every club member, so the URL must match the file id exactly.
const PLATFORM_ORIGIN = 'https://social-vibecoding.usernodelabs.org';
const FILE_ID_RE = /^[0-9a-f]{32}$/;
const MAX_PHOTOS_PER_RUN = 12;

let shuttingDown = false;

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
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// 503 once draining so anything polling readiness sees the container leaving
// rotation rather than a connection reset.
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

// ---------------------------------------------------------------- runs API

// One row per run, with its attendees and (for past runs) its photos folded
// in as JSON so the feed is a single round trip.
function runsQuery({ past, viewerId }) {
  return `
    SELECT r.id,
           r.creator_id,
           r.creator_username,
           r.location,
           r.starts_at,
           r.note,
           (r.creator_id = $1) AS is_creator,
           COALESCE((
             SELECT json_agg(json_build_object('userId', a.user_id, 'username', a.username)
                             ORDER BY a.joined_at, a.user_id)
             FROM run_attendees a WHERE a.run_id = r.id
           ), '[]'::json) AS attendees,
           EXISTS (SELECT 1 FROM run_attendees a
                   WHERE a.run_id = r.id AND a.user_id = $1) AS joined,
           ${past ? `
           COALESCE((
             SELECT json_agg(json_build_object(
                      'id', p.id, 'fileId', p.file_id, 'url', p.url,
                      'uploaderUsername', p.uploader_username,
                      'mine', p.uploader_id = $1)
                    ORDER BY p.created_at, p.id)
             FROM run_photos p WHERE p.run_id = r.id
           ), '[]'::json) AS photos,
           (r.creator_id = $1 OR EXISTS (
              SELECT 1 FROM run_attendees a
              WHERE a.run_id = r.id AND a.user_id = $1)) AS can_add_photos
           ` : `'[]'::json AS photos, false AS can_add_photos`}
    FROM runs r
    WHERE ${past ? PAST_PREDICATE : UPCOMING_PREDICATE}
    ORDER BY r.starts_at ${past ? 'DESC' : 'ASC'}
    LIMIT 50
  `;
}

app.get('/api/runs', async (req, res) => {
  const past = req.query.scope === 'past';
  try {
    const { rows } = await pool.query(runsQuery({ past }), [req.user.id]);
    res.json({ runs: rows, scope: past ? 'past' : 'upcoming' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/runs', async (req, res) => {
  const location = String(req.body.location || '').trim();
  const note = String(req.body.note || '').trim();
  const startsAt = new Date(req.body.startsAt);

  if (!location || location.length > 200) {
    return res.status(400).json({ code: 'invalid_location', error: 'Add a meeting place' });
  }
  if (isNaN(startsAt.getTime())) {
    return res.status(400).json({ code: 'invalid_time', error: 'Pick a date and time' });
  }
  if (startsAt.getTime() <= Date.now()) {
    return res.status(400).json({ code: 'time_in_past', error: 'Pick a time in the future' });
  }
  if (note.length > 200) {
    return res.status(400).json({ code: 'invalid_note', error: 'Note is too long' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      INSERT INTO runs (creator_id, creator_username, location, starts_at, note)
      VALUES ($1, $2, $3, $4, $5) RETURNING id
    `, [req.user.id, req.user.username, location, startsAt.toISOString(), note || null]);
    // The organizer is going by definition.
    await client.query(`
      INSERT INTO run_attendees (run_id, user_id, username) VALUES ($1, $2, $3)
      ON CONFLICT (run_id, user_id) DO NOTHING
    `, [rows[0].id, req.user.id, req.user.username]);
    await client.query('COMMIT');
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/runs/:id/join', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, ${PAST_PREDICATE} AS is_past FROM runs WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ code: 'run_gone', error: 'That run is gone' });
    if (rows[0].is_past) return res.status(409).json({ code: 'run_not_upcoming', error: 'That run already happened' });
    // Idempotent: a double tap must not create a second attendee row.
    await pool.query(`
      INSERT INTO run_attendees (run_id, user_id, username) VALUES ($1, $2, $3)
      ON CONFLICT (run_id, user_id) DO NOTHING
    `, [req.params.id, req.user.id, req.user.username]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/runs/:id/join', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, ${PAST_PREDICATE} AS is_past FROM runs WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ code: 'run_gone', error: 'That run is gone' });
    if (rows[0].is_past) return res.status(409).json({ code: 'run_not_upcoming', error: 'That run already happened' });
    // Leaving a run you are not in is a no-op, not an error.
    await pool.query('DELETE FROM run_attendees WHERE run_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/runs/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT creator_id FROM runs WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.json({ ok: true });
    if (rows[0].creator_id !== req.user.id) {
      return res.status(403).json({ code: 'not_creator', error: 'Only the organizer can cancel this run' });
    }
    // ON DELETE CASCADE clears attendees and photo rows.
    await pool.query('DELETE FROM runs WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------- photos API

// Registered AFTER the client's bridge upload succeeds: we store the
// platform's file id and URL, never the bytes.
app.post('/api/runs/:id/photos', async (req, res) => {
  const fileId = String(req.body.fileId || '');
  const url = String(req.body.url || '');
  try {
    const { rows } = await pool.query(
      `SELECT id, creator_id, ${PAST_PREDICATE} AS is_past FROM runs WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ code: 'run_gone', error: 'That run is gone' });
    if (!rows[0].is_past) {
      return res.status(409).json({ code: 'run_not_past', error: 'Photos can only be added after the run' });
    }

    // Eligibility is re-checked here — never trusted from the client.
    const { rows: att } = await pool.query(
      'SELECT 1 FROM run_attendees WHERE run_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!att.length && rows[0].creator_id !== req.user.id) {
      return res.status(403).json({ code: 'not_attendee', error: 'Only people who were on this run can add photos' });
    }

    if (!FILE_ID_RE.test(fileId) || url !== `${PLATFORM_ORIGIN}/app-files/${fileId}`) {
      return res.status(400).json({ code: 'invalid_file', error: "That upload didn't look right" });
    }

    const { rows: count } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM run_photos WHERE run_id = $1', [req.params.id]
    );
    if (count[0].n >= MAX_PHOTOS_PER_RUN) {
      return res.status(409).json({ code: 'photo_limit', error: 'Photo limit reached for this run' });
    }

    // UNIQUE(file_id) + DO NOTHING makes a retried registration a no-op.
    const { rows: made } = await pool.query(`
      INSERT INTO run_photos (run_id, file_id, url, uploader_id, uploader_username)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (file_id) DO NOTHING
      RETURNING id
    `, [req.params.id, fileId, url, req.user.id, req.user.username]);
    res.json({ ok: true, id: made.length ? made[0].id : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/runs/:id/photos/:photoId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT uploader_id FROM run_photos WHERE id = $1 AND run_id = $2',
      [req.params.photoId, req.params.id]
    );
    // Already gone is success — deletes are idempotent.
    if (!rows.length) return res.json({ ok: true });
    if (rows[0].uploader_id !== req.user.id) {
      return res.status(403).json({ code: 'not_uploader', error: 'You can only remove your own photos' });
    }
    await pool.query('DELETE FROM run_photos WHERE id = $1', [req.params.photoId]);
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
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org/#app/my-cool-app-460fe8/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ------------------------------------------------------------------ schema

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id SERIAL PRIMARY KEY,
      creator_id INTEGER NOT NULL,
      creator_username VARCHAR(255) NOT NULL,
      location VARCHAR(200) NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      note VARCHAR(200),
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
  // Only the platform's returned id + URL — never image bytes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS run_photos (
      id SERIAL PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      file_id VARCHAR(64) NOT NULL UNIQUE,
      url TEXT NOT NULL,
      uploader_id INTEGER NOT NULL,
      uploader_username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS run_photos_run_idx ON run_photos (run_id, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS runs_starts_at_idx ON runs (starts_at)');
  // All three tables are public (platform default): usernames, public meetup
  // info and public file URLs — nothing a stranger seeing every row breaks.
}

// ------------------------------------------------------------ staging seed

// A tiny inline placeholder so the Past segment shows real thumbnails in a
// staging preview. Platform-stored files are NOT cloned into staging, so a
// fabricated /app-files/ URL would render broken — a data URI is the
// convention here. These deliberately fail the 32-hex file-id test, so the
// client skips the bridge deleteFile call for them.
function placeholderPhoto(label, hue) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">` +
    `<rect width="400" height="400" fill="hsl(${hue},45%,32%)"/>` +
    `<circle cx="200" cy="150" r="60" fill="hsl(${hue},55%,55%)"/>` +
    `<text x="200" y="300" font-family="system-ui" font-size="34" fill="#fff" ` +
    `text-anchor="middle">${label}</text></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

async function seedStaging() {
  if (!IS_STAGING) return;

  // Fake identities only — never the visitor. Ids sit in a high range so they
  // can never collide with organic SERIAL rows.
  const runs = [
    [900001, 900001, 'staging-demo-runner-1', 'Staging demo — Riverside loop',
      "NOW() + INTERVAL '1 day'", 'easy 5k, all paces'],
    [900002, 900002, 'staging-demo-runner-2', 'Staging demo — Track intervals',
      "NOW() + INTERVAL '3 days'", '6x400m'],
    [900003, 900003, 'staging-demo-runner-3', 'Staging demo — Long run',
      "NOW() + INTERVAL '5 days'", null],
    [900004, 900001, 'staging-demo-runner-1', 'Staging demo — Sunrise jog',
      "NOW() - INTERVAL '2 days'", 'gentle shakeout'],
    [900005, 900002, 'staging-demo-runner-2', 'Staging demo — Hill repeats',
      "NOW() - INTERVAL '6 days'", null],
  ];
  for (const [id, creatorId, creator, location, when, note] of runs) {
    await pool.query(`
      INSERT INTO runs (id, creator_id, creator_username, location, starts_at, note)
      VALUES ($1, $2, $3, $4, date_trunc('hour', ${when}) + INTERVAL '7 hours', $5)
      ON CONFLICT (id) DO NOTHING
    `, [id, creatorId, creator, location, note]);
  }

  const attendees = [
    [900001, [1, 2, 3]], [900002, [2]], [900003, [2, 3]],
    [900004, [1, 2, 3]], [900005, [2, 3]],
  ];
  for (const [runId, members] of attendees) {
    for (const n of members) {
      await pool.query(`
        INSERT INTO run_attendees (run_id, user_id, username) VALUES ($1, $2, $3)
        ON CONFLICT (run_id, user_id) DO NOTHING
      `, [runId, 900000 + n, 'staging-demo-runner-' + n]);
    }
  }

  // Photos on the Sunrise jog only; Hill repeats stays photo-less so the
  // empty-strip path is visible too. Both belong to FAKE users, so `mine` is
  // false for any real visitor and the Delete affordance never appears on
  // seeded rows.
  const photos = [
    [900001, 'staging-demo-photo-1', placeholderPhoto('Staging demo photo 1', 15), 900002, 'staging-demo-runner-2'],
    [900002, 'staging-demo-photo-2', placeholderPhoto('Staging demo photo 2', 200), 900003, 'staging-demo-runner-3'],
  ];
  for (const [id, fileId, url, uploaderId, uploader] of photos) {
    await pool.query(`
      INSERT INTO run_photos (id, run_id, file_id, url, uploader_id, uploader_username)
      VALUES ($1, 900004, $2, $3, $4, $5)
      ON CONFLICT (file_id) DO NOTHING
    `, [id, fileId, url, uploaderId, uploader]);
  }
}

// -------------------------------------------------------------- lifecycle

const DRAIN_MS = 3000;
let server;

async function shutdown(signal) {
  if (shuttingDown) return;         // a repeat signal must be a no-op
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

async function start() {
  await migrate();
  await seedStaging();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
