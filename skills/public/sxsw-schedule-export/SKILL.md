---
name: sxsw-schedule-export
description: Rebuild and verify the SXSW schedule static export in this repository. Use when an agent needs to refresh data from the official SXSW schedule source, validate output integrity, confirm Cloudflare Pages file-size safety, or check generated artifacts for agent ingestion.
---

# SXSW Schedule Export

## Overview
Run the repository export pipeline and integrity checks for the agent-first SXSW schedule feed. Prefer this skill for refresh, validation, and handoff tasks tied to `public/` outputs.

## Quick Start
From the repo root:

```bash
npm run build
npm run verify
```

## Workflow
1. Confirm repository layout includes:
- `scripts/build-schedule.mjs`
- `scripts/verify-export.mjs`
- `public/`
2. Run `npm run build` to fetch official SXSW data and regenerate static outputs.
3. Run `npm run verify` to validate hashes, shard counts, ID uniqueness, and shard/full consistency.
4. Check output inventory and sizes:
- `public/agents.json`
- `public/schedule.manifest.json`
- `public/schedule.json.gz`
- `public/schema.json`
- `public/events/by-date/*.ndjson`
5. Confirm no generated file exceeds Cloudflare Pages file-size constraints.

## Expected Outputs
- `public/agents.json`: machine-readable ingestion guide
- `public/schedule.manifest.json`: canonical metadata and shard map
- `public/schedule.json.gz`: full compressed snapshot
- `public/schema.json`: field inventory and sample record
- `public/events/by-date/*.ndjson`: shard files for incremental ingestion

## Troubleshooting
- If build fails on source fetches, retry `npm run build` (the exporter already retries transient HTTP failures).
- If verify fails, treat output as non-publishable and rerun build before further debugging.
- If file sizes grow unexpectedly, inspect shard distribution and the compressed full export before deployment.

## Additional Reference
Load `references/data-contract.md` when you need exact artifact semantics and ingestion rules.
