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

## About Run Club

Run Club exists to get a group of people out on a run together. The whole
product is three screens: a list of upcoming runs, a sheet for posting a
new one, and a run's details with who is going. Anything that is not
"where, when, who is coming" is out of scope by default; ask before adding
a surface rather than growing the app sideways.

## App-specific conventions

- **`runs` and `run_attendees` are public tables.** A run board is content
  every member of the app already sees, so staging gets a copy. Do not add
  a column that would change that (no private notes, no contact details).
- **The organizer is an attendee.** Creating a run inserts the organizer
  into `run_attendees` in the same transaction, and the API refuses to let
  them leave. Anything that counts "who is going" should read that table
  rather than special-casing the organizer.
- **Read-only run endpoints are deliberately public.** `GET /api/runs` and
  `GET /api/runs/:id` bypass the JWT gate via `PUBLIC_GET_API` in
  `server.js`; every write still requires `req.user`. This is what lets the
  platform's automated checks, which navigate with no token, exercise the
  real screens.
- **Tailwind class names must be whole literals.** The stylesheet is
  compiled at image-build time by a regex extractor, so glyph tints, avatar
  colors and tab states are written as complete strings picked from a map,
  never assembled at runtime.
- **No em dashes in user-facing copy.** Platform-wide rule; it applies to
  every label, empty state and toast in `public/index.html`.
- **Every clock time goes through `fmtTime`.** The am/pm vs 24h toggle works by
  flipping one value in `state.timeFormat`, so a new screen that renders a time
  must call the shared helper rather than its own `Intl.DateTimeFormat`. Tag the
  element `run-time` so the checks can assert on it. The choice is remembered in
  `localStorage` under `runclub.timeFormat` (plus a `:<username>` key when a
  token is present), and `?tf=12` / `?tf=24` sets it for a single load without
  persisting. With no stored choice the default is whatever the resolved locale
  renders, so the screen looks the same as it did before the toggle existed.
- **The New Run date and time picker is not themeable.** It is a native
  `datetime-local` control, so the operating system decides whether it offers
  am/pm or 24h there. The toggle only governs times the app itself renders.
