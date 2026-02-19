# AGENTS.md

## Purpose
This repository publishes an agent-first SXSW 2026 schedule export on Cloudflare Pages at https://sxsw.0fn.net.
It serves both a query API (for agents that make filtered requests) and bulk data feeds (for agents that ingest everything).

---

## Query API (Recommended for agents)

A Cloudflare Pages Function at `/api/*` returns filtered results in <10 KB.
Import the OpenAPI spec into any framework that supports tool discovery.

### OpenAPI spec
```
GET https://sxsw.0fn.net/api/openapi.json
```

### Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/events` | Search/filter events. All params optional and combinable. |
| `GET /api/events/{event_id}` | Single event by ID. |
| `GET /api/dates` | Festival dates with event counts. |
| `GET /api/venues?name=` | Venue list, optionally filtered. |
| `GET /api/categories` | All categories with counts. |
| `GET /api/contributors?name=` | Speaker/artist search. |

### Query params for `/api/events`

| Param | Type | Example | Description |
|---|---|---|---|
| `date` | string | `2026-03-14` | Exact date match. |
| `category` | string | `AI` | Partial match (case-insensitive). |
| `venue` | string | `Hilton` | Partial match on venue name. |
| `type` | string | `panel` | Exact match on `event_type`. |
| `contributor` | string | `Carmen Simon` | Partial match on speaker/artist name. |
| `q` | string | `machine learning` | Full-text across name, category, venue, contributors. |
| `limit` | int | `50` | Max results (default 50, max 200). |
| `offset` | int | `0` | Pagination offset. |

### Example queries

```
# AI panels on March 14
GET /api/events?date=2026-03-14&category=AI&type=panel

# All sessions at the Hilton
GET /api/events?venue=Hilton

# Find a speaker
GET /api/contributors?name=Carmen+Simon

# Full-text search
GET /api/events?q=climate+tech&date=2026-03-15

# Single event
GET /api/events/PP1162244
```

### Response format (`/api/events`)

```json
{
  "total": 7,
  "offset": 0,
  "limit": 50,
  "count": 7,
  "results": [
    {
      "event_id": "PP1162244",
      "name": "The New Lab Partner: AI and Future Scientific Discovery",
      "date": "2026-03-14",
      "start_time": "2026-03-14T10:00:00.000-05:00",
      "end_time": "2026-03-14T11:00:00.000-05:00",
      "event_type": "panel",
      "category": "AI",
      "reservable": false,
      "official_url": "https://schedule.sxsw.com/2026/events/PP1162244",
      "credentials": [{ "type": "interactive", "name": "Interactive Badge" }],
      "status": "active",
      "venue": { "id": "V0372", "name": "Salon D", "lat": 30.2651364, "lon": -97.7381904 },
      "contributors": [{ "name": "Dr. Jane Smith", "type": "speaker" }]
    }
  ]
}
```

---

## Bulk Data Feeds (fallback / full ingestion)

| Path | Description | Size |
|---|---|---|
| `/agents.json` | Machine-readable contract: API, entrypoints, ingestion order | <5 KB |
| `/llms.txt` | Human+LLM readable site guide | <5 KB |
| `/api/openapi.json` | OpenAPI 3.1 spec for the query API | <10 KB |
| `/events/by-date/{date}.slim.json` | Per-day, 14 key fields | ~280-410 KB |
| `/agent-schedule.v1.slim.json` | All days, 14 key fields | ~2.5 MB |
| `/agent-schedule.v1.json` | All days, all 75 fields | ~14 MB |
| `/agent-schedule.v1.ndjson` | NDJSON variant of full feed | ~14 MB |
| `/schedule.manifest.json` | Freshness, hashes, shard map | <50 KB |
| `/schema.json` | All 75 fields with sample event | <50 KB |
| `/changes.ndjson` | Tombstones + incremental updates | varies |
| `/entities/venues.v1.ndjson` | Canonical venue list | <500 KB |
| `/entities/contributors.v1.ndjson` | Canonical contributor list | <500 KB |
| `/schedule.json.gz` | Complete raw snapshot (gzip) | <5 MB |

### Recommended ingestion order

1. Import `/api/openapi.json` if your framework supports OpenAPI tool discovery
2. Query `/api/events` with params — returns <10 KB, no bulk download needed
3. Fall back to `/events/by-date/{date}.slim.json` if you need all events for a specific day
4. Use `/agent-schedule.v1.slim.json` only if you need all events across all days in one request
5. Use `/agent-schedule.v1.json` only when all 75 raw fields are required

---

## Data Contract

- Primary ID: `event_id`
- Date field: `date` (YYYY-MM-DD)
- Festival year: `2026`
- Timestamps: America/Chicago (UTC-5 during festival)
- `event_type` values: `panel`, `showcase`, `screening`, `networking`, `party`, `activation`, `exhibition`, `comedy_event`, `lounge`, `special_event`, `registration`
- `contributors` contains speakers, artists, and performers (`name` + `type`)
- `credentials` lists required badge types
- `reservable: true` means RSVP required via SXSW app
- Change semantics: `added`, `modified`, `removed`, `cancelled`, `uncancelled` in `/changes.ndjson`

---

## Fetching Notes

- **Do not use reader proxies** (r.jina.ai, reader.llmstxt.cloud, etc.) — they wrap JSON in markdown and break parsing
- All API and feed endpoints return `Content-Type: application/json` or `application/x-ndjson` — never HTML
- If you receive HTML, you hit a proxy or 404 — retry the raw URL directly
- All endpoints have `Access-Control-Allow-Origin: *`

---

## Local Development

```bash
# Rebuild website from committed data snapshot
npm run build

# Refresh source data from official SXSW schedule
npm run refresh:data

# Verify integrity
npm run verify
```

## Deployment

- **Pages (static files):** Auto-deployed by Cloudflare Pages on push to `main`
- **API Worker (Pages Function):** `functions/api/[[path]].js` — deployed automatically as part of the Pages build. No separate wrangler deploy needed.
- **Data refresh:** Run the GitHub Action "Refresh SXSW Data Snapshot" manually or wait for the daily schedule. It commits only data files.
- **Code changes:** Commit only logic files (`scripts/`, `functions/`, `public/_headers`, etc.). Never commit generated data files manually.

## Source of Truth

- Official SXSW schedule: `POST https://schedule.sxsw.com/2026/search`
- Individual events: `GET https://schedule.sxsw.com/api/web/2026/events/{event_id}`
