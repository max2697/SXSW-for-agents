# SXSW 2026 Agent-First Schedule Export

Static site and data export for Cloudflare Pages, using the official SXSW schedule source.

## Using the Website (Humans)

Live site:
- [sxsw.0fn.net](https://sxsw.0fn.net)

How to browse:
1. Open [Home](https://sxsw.0fn.net/).
2. Click **Browse Full Schedule** or open [Schedule by day](https://sxsw.0fn.net/schedule/index.html).
3. Pick a date page (for example [March 15](https://sxsw.0fn.net/schedule/date/2026-03-15.html)).
4. Click any event title to open its event detail page.
5. Use the **Official** link on event/day pages to jump to the source SXSW page.

Useful machine/data links (still human-readable):
- [Manifest](https://sxsw.0fn.net/schedule.manifest.json)
- [Agent feed JSON](https://sxsw.0fn.net/agent-schedule.v1.json)
- [Changes feed](https://sxsw.0fn.net/changes.ndjson)
- [Schema](https://sxsw.0fn.net/schema.json)

## AI Assistant Examples (Copy/Paste)

Use these prompts in Claude, ChatGPT, Gemini, Perplexity, or coding agents.

### 1) Find sessions by topic and date
```text
Use https://sxsw.0fn.net as source.
Read /schedule.manifest.json first, then /agent-schedule.v1.json.
Find SXSW 2026 sessions on 2026-03-15 about AI safety.
Return: event_id, name, start_time, end_time, venue.name, official_url.
Sort by start_time.
```

### 2) Venue-based search
```text
Use https://sxsw.0fn.net/agent-schedule.v1.json.
Find all sessions at Austin Convention Center on 2026-03-14.
Return a compact table with time, session name, format, and event_id.
```

### 3) Speaker lookup
```text
Use https://sxsw.0fn.net/agent-schedule.v1.json.
Find sessions where contributors include "Meredith Whittaker".
Return date, time, event name, event_id, and official_url.
```

### 4) Incremental update check (for agents/tools)
```text
Use https://sxsw.0fn.net/changes.ndjson.
Summarize added/modified/removed/cancelled events since the previous snapshot.
If there are removed/cancelled events, list tombstones first.
```

### 5) Best ingestion flow for an agent
```text
Use https://sxsw.0fn.net/agents.json and follow its recommended ingestion order.
Build a shortlist of "top AI + developer tooling sessions" for each day.
Use only SXSW 2026 events and include event_id + official_url in every item.
```

## Using the Repo (Humans)

Prerequisite:
- Node.js 22+ recommended

Local setup:
```bash
git clone git@github.com:max2697/SXSW-for-agents.git
cd SXSW-for-agents
npm run build
npm run verify
```

Open local output:
- `public/index.html` in your browser
- `public/schedule/index.html` for day-by-day browsing

Typical refresh workflow:
```bash
npm run build
npm run verify
git add .
git commit -m "Refresh SXSW schedule snapshot"
git push
```

After push, GitHub Actions verifies the export and Cloudflare Pages deploys from `main`.

## What It Produces

- `/agents.json`: machine-readable ingestion guide
- `/agent-schedule.v1.json`: simplest normalized agent feed (single file)
- `/agent-schedule.v1.ndjson`: normalized agent feed for streaming
- `/schedule.manifest.json`: canonical entrypoint for agents
- `/changes.ndjson`: incremental diff feed with tombstones (`added`, `modified`, `removed`, `cancelled`, `uncancelled`)
- `/schedule.json.gz`: full canonical dataset (gzip compressed)
- `/events/by-date/*.ndjson`: day-sharded stream-friendly records
- `/entities/venues.v1.ndjson`: canonical venue entity index
- `/entities/contributors.v1.ndjson`: canonical contributor entity index
- `/schema.json`: field inventory and metadata
- `/index.html`: website landing page
- `/schedule/index.html`: static schedule browser (by day)
- `/schedule/date/*.html`: day schedule pages
- `/schedule/event/*.html`: event detail pages
- `/robots.txt`: crawler directives
- `/sitemap.xml`: sitemap for all static schedule pages

## Data Source

Build pipeline reads from official endpoints:

- `POST https://schedule.sxsw.com/2026/search`
- `GET https://schedule.sxsw.com/api/web/2026/events/{event_id}`

## Build

```bash
npm run build
npm run verify
```

Optional environment variables:

- `SXSW_YEAR` (default `2026`)
- `CONCURRENCY` (default `8`)
- `RETRIES` (default `4`)
- `REFRESH_INTERVAL_HOURS` (default `72`) for expected next refresh metadata
- `STALE_AFTER_HOURS` (default `96`) for stale-flag metadata
- `SITE_URL` (default `https://sxsw-agent-schedule.pages.dev`) for canonical URLs and sitemap

## Cloudflare Pages

Use:

- Build command: `npm run build`
- Build output directory: `public`

This project is static-only after build.

The exporter shards NDJSON by date and emits a compressed full dataset to stay under Cloudflare Pages per-file size limits.
Build metadata includes manual-refresh freshness signals (`last_successful_refresh_at`, `source_snapshot_at`, `expected_next_refresh_by`, `data_staleness`) and compatibility policy guarantees.

See `AGENTS.md` for direct agent-consumption instructions.
