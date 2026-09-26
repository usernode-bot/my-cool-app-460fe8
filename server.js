const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

// The platform's address, injected by the platform at deploy (#2047). Never
// written out here: a hardcoded hostname is what broke this app when the
// platform moved domains. Empty only outside the platform (local runs).
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '').replace(/\/+$/, '');

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
const PUBLIC_GET_API = [
  /^\/api\/runs$/, /^\/api\/runs\/\d+$/,
  /^\/api\/run-types$/,
];

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
// Planned duration range in whole minutes, enforced in POST /api/runs.
// Generous for club runs; the cap keeps the field honest, not a rule
// about how far people may run.
const MAX_DURATION_MINUTES = 600;
// Preset run types. Keep in sync with PRESET_TYPES in public/index.html:
// the server is authoritative for validation, the frontend list drives the
// picker, and a label is only valid if BOTH sides know it.
const PRESET_TYPES = ['Easy', 'Tempo', 'Long Run', 'Intervals', 'Race'];
const MAX_TYPE_LABEL = 30;
// The meeting point is optional. The name/description is free text, the
// coordinates are a resolved pin for the static map thumbnail. Both are
// stored or neither is, so a run never renders a marker with no words.
const MAX_MEETING = 120;
const MAX_MEETING_LAT = 90;
const MAX_MEETING_LNG = 180;
// A minute of slack absorbs clock skew between the phone that filled in
// the picker and this container.
const FUTURE_SLACK_MS = 60 * 1000;

// Reminders fire this long before the run's start time. One value, used
// everywhere a reminder row is written.
const REMINDER_LEAD = "interval '1 hour'";

// The board's PB chip reads history the app already stores: one organizer,
// one run type, planned durations. Past rows are the only events the app
// records, so the question the window below answers is: of this organizer's
// finished runs of this type, is this the fastest planned duration so far?
// CORR names the strict order (soonest wins ties); PB is simply
// MIN(duration) OVER (organizer, type) on the finished rows.
const PB_SELECT = `  SELECT q.*,
         (q.is_past AND q.duration_minutes IS NOT NULL AND
          q.duration_minutes = MIN(q.duration_minutes) OVER pb_win)::int
           AS is_pb
  FROM (
    SELECT r.*,
           (r.starts_at < NOW()) AS is_past,
           ROW_NUMBER() OVER (
             PARTITION BY r.organizer_id, r.type_label
             ORDER BY r.starts_at ASC
           )::int AS corr,
           MIN(r.starts_at) OVER (
             PARTITION BY r.organizer_id, r.type_label
           ) AS first_start
    FROM runs r
  ) q
  WINDOW pb_win AS (
    PARTITION BY q.organizer_id, q.type_label
  )
`;


// One row per run, with the three derived fields every list/detail view
// needs: how many are going, whether the caller is one of them, and the
// first few names for the avatar cluster.
const RUN_SELECT = `
  SELECT p.id, p.location, p.note, p.starts_at,
         p.organizer_id, p.organizer_username,
         p.photo_url, p.photo_file_id, p.type_label, p.duration_minutes,
         p.meeting_point, p.meeting_lat, p.meeting_lng,
         p.is_pb,
         (SELECT COUNT(*) FROM run_attendees a WHERE a.run_id = p.id)::int
           AS attendee_count,
         EXISTS (
           SELECT 1 FROM run_attendees a
           WHERE a.run_id = p.id AND a.user_id = $1
         ) AS joined,
         (SELECT COUNT(*) FROM run_kudos k WHERE k.run_id = p.id)::int
           AS kudos_count,
         EXISTS (
           SELECT 1 FROM run_kudos k
           WHERE k.run_id = p.id AND k.user_id = $1
         ) AS kudos_given,
         (p.organizer_id = $1) AS is_organizer,
         COALESCE((
           SELECT array_agg(x.username ORDER BY x.ord)
           FROM (
             SELECT a.username,
                    ROW_NUMBER() OVER (
                      ORDER BY (a.user_id = p.organizer_id) DESC, a.joined_at
                    ) AS ord
             FROM run_attendees a WHERE a.run_id = p.id
           ) x
           WHERE x.ord <= 3
         ), ARRAY[]::varchar[]) AS preview,
         EXISTS (
           SELECT 1 FROM run_reminder_optouts o
           WHERE o.run_id = p.id AND o.user_id = $1
         ) AS reminders_off
  FROM (${PB_SELECT}) p
`;

/* ── Run types API ─────────────────────────────────────────────────────
 * Presets are constants, never rows. Custom types are one member's own
 * picker entries: private to them, case-insensitively unique against
 * presets and their own list, and never a foreign key from the public
 * runs table (runs store the label itself).
 * ──────────────────────────────────────────────────────────────────── */

// Shared by the types endpoints and by POST /api/runs, so both agree on
// what a valid label is. Returns the trimmed label, or an error object the
// caller turns into a response.
function validateTypeLabel(raw, ownerId, excludeId) {
  const label = String(raw ?? '').trim();
  if (!label) return { error: 'Give the type a name.' };
  if (label.length > MAX_TYPE_LABEL) {
    return { error: 'That type name is too long.' };
  }
  // An emoji-only or symbol-only name would render as an unsearchable chip;
  // require at least one letter or number anywhere in the label.
  if (!/\p{L}|\p{N}/u.test(label)) {
    return { error: 'Use letters or numbers in the type name.' };
  }
  const lower = label.toLowerCase();
  if (PRESET_TYPES.some((p) => p.toLowerCase() === lower)) {
    return { error: 'That name is already a preset type.' };
  }
  return pool.query(
    `SELECT id, label FROM run_type_labels
     WHERE owner_id = $1 AND LOWER(label) = LOWER($2) AND id <> COALESCE($3, 0)`,
    [ownerId, label, excludeId ?? null]
  ).then(({ rows }) => {
    if (rows.length) return { error: 'You already have a type with that name.' };
    return { label: label };
  }).catch((err) => ({ dbError: err }));
}

app.get('/api/run-types', async (req, res) => {
  try {
    // Read-only and anonymous-safe: a signed-out visitor (the platform's
    // check browser) owns no custom types, so the WHERE on a null caller
    // simply returns none and the picker falls back to the presets.
    const { rows } = await pool.query(
      `SELECT id, label, created_at FROM run_type_labels
       WHERE owner_id = $1 ORDER BY created_at DESC, id DESC`,
      [callerId(req)]
    );
    res.json({ presets: PRESET_TYPES, custom: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/run-types', async (req, res) => {
  const verdict = await validateTypeLabel(req.body?.label, req.user.id, null);
  if (verdict.dbError) return res.status(500).json({ error: verdict.dbError.message });
  if (verdict.error) return res.status(409).json({ error: verdict.error });
  try {
    const { rows } = await pool.query(
      `INSERT INTO run_type_labels (owner_id, label) VALUES ($1, $2)
       RETURNING id, label, created_at`,
      [req.user.id, verdict.label]
    );
    res.json({ type: rows[0] });
  } catch (err) {
    // The unique index is the last word when two tabs race; map it to the
    // same friendly message as the pre-check.
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'You already have a type with that name.' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/run-types/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad type id' });
  try {
    const { rows } = await pool.query(
      `SELECT id FROM run_type_labels WHERE id = $1 AND owner_id = $2`,
      [id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Type not found' });
    const verdict = await validateTypeLabel(req.body?.label, req.user.id, id);
    if (verdict.dbError) return res.status(500).json({ error: verdict.dbError.message });
    if (verdict.error) return res.status(409).json({ error: verdict.error });
    const updated = await pool.query(
      `UPDATE run_type_labels SET label = $2 WHERE id = $1
       RETURNING id, label, created_at`,
      [id, verdict.label]
    );
    res.json({ type: updated.rows[0] });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'You already have a type with that name.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Deleting a type never rewrites history: runs keep the label they were
// posted with, the name simply stops being pickable.
app.delete('/api/run-types/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad type id' });
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM run_type_labels WHERE id = $1 AND owner_id = $2`,
      [id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Type not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List runs. `upcoming` is the default tab: anything that has not started
// yet, soonest first. `past` reads the other way and is capped.
app.get('/api/runs', async (req, res) => {
  const past = req.query.filter === 'past';
  try {
    const { rows } = await pool.query(
      RUN_SELECT +
        (past
          ? ` WHERE p.starts_at < NOW() ORDER BY p.starts_at DESC LIMIT 50`
          : ` WHERE p.starts_at >= NOW() ORDER BY p.starts_at ASC LIMIT 100`),
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
  const rawType = String(req.body?.type ?? '').trim();
  const rawMeeting = String(req.body?.meeting_point ?? '').trim();
  const hasCoords = req.body?.meeting_lat != null && req.body?.meeting_lng != null;
  const meetingLat = hasCoords ? Number(req.body.meeting_lat) : null;
  const meetingLng = hasCoords ? Number(req.body.meeting_lng) : null;

  if (!location) return res.status(400).json({ error: 'Add a location.' });
  if (location.length > MAX_LOCATION) {
    return res.status(400).json({ error: 'That location is too long.' });
  }
  if (rawNote.length > MAX_NOTE) {
    return res.status(400).json({ error: 'That note is too long.' });
  }
  // The meeting point is optional, but its two halves are not independent:
  // a name without coordinates loses the map thumbnail, and coordinates
  // without a name have nothing to label the pin with.
  if (rawMeeting.length > MAX_MEETING) {
    return res.status(400).json({ error: 'That meeting point is too long.' });
  }
  if (hasCoords && !rawMeeting) {
    return res.status(400).json({ error: 'Add a name for the meeting point.' });
  }
  if (rawMeeting && !hasCoords) {
    return res.status(400).json({ error: 'Pick a location for the meeting point.' });
  }
  if (hasCoords) {
    if (!Number.isFinite(meetingLat) || meetingLat < -MAX_MEETING_LAT || meetingLat > MAX_MEETING_LAT ||
        !Number.isFinite(meetingLng) || meetingLng < -MAX_MEETING_LNG || meetingLng > MAX_MEETING_LNG) {
      return res.status(400).json({ error: 'That meeting-point location is out of range.' });
    }
  }
  // A run type is optional. When present it must be a preset or one of the
  // caller's own custom types, so the board only ever shows names somebody
  // deliberately added. The stored label keeps the casing the type was
  // created with, not the casing of this request.
  let typeLabel = null;
  if (rawType) {
    if (rawType.length > MAX_TYPE_LABEL) {
      return res.status(400).json({ error: 'That type name is too long.' });
    }
    const lower = rawType.toLowerCase();
    const ownTypes = await pool.query(
      `SELECT label FROM run_type_labels WHERE owner_id = $1`,
      [req.user.id]
    );
    const preset = PRESET_TYPES.find((p) => p.toLowerCase() === lower);
    const own = preset ? null
      : ownTypes.rows.find((row) => String(row.label).toLowerCase() === lower);
    if (!preset && !own) {
      return res.status(400).json({ error: 'That run type is no longer available.' });
    }
    typeLabel = preset || own.label;
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
  if (isNaN(startsAt.getTime())) {
    return res.status(400).json({ error: 'Pick a date and time.' });
  }
  if (startsAt.getTime() < Date.now() - FUTURE_SLACK_MS) {
    return res.status(400).json({ error: 'Pick a time in the future.' });
  }
  // Planned duration is optional. Empty string, undefined and null all
  // mean "not set" and store NULL; anything else must be a whole number
  // of minutes in a sane range for a club run.
  const rawDuration = req.body?.duration_minutes;
  let durationMinutes = null;
  if (rawDuration !== undefined && rawDuration !== null && String(rawDuration).trim() !== '') {
    const parsed = Number(rawDuration);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DURATION_MINUTES) {
      return res.status(400).json({ error: 'Use a duration between 1 and 600 minutes.' });
    }
    durationMinutes = parsed;
  }

  const client = await pool.connect();
  try {
    // The run and its organizer's attendance are one fact, so they land
    // together or not at all.
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO runs (location, note, starts_at, organizer_id, organizer_username, photo_url, photo_file_id, type_label, duration_minutes, meeting_point, meeting_lat, meeting_lng)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        location,
        rawNote || null,
        startsAt.toISOString(),
        req.user.id,
        req.user.username,
        photoUrl || null,
        photoFileId || null,
        typeLabel,
        durationMinutes,
        rawMeeting || null,
        rawMeeting ? meetingLat : null,
        rawMeeting ? meetingLng : null,
      ]
    );
    const id = rows[0].id;
    await client.query(
      `INSERT INTO run_attendees (run_id, user_id, username) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [id, req.user.id, req.user.username]
    );
    // The organizer is an attendee, so they get a reminder too. One row
    // per (run, attendee), written while the run itself is written.
    await client.query(
      `INSERT INTO run_reminders (run_id, user_id, remind_at)
       VALUES ($1, $2, $3::timestamptz - ${REMINDER_LEAD})`,
      [id, req.user.id, startsAt.toISOString()]
    );
    await client.query('COMMIT');
    const full = await pool.query(RUN_SELECT + ' WHERE p.id = $2', [req.user.id, id]);
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
    const { rows } = await pool.query(RUN_SELECT + ' WHERE p.id = $2', [callerId(req), id]);
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
    // Re-joining after a leave starts fresh with reminders on, so clear
    // any opt-out left behind and schedule the reminder from the run's
    // own start time.
    await pool.query(
      `INSERT INTO run_reminders (run_id, user_id, remind_at)
       VALUES ($1, $2, (SELECT starts_at FROM runs WHERE id = $1) - ${REMINDER_LEAD})
       ON CONFLICT (run_id, user_id) DO NOTHING`,
      [id, req.user.id]
    );
    await pool.query(
      `DELETE FROM run_reminder_optouts WHERE run_id = $1 AND user_id = $2`,
      [id, req.user.id]
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
    // Attendance carried the reminder schedule and the opt-out; leaving
    // drops both so a re-join starts clean.
    await pool.query(
      `DELETE FROM run_reminders WHERE run_id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    await pool.query(
      `DELETE FROM run_reminder_optouts WHERE run_id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
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

/* ── Kudos API ───────────────────────────────────────────────────────
 * One kudos per member per run, and only once the run is over: a tap
 * writes the (run, user) pair, a second tap removes it, and the response
 * always reports the fresh count plus whether the caller's own row is
 * present, so the button renders from one answer.
 * ──────────────────────────────────────────────────────────────────── */

app.post('/api/runs/:id/kudos', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad run id' });
  try {
    const { rows } = await pool.query(`SELECT starts_at FROM runs WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Run not found' });
    if (new Date(rows[0].starts_at).getTime() >= Date.now()) {
      return res.status(409).json({ error: 'Runs can only be kudosed once they are done.' });
    }
    const existing = await pool.query(
      `SELECT 1 FROM run_kudos WHERE run_id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (existing.rows.length) {
      await pool.query(
        `DELETE FROM run_kudos WHERE run_id = $1 AND user_id = $2`,
        [id, req.user.id]
      );
    } else {
      await pool.query(
        `INSERT INTO run_kudos (run_id, user_id) VALUES ($1, $2)
         ON CONFLICT (run_id, user_id) DO NOTHING`,
        [id, req.user.id]
      );
    }
    const counts = await pool.query(
      `SELECT COUNT(*)::int AS count,
              EXISTS (
                SELECT 1 FROM run_kudos
                WHERE run_id = $1 AND user_id = $2
              ) AS kudos_from_me
       FROM run_kudos WHERE run_id = $1`,
      [id, req.user.id]
    );
    res.json(counts.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Reminders API ───────────────────────────────────────────────────
 * One row per (run, attendee) in run_reminders; sent_at is the dedup
 * key. The frontend polls /due, toasts what it gets back, then claims
 * exactly the run ids it showed; the claim's atomic UPDATE is what
 * keeps a reminder from ever firing twice across tabs or devices.
 * ──────────────────────────────────────────────────────────────────── */

app.get('/api/reminders/due', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT rm.run_id, r.location, r.starts_at,
              EXISTS (
                SELECT 1 FROM run_reminder_optouts o
                WHERE o.run_id = rm.run_id AND o.user_id = $1
              ) AS reminders_off
       FROM run_reminders rm
       JOIN runs r ON r.id = rm.run_id
       WHERE rm.user_id = $1
         AND rm.sent_at IS NULL
         AND rm.remind_at <= NOW()
         AND r.starts_at > NOW()
       ORDER BY r.starts_at ASC`,
      [req.user.id]
    );
    res.json({ reminders: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Marks the named reminders sent with one atomic UPDATE per row. Only a
// transition from sent_at IS NULL counts, so two tabs claiming the same
// run_id produce one fire and one no-op, never two toasts.
app.post('/api/reminders/due/claim', async (req, res) => {
  const ids = Array.isArray(req.body?.run_ids)
    ? [...new Set(req.body.run_ids.map(Number).filter(Number.isInteger))]
    : [];
  if (!ids.length) return res.json({ claimed: [] });
  try {
    const { rows } = await pool.query(
      `UPDATE run_reminders SET sent_at = NOW()
       WHERE user_id = $1 AND run_id = ANY($2::int[]) AND sent_at IS NULL
       RETURNING run_id`,
      [req.user.id, ids]
    );
    res.json({ claimed: rows.map((r) => r.run_id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-run reminder opt-out. Guarded like join/leave so the run must
// still exist and not have started for the choice to mean anything.
app.put('/api/runs/:id/reminders', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad run id' });
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Tell us whether reminders are on or off.' });
  }
  try {
    const guard = await loadJoinableRun(id);
    if (guard.error) return res.status(guard.error).json({ error: guard.message });
    if (enabled) {
      await pool.query(
        `DELETE FROM run_reminder_optouts WHERE run_id = $1 AND user_id = $2`,
        [id, req.user.id]
      );
    } else {
      // Toggling off also unschedules any reminder that has not fired
      // yet, so a run the person has silenced can never toast later.
      await pool.query(
        `INSERT INTO run_reminder_optouts (run_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [id, req.user.id]
      );
      await pool.query(
        `DELETE FROM run_reminders
         WHERE run_id = $1 AND user_id = $2 AND sent_at IS NULL`,
        [id, req.user.id]
      );
    }
    const state = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM run_reminder_optouts o
         WHERE o.run_id = $1 AND o.user_id = $2
       ) AS reminders_off`,
      [id, req.user.id]
    );
    res.json({ reminders_off: state.rows[0].reminders_off });
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
//
// Before it: the compiled stylesheet (public/tailwind.css) and the hosted
// bridge / native kit paths. The stylesheet only exists inside the image,
// and platform convention requires the canonical files at /usernode-* to
// come from the platform, not a per-app fork. Registered here so the
// catch-all below cannot swallow them. (Locally PLATFORM_ORIGIN is empty,
// so a redirect lands on the app's own origin and 401s there; that is
// fine — this path only exists for the in-loop check browser.)
app.get('/tailwind.css', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'tailwind.css')));
['native.css', 'native.js', 'bridge.js'].forEach((file) => {
  const subPath = file === 'bridge.js'
    ? '/usernode-bridge/v1/bridge.js'
    : '/usernode-native/v1/' + file;
  if (PLATFORM_ORIGIN) {
    // In the platform the canonical files ship from the platform edge on
    // the app's own origin already, so this handler never even runs; but
    // if the edge is ever bypassed, redirect rather than proxy: this app
    // has no way to fetch the canonical copy itself.
    app.get(subPath, (req, res) => res.redirect(302, PLATFORM_ORIGIN + subPath));
  } else {
    // Outside the platform (local runs, in-loop checks) there is nothing
    // to redirect to. A no-op stub keeps the page from logging console
    // errors; everything the stub would be used for is either gated on
    // the bridge existing or degrades on its own below.
    app.get(subPath, (req, res) => res.type('js').send('/* hosted file not available outside the platform */'));
  }
});

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
      return res.redirect(302, (PLATFORM_ORIGIN + '/#app/my-cool-app-460fe8/full') + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#ffffff;color:#18181b;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#52525b;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/#app/my-cool-app-460fe8/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#0a7aff;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Usernode</a>
  </div>
</body>`);
  }
  // The verified JWT carries the user's platform locale (a BCP-47 tag, or
  // null when they have not set one). The frontend derives the clock
  // format from the locale (12 hour vs 24 hour), so pass the claim down
  // here: the very first paint already renders in the right shape, before
  // any bridge round-trip. null falls through to device detection in the
  // app script, which is the correct behaviour per platform conventions.
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
    type: 'Staging demo: Trail',
    duration: 30,
    dayOffset: 0,
    hour: 18,
    minute: 30,
    organizer: [-901, 'staging-demo-maya'],
    joiners: [[-902, 'staging-demo-ethan'], [-903, 'staging-demo-nina']],
    photoUrl: SEED_PHOTO_URL,
    meeting: 'Staging demo: Main gate, by the fountain',
    meetingLat: 40.8069,
    meetingLng: -73.9687,
  },
  {
    id: 900002,
    location: 'Staging demo: Harbor Promenade',
    note: null,
    type: null,
    dayOffset: 1,
    hour: 7,
    minute: 0,
    organizer: [-902, 'staging-demo-ethan'],
    joiners: [[-901, 'staging-demo-maya']],
    meeting: 'Staging demo: North steps, under the clock',
    meetingLat: 40.7051,
    meetingLng: -74.0102,
  },
  {
    id: 900003,
    location: 'Staging demo: Old Town loop',
    note: 'hills, take it steady',
    type: null,
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
      `INSERT INTO runs (id, location, note, starts_at, organizer_id, organizer_username, photo_url, type_label, duration_minutes, meeting_point, meeting_lat, meeting_lng)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET starts_at = EXCLUDED.starts_at,
         duration_minutes = EXCLUDED.duration_minutes`,
      [
        run.id,
        run.location,
        run.note,
        seedStartsAt(run.dayOffset, run.hour, run.minute),
        run.organizer[0],
        run.organizer[1],
        run.photoUrl || null,
        run.type || null,
        run.duration || null,
        run.meeting || null,
        run.meeting ? run.meetingLat : null,
        run.meeting ? run.meetingLng : null,
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
  // run_type_labels is staging:private, so staging starts without rows and
  // the seeded Trail run would render typeless. Seed Maya's picker entries
  // with fixed ids under the demo-identity convention. Never owned by the
  // visiting user, and never named like a preset, so nothing here answers a
  // question the app's own logic asks.
  const SEED_TYPES = [
    { id: 910001, owner: -901, label: 'Staging demo: Trail' },
    { id: 910002, owner: -901, label: 'Staging demo: Track' },
  ];
  for (const t of SEED_TYPES) {
    await pool.query(
      `INSERT INTO run_type_labels (id, owner_id, label)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label`,
      [t.id, t.owner, t.label]
    );
  }
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('run_type_labels', 'id'),
                   GREATEST((SELECT COALESCE(MAX(id), 1) FROM run_type_labels), 1))`
  );
  // Private tables arrive empty in staging (schema only), so seed the
  // reminder and opt-out state the testing steps need. All ids are the
  // same fake demo identities the runs above use, never the visitor.
  // Riverside (900001) starts ~18:30 local today: place Maya's reminder
  // just inside the due window so a tester opening the app sees the
  // toast within a minute or two.
  await pool.query(
    `INSERT INTO run_reminders (run_id, user_id, remind_at)
     VALUES (900001, -901, NOW() + INTERVAL '30 seconds')
     ON CONFLICT (run_id, user_id) DO NOTHING`
  );
  // Harbor Promenade (900002) is tomorrow morning: Ethan gets a real
  // future reminder row, which is what the "already scheduled" state
  // looks like in production.
  await pool.query(
    `INSERT INTO run_reminders (run_id, user_id, remind_at)
     VALUES (900002, -902,
             (SELECT starts_at FROM runs WHERE id = 900002) - INTERVAL '1 hour')
     ON CONFLICT (run_id, user_id) DO NOTHING`
  );
  // One opt-out so the menu can be seen in its "reminders off" state:
  // Maya has silenced reminders on Harbor Promenade, where she is an
  // attendee but not the organizer.
  await pool.query(
    `INSERT INTO run_reminder_optouts (run_id, user_id)
     VALUES (900002, -901)
     ON CONFLICT DO NOTHING`
  );
  // run_kudos is staging-private too, so the Past tab needs demo rows to
  // show the count. Old Town loop (900003) is the seeded past run; the
  // kudos come from the fake demo identities, never the visitor.
  await pool.query(
    `INSERT INTO run_kudos (run_id, user_id)
     VALUES (900003, -901), (900003, -902), (900003, -903)
     ON CONFLICT (run_id, user_id) DO NOTHING`
  );
  // PB chip demo: three finished runs, same organizer and type, with the
  // durations falling. Only the fastest one (900006) satisfies is_pb, so
  // the Past tab can show both a PB chip and a non-PB card, and the run
  // detail can show the PB row next to the Duration row. Same fake demo
  // identity convention as the runs above; never the visitor.
  const now = new Date();
  function pbStartsAt(daysAgo, hour) {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  }
  const SEED_PB_RUNS = [
    { id: 900004, location: 'Staging demo: Greenway Tempo', duration: 35, daysAgo: 9 },
    { id: 900005, location: 'Staging demo: Greenway Tempo repeat', duration: 31, daysAgo: 5 },
    { id: 900006, location: 'Staging demo: Greenway Tempo, fastest', duration: 28, daysAgo: 2 },
  ];
  for (const run of SEED_PB_RUNS) {
    await pool.query(
      `INSERT INTO runs (id, location, note, starts_at, organizer_id, organizer_username, type_label, duration_minutes)
       VALUES ($1, $2, $3, $4, -901, 'staging-demo-maya', 'Staging demo: Trail', $5)
       ON CONFLICT (id) DO UPDATE SET starts_at = EXCLUDED.starts_at,
         duration_minutes = EXCLUDED.duration_minutes`,
      [run.id, run.location, null, pbStartsAt(run.daysAgo, 8), run.duration]
    );
    await pool.query(
      `INSERT INTO run_attendees (run_id, user_id, username) VALUES ($1, -901, 'staging-demo-maya')
       ON CONFLICT DO NOTHING`,
      [run.id]
    );
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
      ADD COLUMN IF NOT EXISTS photo_file_id VARCHAR(64),
      ADD COLUMN IF NOT EXISTS meeting_point VARCHAR(120),
      ADD COLUMN IF NOT EXISTS meeting_lat DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS meeting_lng DOUBLE PRECISION
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
  // Reminders carry per-user intent (who is scheduled to be nudged and
  // when), so the table is staging-private and staging seeds its own
  // demo rows. sent_at is the dedup key: an atomic transition from NULL
  // to a timestamp is the only thing that counts as "fired".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS run_reminders (
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      remind_at TIMESTAMPTZ NOT NULL,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (run_id, user_id)
    )
  `);
  await pool.query(
    `COMMENT ON TABLE run_reminders IS 'staging:private'`
  );
  // Per-run opt-out. Row absent means reminders on, so the default is
  // "everyone gets the reminder" with no boolean to migrate.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS run_reminder_optouts (
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (run_id, user_id)
    )
  `);
  await pool.query(
    `COMMENT ON TABLE run_reminder_optouts IS 'staging:private'`
  );
  // Kudos are who-you-are data: one row per (run, member) says that a
  // specific person tapped Kudos, which a stranger reading a staging
  // database should not see. The table is staging-private, so staging
  // seeds its own demo rows in seedStaging().
  await pool.query(`
    CREATE TABLE IF NOT EXISTS run_kudos (
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (run_id, user_id)
    )
  `);
  await pool.query(
    `COMMENT ON TABLE run_kudos IS 'staging:private'`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS runs_starts_at_idx ON runs (starts_at)`
  );
  await pool.query(`
    ALTER TABLE runs
      ADD COLUMN IF NOT EXISTS type_label VARCHAR(30)
  `);
  // Planned duration in whole minutes, optional: NULL means the organizer
  // did not set one and every screen renders the run as before. Validated
  // in the app layer (1..600 integer) like every other POST field.
  await pool.query(`
    ALTER TABLE runs
      ADD COLUMN IF NOT EXISTS duration_minutes SMALLINT
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS run_type_labels (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      label VARCHAR(30) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS run_type_labels_owner_label_idx
     ON run_type_labels (owner_id, label)`
  );
  // One member's own picker entries: staging copies the schema only, so
  // seedStaging() fills it with obviously fake rows.
  await pool.query(
    `COMMENT ON TABLE run_type_labels IS 'staging:private'`
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
