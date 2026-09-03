# Run Club

A small app for a running club: post a run, see who is going, join in.

Built on Usernode Social Vibecoding.

## What it does

- **Home** opens with your **weekly goal** card, then lists runs under two
  tabs, **Upcoming** and **Past**. Each card shows where the run is, a
  Today / Tomorrow / date badge with the start time, its distance if the
  organizer gave one, an optional note, who is going, and a Join button.
- **New Run** is a bottom sheet behind the + button: where, when, an
  optional distance and an optional note. Posting a run makes you its
  organizer and counts you as going.
- **Run details** shows the run, its organizer, everyone who has joined,
  and Join / Leave. Organizers can cancel the run from the ... menu.

Three deep links reach those screens directly: `#new` opens the New Run
sheet, `#goal` opens the weekly goal sheet, and `#run/<id>` opens a run's
details.

## Weekly goals

Each member can set one weekly distance target. The card on Home shows how
far they have already run this week against it, with what is still on the
board for later in the week as a second, lighter segment of the same bar.

- **Only runs with a distance count.** A run posted without one is listed
  as usual and simply does not move the bar; the card says how many such
  runs the week holds.
- **A run counts for everyone attending it**, organizer included, because
  the count reads `run_attendees` rather than who posted it.
- **Nothing is stored per week and nothing resets on a schedule.** Progress
  is computed on read over the current Monday-to-Sunday window, so the week
  rolls over on its own at local midnight on Monday. The browser sends its
  IANA timezone so the window is the runner's own week, not the
  container's.

## Data model

Three tables, all created idempotently on boot in `server.js`:

- `runs` — one row per planned run (location, optional note, start time,
  organizer id and username, optional `distance_km`).
- `run_attendees` — who is going, one row per (run, user). The organizer is
  inserted here when the run is created and cannot leave; cancelling the
  run deletes the attendees with it.
- `member_goals` — one row per member holding their weekly `target_km`.

`runs` and `run_attendees` are public: a run board is content every member
of the app already sees, so staging previews get a copy of it.

`member_goals` is marked `staging:private`, so staging gets the schema and
no rows. It is the one thing this app shows only to the person it belongs
to, and seeding a goal for whoever opens a preview would fabricate the
exact "has this person set a goal?" answer the card is built to read.

## Local development

```
npm install
DATABASE_URL=postgres://... USERNODE_ENV=staging PORT=3000 node server.js
```

With `USERNODE_ENV=staging` the app seeds four obviously fake runs
("Staging demo: ...") so the screens are not blank against an empty
database. The seed is idempotent and never runs in production.

Goals are not seeded, for the reason above. To see a filled goal card in a
preview, append `?demo=1`: in staging that serves a fabricated payload from
`/api/demo/goal`, which persists nothing. In production the same route
answers `null` and the card falls back to the real read, so a demo link is
never a different app.

Tailwind is compiled by the Dockerfile's builder stage into
`public/tailwind.css`. To build it locally:

```
npx tailwindcss@3.4.17 -c tailwind.config.js \
  -i styles/tailwind-input.css -o public/tailwind.css --minify
```
