# AGENTS.md

## Purpose
This repository publishes an agent-first static SXSW schedule export for Cloudflare Pages.

## Consume Data (Recommended Order)
1. Read `public/agents.json`.
2. Read `public/schedule.manifest.json` for metadata, freshness, compatibility policy, and shard map.
3. Read `public/agent-schedule.v1.json` for simplest full ingestion.
4. Read `public/changes.ndjson` for incremental updates and tombstones.
5. Read `public/entities/venues.v1.ndjson` and `public/entities/contributors.v1.ndjson` for canonical cross-event joins.
6. Ingest `public/agent-schedule.v1.ndjson` or `public/events/by-date/*.ndjson` for streaming/partial refresh.
7. Use `public/schedule.json.gz` only when complete raw source-level snapshot is required.

## Website Paths
- `public/index.html`: root landing page
- `public/schedule/index.html`: day-by-day schedule entrypoint
- `public/schedule/date/*.html`: one page per date
- `public/schedule/event/*.html`: one page per event

## Data Contract
- Primary ID field: `event_id`
- Date field: `date`
- Festival year: `2026` (configurable via `SXSW_YEAR`)
- Normalized records explicitly split fields into `raw`, `derived`, `canonical`, and `provenance` blocks.
- Per-record versioning fields: `record_version`, `record_sha256`, `record_updated_at`.
- Change semantics: `added`, `modified`, `removed`, `cancelled`, `uncancelled`; tombstones appear in `public/changes.ndjson`.
- Full export is compressed (`.gz`) to stay under Cloudflare Pages asset-size limits.
- Shards are NDJSON, one event object per line.
- Freshness metadata in `public/schedule.manifest.json`: `last_successful_refresh_at`, `source_snapshot_at`, `expected_next_refresh_by`, `data_staleness`.

## Refresh and Validate
- Rebuild website from committed snapshot:
  - `npm run build`
- Refresh source data manually (official SXSW network calls):
  - `npm run refresh:data`
- Verify integrity:
  - `npm run verify`
- Optional automation:
  - `.github/workflows/refresh-data.yml` runs scheduled refresh every day and commits only when snapshot files change.

## Source of Truth
- Official SXSW schedule website only:
  - `POST https://schedule.sxsw.com/2026/search`
  - `GET https://schedule.sxsw.com/api/web/2026/events/{event_id}`
