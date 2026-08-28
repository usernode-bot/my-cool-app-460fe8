# Run Club

A small app for a running club: post a run, see who is going, join in.

Built on Usernode Social Vibecoding.

## What it does

- **Home** lists runs under two tabs, **Upcoming** and **Past**. Each card
  shows where the run is, a Today / Tomorrow / date badge with the start
  time, an optional note, who is going, and a Join button.
- **New Run** is a bottom sheet behind the + button: where, when, and an
  optional note. Posting a run makes you its organizer and counts you as
  going.
- **Run details** shows the run, its organizer, everyone who has joined,
  and Join / Leave. Organizers can cancel the run from the ... menu.

Two deep links reach those screens directly: `#new` opens the New Run
sheet, `#run/<id>` opens a run's details.

## Data model

Two public tables, both created idempotently on boot in `server.js`:

- `runs` — one row per planned run (location, optional note, start time,
  organizer id and username).
- `run_attendees` — who is going, one row per (run, user). The organizer is
  inserted here when the run is created and cannot leave; cancelling the
  run deletes the attendees with it.

Neither table is marked `staging:private`: a run board is content every
member of the app already sees, so staging previews get a copy of it.

## Local development

```
npm install
DATABASE_URL=postgres://... USERNODE_ENV=staging PORT=3000 node server.js
```

With `USERNODE_ENV=staging` the app seeds three obviously fake runs
("Staging demo: ...") so the screens are not blank against an empty
database. The seed is idempotent and never runs in production.

Tailwind is compiled by the Dockerfile's builder stage into
`public/tailwind.css`. To build it locally:

```
npx tailwindcss@3.4.17 -c tailwind.config.js \
  -i styles/tailwind-input.css -o public/tailwind.css --minify
```
