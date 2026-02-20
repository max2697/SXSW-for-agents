import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const BASE_DIR = "public";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const VERIFY_SOURCE_PARITY = String(process.env.VERIFY_SOURCE_PARITY || "1") !== "0";
const VERIFY_API_CONTRACT = String(process.env.VERIFY_API_CONTRACT || "1") !== "0";
const PARITY_SAMPLE_SIZE = Math.max(1, Number(process.env.PARITY_SAMPLE_SIZE || 8));
const API_MAX_LATENCY_MS = Math.max(100, Number(process.env.API_MAX_LATENCY_MS || 2000));
const BASE_URL = "https://schedule.sxsw.com";
const YEAR = Number(process.env.SXSW_YEAR || 2026);
const USER_AGENT = "sxsw-2026-agent-schedule-verifier/1.0 (+https://schedule.sxsw.com)";

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function hashStable(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function parseNdjson(raw) {
  const lines = raw.trim().length === 0 ? [] : raw.trim().split("\n");
  return lines.map((line) => JSON.parse(line));
}

function requiredId(event) {
  return String(event.event_id || event.id || "");
}

function fail(message) {
  throw new Error(message);
}

function sanitizeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function dateSlug(date) {
  return date === "unknown" ? "unknown-date" : date;
}

function eventPagePath(event) {
  return `${BASE_DIR}/schedule/event/${sanitizeSegment(requiredId(event))}.html`;
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];

  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }

  return out;
}

function stripRecordSignature(event) {
  const cloned = { ...event };
  delete cloned.record_version;
  delete cloned.record_sha256;
  delete cloned.record_updated_at;
  return cloned;
}

function pickSessionCookie(setCookie) {
  if (!setCookie) {
    return null;
  }
  const first = setCookie.split(",")[0];
  return first.split(";")[0]?.trim() || null;
}

async function getCsrfSession() {
  const response = await fetch(`${BASE_URL}/?year=${YEAR}`, {
    headers: { "user-agent": USER_AGENT }
  });
  if (!response.ok) {
    throw new Error(`Source bootstrap failed: HTTP ${response.status}`);
  }
  const html = await response.text();
  const token = html.match(/meta name="csrf-token" content="([^"]+)"/)?.[1] || null;
  const cookie = pickSessionCookie(response.headers.get("set-cookie"));
  if (!token || !cookie) {
    throw new Error("Source bootstrap failed: missing CSRF token or cookie");
  }
  return { token, cookie };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return await response.json();
}

async function fetchSourceIndex() {
  const { token, cookie } = await getCsrfSession();
  return await fetchJson(`${BASE_URL}/${YEAR}/search`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": token,
      cookie,
      "user-agent": USER_AGENT
    },
    body: JSON.stringify({
      term: "",
      filters: [],
      models: ["event"],
      hash: `sxsw-${YEAR}-agent-export-verify`
    })
  });
}

async function fetchSourceEvent(eventId) {
  return await fetchJson(`${BASE_URL}/api/web/${YEAR}/events/${encodeURIComponent(eventId)}`, {
    headers: { "user-agent": USER_AGENT }
  });
}

function ensureIso(label, value) {
  if (!value || Number.isNaN(Date.parse(value))) {
    fail(`${label} is missing or not an ISO timestamp: ${value}`);
  }
}

function summarizeCounts(records) {
  const out = { added: 0, modified: 0, removed: 0, cancelled: 0, uncancelled: 0 };
  for (const record of records) {
    if (record.change_type in out) {
      out[record.change_type] += 1;
    }
  }
  return out;
}

async function verifySourceParity(manifest, fullById) {
  const sourceIndex = await fetchSourceIndex();
  const hits = Array.isArray(sourceIndex.hits) ? sourceIndex.hits : [];
  const sourceIds = Array.from(
    new Set(
      hits
        .map((hit) => hit?._source?.event_id || hit?._id || hit?.favorite_id)
        .filter(Boolean)
    )
  ).sort();

  if (sourceIds.length !== manifest.stats.event_count) {
    fail(`Source parity event count mismatch: source=${sourceIds.length}, manifest=${manifest.stats.event_count}`);
  }

  const sourceDateCounts = new Map();
  for (const hit of hits) {
    const key = hit?._source?.date || "unknown";
    sourceDateCounts.set(key, (sourceDateCounts.get(key) || 0) + 1);
  }

  const sampleIds = sourceIds.slice(0, PARITY_SAMPLE_SIZE);
  const compareKeys = [
    "event_id",
    "name",
    "date",
    "start_time",
    "end_time",
    "event_type",
    "format",
    "category",
    "publish_at"
  ];

  for (const eventId of sampleIds) {
    const sourceEvent = await fetchSourceEvent(eventId);
    const localEvent = fullById.get(eventId);
    if (!localEvent) {
      fail(`Source parity sample missing local event ${eventId}`);
    }

    for (const key of compareKeys) {
      const sourceValue = sourceEvent?.[key] ?? null;
      const localValue = localEvent?.[key] ?? null;
      if (JSON.stringify(sourceValue) !== JSON.stringify(localValue)) {
        fail(`Source parity mismatch for ${eventId}.${key}: source=${JSON.stringify(sourceValue)} local=${JSON.stringify(localValue)}`);
      }
    }
  }

  return { sourceCount: sourceIds.length, sampleChecked: sampleIds.length };
}

async function verifyApiContract() {
  const { onRequest } = await import("../functions/api/[[path]].js");

  async function callApi(path) {
    const started = Date.now();
    const response = await onRequest({
      request: new Request(`https://sxsw.0fn.net/api${path}`),
      env: {}
    });
    const latencyMs = Date.now() - started;
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        fail(`API ${path} did not return JSON`);
      }
    }
    if (!response.ok) {
      fail(`API ${path} failed: HTTP ${response.status}`);
    }
    return { latencyMs, body };
  }

  const health = await callApi("/health");
  if (health.body?.status !== "ok") {
    fail(`API /health status mismatch: ${health.body?.status}`);
  }
  ensureIso("api.health.now", health.body?.now);
  ensureIso("api.health.index_timestamp", health.body?.index_timestamp);

  // Warm-cache call above should make this representative endpoint latency stable.
  const events = await callApi("/events?date=2026-03-14&q=AI&q_mode=any&limit=20");
  if (events.latencyMs > API_MAX_LATENCY_MS) {
    fail(`API latency exceeded for /events: ${events.latencyMs}ms > ${API_MAX_LATENCY_MS}ms`);
  }
  if (!Number.isInteger(events.body?.total) || events.body.total <= 0) {
    fail(`Expected non-zero total for known query, got: ${events.body?.total}`);
  }
  if (!Array.isArray(events.body?.results) || events.body.results.length === 0) {
    fail("Expected non-empty result set for known /api/events query");
  }

  const shortlist = await callApi("/shortlist?topic=ai-developer-tooling&per_day=3");
  if (!shortlist.body || !Array.isArray(shortlist.body.days) || shortlist.body.days.length === 0) {
    fail("shortlist response missing days array");
  }
  if (shortlist.body.per_day !== 3) {
    fail(`shortlist per_day mismatch: expected 3, got ${shortlist.body.per_day}`);
  }
  ensureIso("shortlist.generated_at", shortlist.body.generated_at);
  ensureIso("shortlist.index_timestamp", shortlist.body.index_timestamp);

  for (const day of shortlist.body.days) {
    if (!day?.date) fail("shortlist day missing date");
    if (!Array.isArray(day.results)) fail(`shortlist day ${day.date} missing results array`);
    if (day.results.length > 3) fail(`shortlist day ${day.date} exceeded per_day limit`);
    for (const item of day.results) {
      if (!item?.event_id) fail(`shortlist item missing event_id for day ${day.date}`);
      if (!item?.official_url) fail(`shortlist item missing official_url for day ${day.date}`);
      if (typeof item?.score !== "number") fail(`shortlist item missing numeric score for ${item?.event_id}`);
      if (!Array.isArray(item?.matched_terms)) fail(`shortlist item missing matched_terms array for ${item?.event_id}`);
      if (!Array.isArray(item?.matched_fields)) fail(`shortlist item missing matched_fields array for ${item?.event_id}`);
    }
  }

  return {
    eventsLatencyMs: events.latencyMs,
    eventsTotal: events.body.total,
    shortlistDays: shortlist.body.days.length
  };
}

async function main() {
  const manifestPath = `${BASE_DIR}/schedule.manifest.json`;
  const fullPath = `${BASE_DIR}/schedule.json.gz`;
  const agentNdjsonPath = `${BASE_DIR}/agent-schedule.v1.ndjson`;
  const schemaPath = `${BASE_DIR}/schema.json`;

  // Core files — always required (present after both site and refresh builds)
  if (!existsSync(manifestPath)) fail(`Missing ${manifestPath}`);
  if (!existsSync(fullPath)) fail(`Missing ${fullPath}`);
  if (!existsSync(`${BASE_DIR}/robots.txt`)) fail(`Missing ${BASE_DIR}/robots.txt`);
  if (!existsSync(`${BASE_DIR}/sitemap.xml`)) fail(`Missing ${BASE_DIR}/sitemap.xml`);
  if (!existsSync(`${BASE_DIR}/llms.txt`)) fail(`Missing ${BASE_DIR}/llms.txt`);
  if (!existsSync(`${BASE_DIR}/index.html`)) fail(`Missing ${BASE_DIR}/index.html`);
  if (!existsSync(`${BASE_DIR}/schedule/index.html`)) fail(`Missing ${BASE_DIR}/schedule/index.html`);
  if (!existsSync(`${BASE_DIR}/schedule/styles.css`)) fail(`Missing ${BASE_DIR}/schedule/styles.css`);
  if (!existsSync(`${BASE_DIR}/schedule/og-default.svg`)) fail(`Missing ${BASE_DIR}/schedule/og-default.svg`);
  if (!existsSync(`${BASE_DIR}/agents.json`)) fail(`Missing ${BASE_DIR}/agents.json`);

  // Refresh-only files — only present after BUILD_MODE=refresh (not site build)
  const hasAgentNdjson = existsSync(agentNdjsonPath);
  const hasSchema = existsSync(schemaPath);

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const agents = JSON.parse(await readFile(`${BASE_DIR}/agents.json`, "utf8"));
  const schema = hasSchema ? JSON.parse(await readFile(schemaPath, "utf8")) : null;
  const fullRaw = await readFile(fullPath);
  const full = JSON.parse(gunzipSync(fullRaw).toString("utf8"));
  const agentNdjson = hasAgentNdjson ? parseNdjson(await readFile(agentNdjsonPath, "utf8")) : null;
  const robotsTxt = await readFile(`${BASE_DIR}/robots.txt`, "utf8");
  const sitemapXml = await readFile(`${BASE_DIR}/sitemap.xml`, "utf8");

  if (!robotsTxt.includes("Sitemap:")) {
    fail("robots.txt missing Sitemap directive");
  }
  if (!sitemapXml.includes("<urlset") || !sitemapXml.includes("<loc>")) {
    fail("sitemap.xml missing required URL entries");
  }

  if (!manifest.compatibility?.schema_semver || !manifest.compatibility?.interface_semver) {
    fail("Manifest missing compatibility semver metadata");
  }
  if (!manifest.identity?.primary_event_id_field) {
    fail("Manifest missing identity strategy metadata");
  }
  if (!manifest.freshness?.data_staleness) {
    fail("Manifest missing freshness/data_staleness metadata");
  }

  ensureIso("manifest.generated_at", manifest.generated_at);
  ensureIso("manifest.freshness.last_successful_refresh_at", manifest.freshness.last_successful_refresh_at);
  ensureIso("manifest.freshness.source_snapshot_at", manifest.freshness.source_snapshot_at);
  ensureIso("manifest.freshness.expected_next_refresh_by", manifest.freshness.expected_next_refresh_by);
  ensureIso("manifest.freshness.stale_after", manifest.freshness.stale_after);

  if (manifest.freshness.refresh_mode !== "manual") {
    fail(`Expected refresh_mode=manual, got ${manifest.freshness.refresh_mode}`);
  }

  if (schema) {
    if (!schema.normalized_json_schema || !schema.raw_json_schema) {
      fail("schema.json missing one or more JSON Schema sections");
    }
    if (!Array.isArray(schema.normalized_required_fields) || schema.normalized_required_fields.length === 0) {
      fail("schema.json missing normalized_required_fields");
    }
  }

  if (full.events.length !== manifest.stats.event_count) {
    fail(`Event count mismatch: full=${full.events.length}, manifest=${manifest.stats.event_count}`);
  }
  if (full.fields.length !== manifest.stats.field_count) {
    fail(`Field count mismatch: full=${full.fields.length}, manifest=${manifest.stats.field_count}`);
  }
  if (agentNdjson && agentNdjson.length !== manifest.stats.event_count) {
    fail(`Agent NDJSON count mismatch: ndjson=${agentNdjson.length}, manifest=${manifest.stats.event_count}`);
  }

  const recomputedFullHash = sha256(
    JSON.stringify({
      schema_version: full.schema_version,
      generated_at: full.generated_at,
      festival_year: full.festival_year,
      stats: full.stats,
      fields: full.fields,
      events: full.events
    })
  );
  // Note: manifest.full_export_gzip removed; hash is informational only in internal build

  const fullIds = new Set();
  const fullById = new Map();
  for (const event of full.events) {
    const id = requiredId(event);
    if (!id) fail("Event without ID in full export");
    if (fullIds.has(id)) fail(`Duplicate event ID in full export: ${id}`);
    if (!existsSync(eventPagePath(event))) {
      fail(`Missing event page for event ID: ${id}`);
    }
    fullIds.add(id);
    fullById.set(id, event);
  }

  // Verify agent NDJSON IDs are consistent with full export (refresh builds only)
  if (agentNdjson) {
    for (const event of agentNdjson) {
      const id = requiredId(event);
      if (!id) fail("Event without ID in agent NDJSON");
      if (!fullIds.has(id)) fail(`Agent NDJSON ID not in full export: ${id}`);
    }
  }

  if (!agents.api?.endpoints) {
    fail("agents.json missing api.endpoints");
  }
  if (!agents.entrypoints?.manifest || !agents.entrypoints?.schema) {
    fail("agents.json missing required entrypoints (manifest, schema)");
  }


  const files = await listFiles(BASE_DIR);
  for (const file of files) {
    const info = await stat(file);
    if (info.size > MAX_FILE_BYTES) {
      fail(`File exceeds Cloudflare Pages limit (${MAX_FILE_BYTES} bytes): ${file}`);
    }
  }

  let parityResult = null;
  if (VERIFY_SOURCE_PARITY) {
    parityResult = await verifySourceParity(manifest, fullById);
  }

  let apiResult = null;
  if (VERIFY_API_CONTRACT) {
    apiResult = await verifyApiContract();
  }

  console.log("Verification passed");
  console.log(`Events: ${full.events.length}`);
  if (agentNdjson) console.log(`Agent NDJSON events: ${agentNdjson.length}`);
  console.log(`Fields: ${full.fields.length}`);
  if (parityResult) {
    console.log(`Source parity count: ${parityResult.sourceCount}`);
    console.log(`Source sample checked: ${parityResult.sampleChecked}`);
  } else {
    console.log("Source parity skipped (VERIFY_SOURCE_PARITY=0)");
  }
  if (apiResult) {
    console.log(`API events latency: ${apiResult.eventsLatencyMs}ms`);
    console.log(`API known-query total: ${apiResult.eventsTotal}`);
    console.log(`API shortlist days: ${apiResult.shortlistDays}`);
  } else {
    console.log("API contract checks skipped (VERIFY_API_CONTRACT=0)");
  }
  console.log(`Files checked: ${files.length}`);
  console.log(`Generated: ${manifest.generated_at}`);
}

main().catch((error) => {
  console.error(`Verification failed: ${error.message}`);
  process.exitCode = 1;
});
