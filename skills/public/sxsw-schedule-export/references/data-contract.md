# Data Contract — SXSW 2026 Agent Schedule

## Official Source

- `POST https://schedule.sxsw.com/2026/search` — discovers all event IDs
- `GET https://schedule.sxsw.com/api/web/2026/events/{event_id}` — hydrates event details

## Artifact Contract

| File | Purpose | Format | Size |
|------|---------|--------|------|
| `/llms.txt` | LLM discovery — site overview, key endpoints, field guide | Plain text | ~3 KB |
| `/agents.json` | Agent ingestion guide — entrypoints, ingestion order, expectations | JSON | ~4 KB |
| `/schedule.manifest.json` | Build metadata, SHA256 hashes, shard map, field list | JSON | ~8 KB |
| `/agent-schedule.v1.json` | All events, 22 normalized fields, single file | JSON | ~4.5 MB |
| `/agent-schedule.v1.ndjson` | Same as above, one event per line | NDJSON | ~3.5 MB |
| `/schema.json` | Field inventory: normalized→raw mapping, dropped fields, sample record | JSON | ~20 KB |
| `/changes.ndjson` | Diff vs previous build (added/modified/removed events) | NDJSON | varies |
| `/schedule.json.gz` | Full snapshot, all 75 raw fields, gzip compressed | JSON.gz | ~5.5 MB |
| `/events/by-date/*.ndjson` | One NDJSON file per festival date (8 shards) | NDJSON | 4–6 MB each |

## Recommended Ingestion Order

1. `GET /llms.txt` — orientation for the site
2. `GET /agents.json` — machine-readable guide; check `generated_at` for freshness
3. `GET /changes.ndjson` — if you have a previous snapshot, check what changed first
4. `GET /agent-schedule.v1.json` — full schedule in one request (easiest)
5. `GET /events/by-date/{date}.ndjson` — for date-filtered or streaming ingestion
6. `GET /schedule.json.gz` — only if you need the 53 raw fields dropped from the normalized feed

## Key Fields (Normalized Feed — `agent-schedule.v1.json`)

| Field | Type | Source raw field(s) | Notes |
|-------|------|-------------------|-------|
| `event_id` | string | `event_id` (fallback: `id`) | Primary identifier |
| `name` | string | `name` | Event title |
| `date` | string (YYYY-MM-DD) | `date` | Local date in Austin |
| `start_time` | string (ISO 8601) | `start_time` | Includes UTC-5 offset |
| `end_time` | string (ISO 8601) | `end_time` | Includes UTC-5 offset |
| `event_type` | string | `event_type` | e.g. "Session", "Screening" |
| `format` | string | `format` | e.g. "Panel", "Keynote", "Solo" |
| `category` | string | `category` | e.g. "Film & TV", "Music" |
| `genre` | string | `genre` | Subclassification within category |
| `subgenre` | string | `subgenre` | Further subclassification |
| `track` | string | `track` | Conference track |
| `focus_area` | string | `focus_area` | Thematic focus |
| `presented_by` | string | `presented_by` | Sponsor/presenter name |
| `reservable` | boolean | `reservable` | True = reservation required via SXSW app |
| `reservable_id` | string | `reservable_id` | ID for reservation system |
| `official_url` | string (URL) | constructed | `https://schedule.sxsw.com/2026/events/{event_id}` |
| `venue` | object | `venue.*`, `venue.location.*` | See venue fields below |
| `credentials` | array | `credentials[].type`, `.name` | Badge types required |
| `contributors` | array | `contributors[].entity_id`, `.id`, `.name`, `.type` | Speakers/artists/performers |
| `tags` | string[] | `tags` | Freeform tags |
| `hash_tags` | string[] | `hash_tags` | Twitter/social hashtags |
| `publish_at` | string (ISO 8601) | `publish_at` | When event was published |

### Venue Object Fields

| Field | Source |
|-------|--------|
| `id` | `venue.id` |
| `name` | `venue.name` |
| `root` | `venue.root` or `venue.root.name` |
| `address` | `venue.location.address` |
| `city` | `venue.location.city` |
| `state` | `venue.location.state` |
| `postal_code` | `venue.location.postal_code` |
| `lat` | `venue.location.lat_lon[0]` |
| `lon` | `venue.location.lat_lon[1]` |

## Raw Fields NOT in Normalized Feed

These 53+ fields are only in `/schedule.json.gz`. Check `/schema.json` → `dropped_fields` for the current complete list. Examples:

- `accessibility`, `accessible_venue`, `american_sign_language`, `audio_description`
- `caption_url`, `closed_captioned`, `open_captioned`, `has_subtitles`, `strobe_warning`
- `description`, `long_description` (use these for richer event summaries)
- `films`, `trailer_id`, `trailer_url`, `vimeo_id`, `youtube_id`
- `stream_url`, `stream_id`, `stream_embed`, `mobile_audio_url`
- `meeting_url`, `meeting_url_live`, `slido_url`, `mentorly_url`
- `recommended_ids`, `related_sales_client`
- `experience_level`, `age_policy`, `cpe_credit`

> **Note:** `description` and `long_description` are in the raw export but not the normalized feed. Fetch `/schedule.json.gz` or individual event HTML pages at `/schedule/event/{event_id}.html` for full descriptions.

## Changes Feed (`/changes.ndjson`)

The first line of `/changes.ndjson` is always a summary object:

```json
{"generated_at":"...","festival_year":2026,"total_changes":42,"added":10,"modified":30,"removed":2,"note":"Diff vs previous build."}
```

Subsequent lines are individual change records:

```json
{"change":"added","event_id":"abc123","name":"My Session","date":"2026-03-15"}
{"change":"modified","event_id":"def456","name":"Other Session","date":"2026-03-14"}
{"change":"removed","event_id":"ghi789","name":"Removed Session","date":"2026-03-13"}
```

On the first build, all events appear as `"added"` with a note indicating no previous build was found.

## Integrity Rules

- `manifest.stats.event_count` must equal:
  - Total events in `agent-schedule.v1.json`
  - Total NDJSON records across all shard files
- `manifest.stats.shard_count` must equal the number of shard files
- `manifest.full_export_gzip.sha256` must match the hash of `schedule.json.gz` payload
- `manifest.agent_interface.sha256_json` must match hash of `agent-schedule.v1.json`
- `manifest.agent_interface.sha256_ndjson` must match hash of `agent-schedule.v1.ndjson`
- Every `event_id` is unique across the full export and all shards

Run `npm run verify` to validate all integrity rules locally.

## Timezone Notes

All timestamps use `America/Chicago` timezone (UTC-5 during SXSW 2026).
Example: `"2026-03-15T10:00:00.000-05:00"` = 10 AM Austin local time.

## CORS and HTTP Headers

All JSON/NDJSON endpoints include:
- `Access-Control-Allow-Origin: *`
- Appropriate `Content-Type` headers
- 5-minute `Cache-Control` (300s)

Fetch from any origin without credentials.
