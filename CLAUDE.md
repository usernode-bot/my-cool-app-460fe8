# my-cool-app — notes for Claude Code

This app runs on **Usernode Social Vibecoding**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://social-vibecoding.usernodelabs.org/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Usernode's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

## Connector permission prompts

This repo ships `.claude/settings.json`, which allows the **read-only**
Usernode connector calls (`mcp__usernode__get_*`,
`…__list_*`, `…__whoami`) so they stop prompting one at a time. Everything
that acts — filing a request, opening or advancing a proposal — still asks.
Claude Code applies those rules only after you accept the
workspace trust dialog, which lists them for review. See `.claude/README.md`
for the whole story, including what to do if you are still being prompted
(usually: your connector is registered under a different name than the rules
assume).

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About my-cool-app

A full-screen generative-art visualization of the sun's real position
(altitude/azimuth) at the viewer's location, computed entirely
client-side (`public/solar.js`, Meeus/NOAA low-precision — no external
astronomy API). The canvas paints a sky gradient keyed to solar
altitude, today's sun arc, a star field at night, and a ridge landscape
procedurally seeded from the coordinates. Location comes from browser
geolocation with a manual city/lat-lon fallback (`public/cities.js`);
dragging the bottom edge scrubs through the day.

## App-specific conventions

- Purely client-side: no database-backed UI. The Postgres pool in
  `server.js` is constructed but unused (the template's orphan
  `presses` table was deliberately left in existing databases).
- Deterministic deep links for tests/screenshots: `?lat=&lon=` fixes
  the location, `?t=<ISO local datetime>` freezes the clock and all
  animation, `?hud=0` hides the readout. Keep these working — the
  `dapp.json` tests point at them.
- All generative elements (stars, grain, ridges) use seeded PRNGs so
  the same URL renders the same frame; don't introduce `Math.random()`
  into the render path.
