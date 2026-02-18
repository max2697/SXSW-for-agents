# SXSW 2026 Schedule — Claude Tool Guide

This document describes how a Claude agent should interact with the SXSW 2026
agent-first schedule site. All data is served as static files from Cloudflare Pages.
No authentication required.

## Base URL

```
https://sxsw-agent-schedule.pages.dev
```

## Tool Definitions (Claude Tool Use API)

```json
[
  {
    "name": "sxsw_get_agents_contract",
    "description": "Fetch the machine-readable ingestion contract for the SXSW 2026 schedule. Returns all endpoint paths, recommended ingestion order, field semantics, and the last build timestamp. Always call this first.",
    "input_schema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  },
  {
    "name": "sxsw_get_full_schedule",
    "description": "Fetch the complete normalized SXSW 2026 schedule. Returns all 2,777 events with 22 fields each including event_id, name, date, start_time, end_time, format, category, venue (with lat/lon), contributors, and tags. Use for planning, filtering, and itinerary building.",
    "input_schema": {
      "type": "object",
      "properties": {
        "format": {
          "type": "string",
          "enum": ["json", "ndjson"],
          "description": "json returns a single JSON object with an events array. ndjson returns one event per line (preferred for streaming). Defaults to json.",
          "default": "json"
        }
      },
      "required": []
    }
  },
  {
    "name": "sxsw_get_schedule_by_date",
    "description": "Fetch events for a single festival date as an NDJSON shard. More efficient than fetching the full schedule when you only need one day.",
    "input_schema": {
      "type": "object",
      "properties": {
        "date": {
          "type": "string",
          "enum": ["2026-03-12", "2026-03-13", "2026-03-14", "2026-03-15", "2026-03-16", "2026-03-17", "2026-03-18", "unknown-date"],
          "description": "Festival date in YYYY-MM-DD format. Use unknown-date for events without a confirmed date."
        }
      },
      "required": ["date"]
    }
  },
  {
    "name": "sxsw_get_manifest",
    "description": "Fetch the build manifest. Returns event count, field count, SHA256 hashes for all data files, shard map with per-date event counts, and the generated_at timestamp. Use to check data freshness before fetching large files.",
    "input_schema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  },
  {
    "name": "sxsw_get_schema",
    "description": "Fetch the field schema. Returns the mapping from normalized agent fields to raw source fields, the list of raw fields dropped from the normalized feed, and a sample event record. Use when you need to understand what fields are available or access dropped fields.",
    "input_schema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  },
  {
    "name": "sxsw_get_changes",
    "description": "Fetch the change feed since the last build. Returns a summary line (added/modified/removed counts) followed by individual change records. Use to detect schedule updates without re-ingesting the full dataset.",
    "input_schema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  }
]
```

## Endpoint Map

| Tool | Endpoint |
|------|---------|
| `sxsw_get_agents_contract` | `GET /agents.json` |
| `sxsw_get_full_schedule` (json) | `GET /agent-schedule.v1.json` |
| `sxsw_get_full_schedule` (ndjson) | `GET /agent-schedule.v1.ndjson` |
| `sxsw_get_schedule_by_date` | `GET /events/by-date/{date}.ndjson` |
| `sxsw_get_manifest` | `GET /schedule.manifest.json` |
| `sxsw_get_schema` | `GET /schema.json` |
| `sxsw_get_changes` | `GET /changes.ndjson` |

## Recommended Agent Workflow for Itinerary Planning

1. Call `sxsw_get_manifest` → check `generated_at` and `stats.event_count`
2. Call `sxsw_get_full_schedule` → load all events
3. Filter events client-side by:
   - `date` for specific days
   - `category` or `format` for event types
   - `contributors[].name` for specific speakers
   - `venue.name` for location-based filtering
   - `reservable` to identify events requiring advance reservation
4. Build itinerary, checking `start_time`/`end_time` for conflicts
5. Return `official_url` links so the user can reserve/bookmark on the SXSW app

## Key Field Notes

- **Timezone**: All timestamps are `America/Chicago` (UTC-5). `2026-03-15T10:00:00.000-05:00` = 10 AM Austin local time.
- **Conflicts**: Two events conflict if their date matches and time ranges overlap.
- **Reservations**: `reservable: true` means the user must reserve via the official SXSW app.
- **Speakers**: Look in `contributors[]` with `type: "artist"` or `type: "speaker"`.
- **Full descriptions**: Not in the normalized feed. Fetch `/schedule/event/{event_id}.html` for the rendered page, or `/schedule.json.gz` for `long_description` in the raw data.

## Example: Filter Events by Speaker Name

```javascript
const schedule = await fetch('https://sxsw-agent-schedule.pages.dev/agent-schedule.v1.json').then(r => r.json());
const events = schedule.events.filter(e =>
  e.contributors.some(c => c.name.toLowerCase().includes('openai'))
);
```

## Example: Get March 15 Events Only

```bash
curl https://sxsw-agent-schedule.pages.dev/events/by-date/2026-03-15.ndjson | \
  while IFS= read -r line; do echo "$line" | jq '{name,start_time,venue:.venue.name}'; done
```
