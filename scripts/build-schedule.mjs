import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

const BASE_URL = "https://schedule.sxsw.com";
const SITE_URL = String(process.env.SITE_URL || "https://sxsw.0fn.net").replace(
  /\/+$/,
  ""
);
const REPOSITORY_URL = "https://github.com/max2697/SXSW-for-agents";
const BUILD_MODE = String(process.env.BUILD_MODE || "refresh").trim().toLowerCase();
const YEAR = Number(process.env.SXSW_YEAR || 2026);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const RETRIES = Number(process.env.RETRIES || 4);
const SCHEMA_VERSION = "1.1.0";
const INTERFACE_VERSION = "v1.1";
const REFRESH_INTERVAL_HOURS = Number(process.env.REFRESH_INTERVAL_HOURS || 24);
const STALE_AFTER_HOURS = Number(process.env.STALE_AFTER_HOURS || 96);
const OUTPUT_DIR = "public";

const USER_AGENT =
  "sxsw-2026-agent-schedule-exporter/1.0 (+https://schedule.sxsw.com)";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickSessionCookie(setCookie) {
  if (!setCookie) {
    return null;
  }

  // This endpoint currently sets one session cookie, so first pair is enough.
  const first = setCookie.split(",")[0];
  return first.split(";")[0]?.trim() || null;
}

async function getCsrfSession() {
  const url = `${BASE_URL}/?year=${YEAR}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to bootstrap session: ${response.status}`);
  }

  const html = await response.text();
  const tokenMatch = html.match(/meta name="csrf-token" content="([^"]+)"/);
  const token = tokenMatch?.[1];
  const cookie = pickSessionCookie(response.headers.get("set-cookie"));

  if (!token || !cookie) {
    throw new Error("Could not extract CSRF token or session cookie");
  }

  return { token, cookie };
}

async function fetchJsonWithRetry(url, options = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES) {
        const backoffMs = 300 * 2 ** (attempt - 1) + Math.floor(Math.random() * 120);
        await sleep(backoffMs);
      }
    }
  }

  throw lastError;
}

async function fetchEventIndex() {
  const { token, cookie } = await getCsrfSession();
  const url = `${BASE_URL}/${YEAR}/search`;
  const payload = {
    term: "",
    filters: [],
    models: ["event"],
    hash: `sxsw-${YEAR}-agent-export`
  };

  return await fetchJsonWithRetry(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": token,
      cookie,
      "user-agent": USER_AGENT
    },
    body: JSON.stringify(payload)
  });
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => runWorker()
  );
  await Promise.all(workers);
  return results;
}

async function fetchEventDetails(eventIds) {
  let completed = 0;

  const records = await mapWithConcurrency(eventIds, CONCURRENCY, async (eventId) => {
    const url = `${BASE_URL}/api/web/${YEAR}/events/${encodeURIComponent(eventId)}`;

    try {
      const record = await fetchJsonWithRetry(url, {
        headers: { "user-agent": USER_AGENT }
      });
      completed += 1;
      if (completed % 100 === 0 || completed === eventIds.length) {
        console.log(`Fetched ${completed}/${eventIds.length} event detail records`);
      }
      return { ok: true, eventId, record };
    } catch (error) {
      completed += 1;
      console.warn(`Failed ${eventId}: ${error.message}`);
      if (completed % 100 === 0 || completed === eventIds.length) {
        console.log(`Fetched ${completed}/${eventIds.length} event detail records`);
      }
      return { ok: false, eventId, error: String(error) };
    }
  });

  const success = records.filter((r) => r.ok).map((r) => r.record);
  const failed = records.filter((r) => !r.ok).map((r) => r.eventId);

  return { success, failed };
}

function collectFieldStats(events) {
  const fields = new Set();

  for (const event of events) {
    for (const key of Object.keys(event)) {
      fields.add(key);
    }
  }

  return Array.from(fields).sort();
}

function byStartTime(a, b) {
  const aTime = Date.parse(a.start_time || "") || 0;
  const bTime = Date.parse(b.start_time || "") || 0;
  if (aTime !== bTime) {
    return aTime - bTime;
  }
  return String(a.event_id || a.id || "").localeCompare(String(b.event_id || b.id || ""));
}

function buildHash(data) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
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

function hashStable(data) {
  return createHash("sha256").update(JSON.stringify(stableValue(data))).digest("hex");
}

function toEpochMs(timestamp) {
  if (!timestamp) {
    return null;
  }
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

function addHours(isoTimestamp, hours) {
  const base = Date.parse(isoTimestamp);
  if (Number.isNaN(base)) {
    return isoTimestamp;
  }
  return new Date(base + hours * 60 * 60 * 1000).toISOString();
}

function maxIsoTimestamp(values) {
  let max = null;
  for (const value of values) {
    const parsed = Date.parse(value || "");
    if (Number.isNaN(parsed)) {
      continue;
    }
    if (max === null || parsed > max) {
      max = parsed;
    }
  }
  return max === null ? null : new Date(max).toISOString();
}

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase();
}

function toNdjson(events) {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

function parseNdjson(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return [];
  }
  return text.split("\n").map((line) => JSON.parse(line));
}

function groupByDate(events) {
  const groups = new Map();

  for (const event of events) {
    const key = typeof event.date === "string" && event.date.length > 0 ? event.date : "unknown";
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(event);
  }

  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function eventId(event) {
  return String(event?.event_id || event?.id || "unknown-id");
}

function sanitizeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function dateSlug(date) {
  return date === "unknown" ? "unknown-date" : date;
}

function datePagePath(date) {
  return `/schedule/date/${dateSlug(date)}.html`;
}

function eventPagePath(event) {
  return `/schedule/event/${sanitizeSegment(eventId(event))}.html`;
}

function absoluteUrl(path) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${SITE_URL}${normalized}`;
}

function formatDateLabel(date) {
  if (date === "unknown") {
    return "Unknown Date";
  }

  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(parsed);
}

function formatTimeLabel(timestamp) {
  if (!timestamp) {
    return "TBD";
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return String(timestamp);
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(parsed);
}

function formatTimeRange(event) {
  const start = formatTimeLabel(event.start_time);
  const end = formatTimeLabel(event.end_time);
  if (start === "TBD" && end === "TBD") {
    return "TBD";
  }
  if (end === "TBD") {
    return start;
  }
  return `${start} - ${end}`;
}

function officialEventUrl(event) {
  return `${BASE_URL}/${YEAR}/events/${encodeURIComponent(eventId(event))}`;
}

function venueLabel(event) {
  const venue = event?.venue || {};
  const name = venue.name || "TBD Venue";
  const rootName = typeof venue.root === "string" ? venue.root : venue.root?.name;
  if (rootName && rootName !== name) {
    return `${name} (${rootName})`;
  }
  return name;
}

function normalizeVenue(event) {
  const venue = event?.venue || {};
  const location = venue.location || {};
  const root = typeof venue.root === "string" ? venue.root : venue.root?.name || null;

  return {
    id: venue.id || null,
    name: venue.name || null,
    root,
    address: location.address || null,
    city: location.city || null,
    state: location.state || null,
    postal_code: location.postal_code || null,
    lat: Array.isArray(location.lat_lon) ? location.lat_lon[0] ?? null : null,
    lon: Array.isArray(location.lat_lon) ? location.lat_lon[1] ?? null : null
  };
}

function normalizeCredentials(event) {
  if (!Array.isArray(event.credentials)) {
    return [];
  }
  return event.credentials.map((credential) => ({
    type: credential?.type || null,
    name: credential?.name || null
  }));
}

function normalizeContributors(event) {
  if (!Array.isArray(event.contributors)) {
    return [];
  }
  return event.contributors.map((person) => ({
    entity_id: person?.entity_id ?? null,
    id: person?.id ?? null,
    name: person?.name || null,
    type: person?.type || null
  }));
}

function detectEventStatus(event) {
  const text = [
    event?.message,
    event?.name,
    event?.description,
    event?.long_description
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /\bcancelled\b|\bcanceled\b/.test(text) ? "cancelled" : "active";
}

function normalizeTagSet(event) {
  const merged = [
    ...(Array.isArray(event.tags) ? event.tags : []),
    ...(Array.isArray(event.hash_tags) ? event.hash_tags : [])
  ];
  return Array.from(new Set(merged.map(normalizeToken).filter(Boolean))).sort();
}

function deriveEventShape(event) {
  const startEpochMs = toEpochMs(event.start_time);
  const endEpochMs = toEpochMs(event.end_time);
  const durationMinutes =
    startEpochMs !== null && endEpochMs !== null && endEpochMs >= startEpochMs
      ? Math.round((endEpochMs - startEpochMs) / (60 * 1000))
      : null;

  return {
    normalized_name: normalizeToken(event.name),
    normalized_tags: normalizeTagSet(event),
    start_epoch_ms: startEpochMs,
    end_epoch_ms: endEpochMs,
    duration_minutes: durationMinutes,
    is_tbd_time: startEpochMs === null && endEpochMs === null
  };
}

function normalizeRawProjection(event) {
  return {
    source: event.source ?? null,
    publish_at: event.publish_at || null,
    message: event.message || null,
    reserved: event.reserved ?? null,
    recommended_ids: Array.isArray(event.recommended_ids) ? event.recommended_ids : [],
    track_display_name: event.track_display_name || null,
    summit_display_name: event.summit_display_name || null,
    title_only: event.title_only ?? null
  };
}

function normalizeAgentEvent(event, generatedAt) {
  const id = eventId(event);
  const date = event.date || null;
  const venue = normalizeVenue(event);
  const contributors = normalizeContributors(event);
  const sourceUpdatedAt = event.publish_at || null;
  const derived = deriveEventShape(event);

  const baseRecord = {
    event_id: eventId(event),
    id: event.id || null,
    name: event.name || null,
    date,
    start_time: event.start_time || null,
    end_time: event.end_time || null,
    event_type: event.event_type || null,
    format: event.format || null,
    category: event.category || null,
    genre: event.genre || null,
    subgenre: event.subgenre || null,
    track: event.track || null,
    focus_area: event.focus_area || null,
    presented_by: event.presented_by || null,
    reservable: Boolean(event.reservable),
    reservable_id: event.reservable_id || null,
    official_url: officialEventUrl(event),
    venue,
    credentials: normalizeCredentials(event),
    contributors,
    tags: Array.isArray(event.tags) ? event.tags : [],
    hash_tags: Array.isArray(event.hash_tags) ? event.hash_tags : [],
    publish_at: event.publish_at || null,
    status: detectEventStatus(event),
    source_updated_at: sourceUpdatedAt,
    canonical: {
      event_id: id,
      event_page_path: eventPagePath(event),
      event_page_url: absoluteUrl(eventPagePath(event)),
      date_page_path: datePagePath(date || "unknown"),
      date_page_url: absoluteUrl(datePagePath(date || "unknown")),
      official_event_url: officialEventUrl(event),
      venue_id: venue.id ? String(venue.id) : null,
      contributor_entity_ids: contributors
        .map((person) => person.entity_id)
        .filter((value) => value !== null && value !== undefined)
        .map(String)
    },
    provenance: {
      source_system: "sxsw_schedule",
      source_event_id: id,
      source_search_path: `/${YEAR}/search`,
      source_detail_path: `/api/web/${YEAR}/events/${encodeURIComponent(id)}`,
      source_snapshot_at: generatedAt,
      raw_fields: Object.keys(event).sort(),
      raw_record_sha256: hashStable(event)
    },
    raw: normalizeRawProjection(event),
    derived
  };

  const recordSha256 = hashStable(baseRecord);
  return {
    ...baseRecord,
    record_updated_at: sourceUpdatedAt || generatedAt,
    record_version: `${sourceUpdatedAt || generatedAt}:${recordSha256.slice(0, 12)}`,
    record_sha256: recordSha256
  };
}

const SLIM_FIELDS = [
  "event_id", "name", "date", "start_time", "end_time",
  "event_type", "format", "category", "reservable", "official_url",
  "credentials", "status"
];

function slimEvent(event) {
  const slim = {};
  for (const field of SLIM_FIELDS) {
    slim[field] = event[field] ?? null;
  }
  slim.venue = event.venue
    ? { id: event.venue.id ?? null, name: event.venue.name ?? null, lat: event.venue.lat ?? null, lon: event.venue.lon ?? null }
    : null;
  slim.contributors = Array.isArray(event.contributors)
    ? event.contributors.map((c) => ({ name: c.name ?? null, type: c.type ?? null }))
    : [];
  return slim;
}

function buildVenueEntityIndex(agentEvents) {
  const map = new Map();

  for (const event of agentEvents) {
    const venue = event.venue || {};
    if (!venue.name && !venue.id) {
      continue;
    }
    const key =
      venue.id !== null && venue.id !== undefined
        ? `id:${venue.id}`
        : `fallback:${normalizeToken(venue.name)}|${normalizeToken(venue.address)}`;
    if (!map.has(key)) {
      map.set(key, {
        canonical_id:
          venue.id !== null && venue.id !== undefined
            ? `venue:${venue.id}`
            : `venue:anon:${hashStable({ name: venue.name || "", address: venue.address || "" }).slice(0, 12)}`,
        venue_id: venue.id !== null && venue.id !== undefined ? String(venue.id) : null,
        name: venue.name || null,
        root: venue.root || null,
        address: venue.address || null,
        city: venue.city || null,
        state: venue.state || null,
        postal_code: venue.postal_code || null,
        lat: venue.lat ?? null,
        lon: venue.lon ?? null,
        event_ids: []
      });
    }
    map.get(key).event_ids.push(event.event_id);
  }

  return Array.from(map.values())
    .map((venue) => ({
      ...venue,
      event_ids: Array.from(new Set(venue.event_ids)).sort(),
      event_count: Array.from(new Set(venue.event_ids)).length
    }))
    .sort((a, b) => a.canonical_id.localeCompare(b.canonical_id));
}

function buildContributorEntityIndex(agentEvents) {
  const map = new Map();

  for (const event of agentEvents) {
    for (const contributor of event.contributors || []) {
      const key =
        contributor.entity_id !== null && contributor.entity_id !== undefined
          ? `entity:${contributor.entity_id}`
          : contributor.id !== null && contributor.id !== undefined
            ? `id:${contributor.id}`
            : `fallback:${normalizeToken(contributor.name)}|${normalizeToken(contributor.type)}`;

      if (!map.has(key)) {
        const canonicalSource =
          contributor.entity_id ?? contributor.id ?? `${normalizeToken(contributor.name)}|${normalizeToken(contributor.type)}`;
        map.set(key, {
          canonical_id: `contributor:${String(canonicalSource)}`,
          entity_id:
            contributor.entity_id !== null && contributor.entity_id !== undefined
              ? String(contributor.entity_id)
              : null,
          id:
            contributor.id !== null && contributor.id !== undefined
              ? String(contributor.id)
              : null,
          name: contributor.name || null,
          type: contributor.type || null,
          event_ids: []
        });
      }
      map.get(key).event_ids.push(event.event_id);
    }
  }

  return Array.from(map.values())
    .map((contributor) => ({
      ...contributor,
      event_ids: Array.from(new Set(contributor.event_ids)).sort(),
      event_count: Array.from(new Set(contributor.event_ids)).length
    }))
    .sort((a, b) => a.canonical_id.localeCompare(b.canonical_id));
}

function renderSiteCss() {
  return `:root {
  --bg: #071018;
  --panel: #0d1924;
  --line: #21384b;
  --text: #ecf3fa;
  --muted: #a6b7c8;
  --accent: #7fd2ff;
  --accent-strong: #43beff;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background:
    radial-gradient(1200px 500px at 100% -80px, #11314a 0%, transparent 65%),
    linear-gradient(180deg, #06111a 0%, var(--bg) 100%);
  color: var(--text);
  font-family: "IBM Plex Sans", "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
  line-height: 1.45;
}
a {
  color: var(--accent);
  text-underline-offset: 2px;
}
a:hover {
  color: var(--accent-strong);
}
main {
  max-width: 1100px;
  margin: 0 auto;
  padding: 28px 16px 40px;
}
h1, h2, h3 {
  margin: 0 0 10px;
  line-height: 1.2;
}
p, li, td, th {
  color: var(--muted);
}
code, pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}
.hero {
  border: 1px solid var(--line);
  background: #0c1822;
  border-radius: 14px;
  padding: 18px;
}
.panel {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 12px;
  padding: 14px;
  margin-top: 14px;
}
.button {
  display: inline-block;
  border: 1px solid #2d516b;
  border-radius: 999px;
  padding: 8px 14px;
  text-decoration: none;
  color: var(--text);
  background: #12324b;
  font-weight: 600;
}
.button:hover {
  background: #174468;
}
.grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}
.card {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px;
  background: #0a161f;
}
.meta {
  font-size: 0.92rem;
  color: var(--muted);
}
.meta strong {
  color: var(--text);
}
table {
  width: 100%;
  border-collapse: collapse;
  min-width: 860px;
}
th, td {
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
  padding: 9px 8px;
  font-size: 0.95rem;
}
th {
  color: var(--text);
  font-weight: 600;
}
.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}
.breadcrumbs {
  margin: 0 0 10px;
  font-size: 0.9rem;
}
.small {
  font-size: 0.88rem;
}
details pre {
  white-space: pre-wrap;
  word-break: break-word;
  background: #09131a;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px;
  color: #e8eef5;
}
ul.flat {
  margin: 8px 0 0 16px;
  padding: 0;
}
.site-footer {
  margin-top: 18px;
  font-size: 0.88rem;
  color: var(--muted);
}
`;
}

function renderShell({ title, description, body, jsonLd = null, pagePath = "/" }) {
  const jsonLdText = jsonLd
    ? JSON.stringify(jsonLd).replace(/</g, "\\u003c")
    : "";
  const canonical = absoluteUrl(pagePath);
  const ogImage = absoluteUrl("/schedule/og-default.svg");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  <meta property="og:image" content="${escapeHtml(ogImage)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(ogImage)}">
  <link rel="stylesheet" href="/schedule/styles.css">
</head>
<body>
  <main>${body}</main>
  <footer class="site-footer">
    <p>Source code: <a href="${escapeHtml(REPOSITORY_URL)}">GitHub repository</a></p>
  </footer>
  ${jsonLd ? `<script type="application/ld+json">${jsonLdText}</script>` : ""}
</body>
</html>`;
}

function renderLandingPage(manifest, dateSummaries) {
  const base = absoluteUrl("/");
  const year = manifest.festival_year;

  const cards = dateSummaries
    .map(
      (day) => `<article class="card">
  <h3><a href="${day.page_path}">${escapeHtml(day.label)}</a></h3>
  <p class="meta"><strong>${day.event_count}</strong> events</p>
</article>`
    )
    .join("");

  const nonBreaking = (manifest.compatibility?.policy?.non_breaking_changes || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const breaking = (manifest.compatibility?.policy?.breaking_changes || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");

  return renderShell({
    title: `SXSW ${year} Schedule for Agents`,
    description: `SXSW ${year} schedule for agents: human-browsable pages and agent-ready API from official source data.`,
    body: `<section class="hero">
  <h1>SXSW ${year} Schedule for Agents</h1>
  <p>Human-browsable schedule with a query API for AI agents and chatbots. Built for people, LLMs, and automation workflows.</p>
  <p class="meta"><strong>Freshness:</strong> ${escapeHtml(manifest.freshness?.data_staleness?.status || "unknown")} | Source snapshot: ${escapeHtml(manifest.freshness?.source_snapshot_at || "n/a")} | Next refresh: ${escapeHtml(manifest.freshness?.expected_next_refresh_by || "n/a")}</p>
  <p class="meta">Events: <strong>${manifest.stats.event_count}</strong> | Generated: ${escapeHtml(manifest.generated_at)}</p>
  <p><a class="button" href="/schedule/index.html">Browse Full Schedule</a></p>
</section>

<section class="panel">
  <h2>Try These Prompts — For Humans</h2>
  <p class="small">Paste into Claude, ChatGPT, Gemini, or any AI that can browse the web. No setup needed.</p>

  <h3>Build a personal schedule</h3>
  <p><button class="button copy-prompt" type="button" data-target="prompt-h1">Copy</button></p>
  <pre id="prompt-h1">Use ${escapeHtml(base)} as the source for the SXSW ${year} schedule.

I'm interested in AI, startups, and music technology. Build me a personal schedule for the full festival — pick the best 2–3 sessions per day that match my interests, avoid time conflicts, and include the venue and official link for each one.</pre>

  <h3>Explore a topic</h3>
  <p><button class="button copy-prompt" type="button" data-target="prompt-h2">Copy</button></p>
  <pre id="prompt-h2">Using the SXSW ${year} schedule at ${escapeHtml(base)}, find all sessions about climate tech and sustainability. List them with date, time, venue, and a link. Group by day.</pre>

  <h3>Look up a speaker</h3>
  <p><button class="button copy-prompt" type="button" data-target="prompt-h3">Copy</button></p>
  <pre id="prompt-h3">Using the SXSW ${year} schedule at ${escapeHtml(base)}, find all sessions featuring [speaker name]. Show the date, time, session name, venue, and official link for each.</pre>

  <h3>Plan a single day</h3>
  <p><button class="button copy-prompt" type="button" data-target="prompt-h4">Copy</button></p>
  <pre id="prompt-h4">Using the SXSW ${year} schedule at ${escapeHtml(base)}, plan my Saturday March 14. I like panels and keynotes about AI, product design, or the music industry. Suggest a realistic schedule with no overlaps — include times, venues, and links.</pre>

  <h3>Find something to do tonight</h3>
  <p><button class="button copy-prompt" type="button" data-target="prompt-h5">Copy</button></p>
  <pre id="prompt-h5">Using the SXSW ${year} schedule at ${escapeHtml(base)}, what are the best music showcases and parties happening on Friday March 13? I prefer indie rock and electronic. List options with venue, start time, and a link.</pre>
</section>

<section class="panel">
  <h2>Try These Prompts — For Agents &amp; Developers</h2>
  <p class="small">Structured prompts that tell the AI exactly how to call the API. Useful for coding agents, n8n, Make, or any tool-use workflow.</p>

  <h3>Personal schedule from interests</h3>
  <p><button class="button copy-prompt" type="button" data-target="prompt-a1">Copy</button></p>
  <pre id="prompt-a1">You are a SXSW ${year} schedule assistant. Use the API at ${escapeHtml(base)}api/.

Step 1: Fetch ${escapeHtml(base)}api/dates to get all festival days.
Step 2: For each day, fetch ${escapeHtml(base)}api/events?date={date}&q=AI+startups&q_mode=any&limit=50
Step 3: Pick the top 3 sessions per day based on relevance to AI and startups. Avoid overlapping times.
Step 4: Return a schedule grouped by day. For each session include: name, start_time, end_time, venue, official_url.</pre>

  <h3>Topic search across all days</h3>
  <p><button class="button copy-prompt" type="button" data-target="prompt-a2">Copy</button></p>
  <pre id="prompt-a2">Fetch ${escapeHtml(base)}api/events?q=climate+tech&q_mode=any&limit=200
Return all results as a table: date, start_time, name, venue, official_url. Sort by date then start_time.</pre>

  <h3>Speaker session lookup</h3>
  <p><button class="button copy-prompt" type="button" data-target="prompt-a3">Copy</button></p>
  <pre id="prompt-a3">Fetch ${escapeHtml(base)}api/contributors?name=Carmen+Simon
For each matching contributor, note their sessions. Then fetch ${escapeHtml(base)}api/events?contributor=Carmen+Simon
Return: date, start_time, session name, venue, official_url.</pre>

  <h3>Daily shortlist (single API call)</h3>
  <p><button class="button copy-prompt" type="button" data-target="prompt-a4">Copy</button></p>
  <pre id="prompt-a4">Fetch ${escapeHtml(base)}api/shortlist?topic=ai-developer-tooling&per_day=5
Return the results as a schedule grouped by day. For each session include name, time, venue, and official_url.</pre>

  <h3>Venue schedule</h3>
  <p><button class="button copy-prompt" type="button" data-target="prompt-a5">Copy</button></p>
  <pre id="prompt-a5">Fetch ${escapeHtml(base)}api/events?venue=Hilton&limit=200
Return all sessions at venues matching "Hilton", grouped by date. Include start_time, session name, and official_url.</pre>
</section>

<section class="panel">
  <h2>By Day</h2>
  <div class="grid">${cards}</div>
</section>

<section class="panel">
  <h2>API Reference</h2>
  <p>All endpoints return JSON under 10 KB, CORS-enabled. No bulk downloads.</p>
  <ul class="flat">
    <li><a href="/api/openapi.json"><code>/api/openapi.json</code></a> — OpenAPI spec (import into ChatGPT, Claude, LangChain)</li>
    <li><code>${escapeHtml(base)}api/shortlist?topic=ai-developer-tooling&amp;per_day=5</code> — ranked daily shortlist</li>
    <li><code>${escapeHtml(base)}api/events?date=2026-03-14&amp;q=AI&amp;q_mode=any&amp;limit=200</code> — topic search on a day</li>
    <li><code>${escapeHtml(base)}api/events?venue=Hilton&amp;type=panel</code> — venue + format filter</li>
    <li><code>${escapeHtml(base)}api/events?contributor=Carmen+Simon</code> — sessions by speaker</li>
    <li><code>${escapeHtml(base)}api/events/PP1162244</code> — single event by ID</li>
    <li><a href="/api/dates"><code>/api/dates</code></a> — festival dates with event counts</li>
    <li><a href="/api/venues"><code>/api/venues</code></a> — venue lookup</li>
    <li><a href="/api/categories"><code>/api/categories</code></a> — format labels (Panel, Rock, Mentor Session…)</li>
    <li><a href="/api/contributors"><code>/api/contributors</code></a> — speaker/artist search</li>
    <li><a href="/api/health"><code>/api/health</code></a> — health + current index timestamp</li>
  </ul>
  <p class="small">Note: <code>category</code> is a format label, not a topic. Use <code>q=</code> with <code>q_mode=</code> for topic search. If a strict query returns zero results, retry with <code>q_mode=any</code>.</p>
</section>

<section class="panel">
  <h2>FAQ</h2>

  <h3>What is this website?</h3>
  <p>A static SXSW ${year} schedule mirror designed for both humans and AI agents. Data is sourced daily from the official SXSW schedule.</p>

  <h3>Where should agents start?</h3>
  <p>Fetch <a href="/api/openapi.json"><code>/api/openapi.json</code></a> if your framework supports OpenAPI, or call <code>/api/shortlist?topic=…&amp;per_day=5</code> for a one-call ranked daily shortlist. See <a href="/agents.json"><code>/agents.json</code></a> for the full endpoint contract.</p>

  <h3>How do I check freshness?</h3>
  <p>Fetch <a href="/api/health"><code>/api/health</code></a> for the current index timestamp, or check <code>freshness</code> fields in <a href="/schedule.manifest.json"><code>/schedule.manifest.json</code></a>.</p>

  <h3>Can I use this with Claude, ChatGPT, or Gemini?</h3>
  <p>Yes — copy any prompt above and paste it into any AI chat. The AI will query the schedule API automatically.</p>

  <h3>What badge types are in the data?</h3>
  <p>The <code>credentials</code> field lists required badge types: platinum, music, film, interactive, etc. Filter by this field if you only want sessions accessible with a specific badge.</p>
</section>

<section class="panel">
  <h2>Schema Stability</h2>
  <p class="meta">Schema: ${escapeHtml(manifest.compatibility?.schema_semver || "n/a")} | Interface: ${escapeHtml(manifest.compatibility?.interface_semver || "n/a")}</p>
  <h3>Non-Breaking Changes (deployed without notice)</h3>
  <ul class="flat">${nonBreaking || "<li>See schedule.manifest.json for current policy.</li>"}</ul>
  <h3>Breaking Changes (require version bump)</h3>
  <ul class="flat">${breaking || "<li>See schedule.manifest.json for current policy.</li>"}</ul>
  <p>Before relying on this API in production, read <a href="/schedule.manifest.json"><code>/schedule.manifest.json</code></a> and check <code>schema_version</code> and <code>agent_interface.version</code>.</p>
</section>

<section class="panel">
  <h2>Machine Access</h2>
  <ul class="flat">
    <li><a href="/agents.json"><code>/agents.json</code></a> — machine-readable API contract</li>
    <li><a href="/llms.txt"><code>/llms.txt</code></a> — LLM guide (llms.txt standard)</li>
    <li><a href="/schedule.manifest.json"><code>/schedule.manifest.json</code></a> — freshness &amp; metadata</li>
    <li><a href="/schema.json"><code>/schema.json</code></a> — field inventory with sample event</li>
  </ul>
</section>
<script>
(function() {
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return Promise.resolve();
  }
  document.querySelectorAll('.copy-prompt').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var target = document.getElementById(btn.getAttribute('data-target'));
      if (!target) return;
      copyText(target.textContent || '');
    });
  });
})();
</script>`,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Dataset",
      name: `SXSW ${year} Schedule`,
      description: "Browsable SXSW schedule with a query API for AI agents and chatbots.",
      distribution: [
        { "@type": "DataDownload", contentUrl: absoluteUrl("/schedule.manifest.json") }
      ]
    },
    pagePath: "/"
  });
}

function renderScheduleIndexPage(manifest, dateSummaries) {
  const cards = dateSummaries
    .map(
      (day) => `<article class="card">
  <h3><a href="${day.page_path}">${escapeHtml(day.label)}</a></h3>
  <p class="meta"><strong>${day.event_count}</strong> events</p>
</article>`
    )
    .join("");

  return renderShell({
    title: `SXSW ${manifest.festival_year} Schedule by Day`,
    description: `Browse SXSW ${manifest.festival_year} schedule by date.`,
    body: `<p class="breadcrumbs"><a href="/index.html">Home</a></p>
<section class="hero">
  <h1>SXSW ${manifest.festival_year} Schedule by Day</h1>
  <p>Choose a day to view all sessions with times, venue, and detail pages.</p>
</section>
<section class="panel">
  <div class="grid">${cards}</div>
</section>`,
    pagePath: "/schedule/"
  });
}

function renderDatePage(manifest, day, events) {
  // Collect unique formats, venues, categories, and tags for filter dropdowns
  const formats = [...new Set(events.map((e) => e.format || e.event_type || "").filter(Boolean))].sort();
  const venues = [...new Set(events.map((e) => venueLabel(e)).filter(Boolean))].sort();
  const categories = [...new Set(events.map((e) => e.category || "").filter(Boolean))].sort();
  const tags = [...new Set(events.flatMap((e) => [...(Array.isArray(e.tags) ? e.tags : []), ...(Array.isArray(e.hash_tags) ? e.hash_tags : [])]).filter(Boolean))].sort();

  const formatOptions = formats.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("");
  const venueOptions = venues.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  const categoryOptions = categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  const tagOptions = tags.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");

  const filterBar = `<div class="filter-bar" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;align-items:center;">
  <input id="filter-text" type="search" placeholder="Search sessions…" aria-label="Filter sessions by name" style="flex:1;min-width:180px;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);font-size:0.95rem;">
  <select id="filter-format" aria-label="Filter by format" style="padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);font-size:0.95rem;">
    <option value="">All formats</option>${formatOptions}
  </select>
  <select id="filter-venue" aria-label="Filter by venue" style="padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);font-size:0.95rem;">
    <option value="">All venues</option>${venueOptions}
  </select>
  <select id="filter-category" aria-label="Filter by category" style="padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);font-size:0.95rem;">
    <option value="">All categories</option>${categoryOptions}
  </select>
  <select id="filter-tag" aria-label="Filter by tag" style="padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);font-size:0.95rem;">
    <option value="">All tags</option>${tagOptions}
  </select>
  <span id="filter-count" class="meta" style="white-space:nowrap;" aria-live="polite">${day.event_count} events</span>
</div>
<script>
(function() {
  var textEl = document.getElementById('filter-text');
  var formatEl = document.getElementById('filter-format');
  var venueEl = document.getElementById('filter-venue');
  var categoryEl = document.getElementById('filter-category');
  var tagEl = document.getElementById('filter-tag');
  var countEl = document.getElementById('filter-count');
  var tbody = document.getElementById('event-tbody');
  function applyFilter() {
    var text = textEl.value.toLowerCase().trim();
    var format = formatEl.value.toLowerCase();
    var venue = venueEl.value.toLowerCase();
    var category = categoryEl.value.toLowerCase();
    var tag = tagEl.value.toLowerCase();
    var rows = tbody.querySelectorAll('tr');
    var visible = 0;
    rows.forEach(function(row) {
      var rowText = row.dataset.name || '';
      var rowFormat = row.dataset.format || '';
      var rowVenue = row.dataset.venue || '';
      var rowCategory = row.dataset.category || '';
      var rowTags = row.dataset.tags || '';
      var show = (!text || rowText.includes(text))
        && (!format || rowFormat === format)
        && (!venue || rowVenue === venue)
        && (!category || rowCategory === category)
        && (!tag || rowTags.includes('|'+tag+'|'));
      row.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    countEl.textContent = visible + ' event' + (visible === 1 ? '' : 's');
  }
  textEl.addEventListener('input', applyFilter);
  formatEl.addEventListener('change', applyFilter);
  venueEl.addEventListener('change', applyFilter);
  categoryEl.addEventListener('change', applyFilter);
  tagEl.addEventListener('change', applyFilter);
})();
</script>`;

  const rowsWithData = events
    .map((event) => {
      const pagePath = eventPagePath(event);
      const rowFormat = escapeHtml((event.format || event.event_type || "").toLowerCase());
      const rowVenue = escapeHtml(venueLabel(event).toLowerCase());
      const rowName = escapeHtml((event.name || "").toLowerCase());
      const rowCategory = escapeHtml((event.category || "").toLowerCase());
      const rowTags = `|${[...(Array.isArray(event.tags) ? event.tags : []), ...(Array.isArray(event.hash_tags) ? event.hash_tags : [])].map((t) => String(t).toLowerCase()).join("|")}|`;
      return `<tr data-name="${rowName}" data-format="${rowFormat}" data-venue="${rowVenue}" data-category="${rowCategory}" data-tags="${escapeHtml(rowTags)}">
  <td class="mono">${escapeHtml(formatTimeRange(event))}</td>
  <td>
    <a href="${pagePath}">${escapeHtml(event.name || "(Untitled)")}</a>
    <div class="small mono">ID: ${escapeHtml(eventId(event))}</div>
  </td>
  <td>${escapeHtml(event.format || event.event_type || "n/a")}</td>
  <td>${escapeHtml(venueLabel(event))}</td>
  <td><a href="${escapeHtml(officialEventUrl(event))}" target="_blank" rel="noopener noreferrer">Official</a></td>
</tr>`;
    })
    .join("");

  return renderShell({
    title: `${day.label} | SXSW ${manifest.festival_year} Schedule`,
    description: `SXSW ${manifest.festival_year} events for ${day.label}.`,
    body: `<p class="breadcrumbs"><a href="/index.html">Home</a> / <a href="/schedule/index.html">Schedule</a></p>
<section class="hero">
  <h1>${escapeHtml(day.label)}</h1>
  <p class="meta">Events: ${day.event_count}</p>
</section>
<section class="panel">
  ${filterBar}
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Session</th>
          <th>Format</th>
          <th>Venue</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody id="event-tbody">${rowsWithData}</tbody>
    </table>
  </div>
</section>`,
    pagePath: day.page_path
  });
}

function renderEventPage(manifest, event) {
  const id = eventId(event);
  const date = typeof event.date === "string" && event.date.length > 0 ? event.date : "unknown";
  const contributorItems = Array.isArray(event.contributors)
    ? event.contributors
        .map((person) => `<li>${escapeHtml(person?.name || "Unnamed Contributor")}</li>`)
        .join("")
    : "";
  const hasContributors = contributorItems.length > 0;
  const description = event.long_description || event.description || "No description provided.";
  const compactEvent = JSON.parse(JSON.stringify(event));
  if (Array.isArray(compactEvent?.venue?.events)) {
    compactEvent.venue.events = `[omitted ${compactEvent.venue.events.length} venue events]`;
  }
  if (Array.isArray(compactEvent?.related_sales_client?.events)) {
    compactEvent.related_sales_client.events = `[omitted ${compactEvent.related_sales_client.events.length} related events]`;
  }
  const rawJson = escapeHtml(JSON.stringify(compactEvent, null, 2));

  return renderShell({
    title: `${event.name || id} | SXSW ${manifest.festival_year}`,
    description: `Event detail page for ${event.name || id}.`,
    body: `<p class="breadcrumbs"><a href="/index.html">Home</a> / <a href="/schedule/index.html">Schedule</a> / <a href="${datePagePath(
      date
    )}">${escapeHtml(formatDateLabel(date))}</a></p>
<section class="hero">
  <h1>${escapeHtml(event.name || "(Untitled)")}</h1>
  <p class="meta mono">Event ID: ${escapeHtml(id)}</p>
  <p class="meta">${escapeHtml(formatDateLabel(date))} | ${escapeHtml(formatTimeRange(event))}</p>
  <p class="meta">Venue: ${escapeHtml(venueLabel(event))}</p>
  <p><a class="button" href="${escapeHtml(officialEventUrl(event))}" target="_blank" rel="noopener noreferrer">View on Official SXSW</a></p>
</section>
<section class="panel">
  <h2>Summary</h2>
  <p>${escapeHtml(description)}</p>
  <ul class="flat">
    <li><strong>Format:</strong> ${escapeHtml(event.format || "n/a")}</li>
    <li><strong>Category:</strong> ${escapeHtml(event.category || "n/a")}</li>
    <li><strong>Event Type:</strong> ${escapeHtml(event.event_type || "n/a")}</li>
    <li><strong>Presented By:</strong> ${escapeHtml(event.presented_by || "n/a")}</li>
  </ul>
</section>
${
  hasContributors
    ? `<section class="panel"><h2>Contributors</h2><ul class="flat">${contributorItems}</ul></section>`
    : ""
}
<section class="panel">
  <h2>Raw Event JSON</h2>
  <p class="small">Large nested arrays are compacted for page readability. Full payload remains in dataset files.</p>
  <details>
    <summary>Open JSON payload</summary>
    <pre>${rawJson}</pre>
  </details>
</section>`,
    pagePath: eventPagePath(event)
  });
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderSitemapXml(paths, generatedAtIso) {
  const lastmod = generatedAtIso.slice(0, 10);
  const urls = paths
    .map((path) => {
      const loc = xmlEscape(absoluteUrl(path));
      return `<url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`;
}

function renderRobotsTxt() {
  return `# SXSW ${YEAR} Agent-First Schedule — robots.txt
# Agent and AI crawlers are explicitly welcomed to all data feeds.
# See /llms.txt for LLM-specific guidance.
# See /agents.json for the machine-readable ingestion contract.

User-agent: *
Allow: /

# AI / LLM crawlers — full access to structured data feeds
User-agent: GPTBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: cohere-ai
Allow: /

Sitemap: ${absoluteUrl("/sitemap.xml")}
`;
}

function renderLlmsTxt(manifest) {
  return `# SXSW ${manifest.festival_year} Agent-First Schedule

> ${manifest.stats.event_count} events across March 12–18, ${manifest.festival_year}. Sourced daily from schedule.sxsw.com.

## Query API (Use This)

A search API returns filtered results in <10 KB. No bulk downloads.

- [OpenAPI spec](${absoluteUrl("/api/openapi.json")}) — import into ChatGPT, Claude, LangChain, or any OpenAPI-aware agent
- \`${absoluteUrl("/api/shortlist?topic=ai-developer-tooling&per_day=5")}\` — one-call daily shortlist for agentic search
- \`${absoluteUrl("/api/events?date=2026-03-14&q=AI&q_mode=any&limit=200")}\` — broad topic search on a specific day
- \`${absoluteUrl("/api/events?date=2026-03-14&q=AI+developer+tooling&q_mode=all&limit=200")}\` — strict all-term matching
- \`${absoluteUrl("/api/events?venue=Hilton&type=panel")}\` — venue + format filter
- \`${absoluteUrl("/api/events?contributor=Carmen+Simon")}\` — find sessions by speaker/artist
- \`${absoluteUrl("/api/events/PP1162244")}\` — single event by ID
- \`${absoluteUrl("/api/dates")}\` — festival dates with event counts
- \`${absoluteUrl("/api/venues?name=Hilton")}\` — venue lookup
- \`${absoluteUrl("/api/categories")}\` — all categories (format labels: Panel, Rock, Mentor Session, etc.)
- \`${absoluteUrl("/api/contributors?name=Simon")}\` — speaker/artist search
- \`${absoluteUrl("/api/health")}\` — health + current index timestamp

Note: \`category\` is a format label (Panel, Rock, Mentor Session…), not a topic. Use \`q=\` with \`q_mode=\` for topic search. If a strict query returns zero, retry with \`q=AI&q_mode=any\`.

All API responses are JSON, CORS-enabled, always <10 KB.

## Reference Files

- [agents.json](/agents.json) — machine-readable contract with all endpoints
- [schedule.manifest.json](/schedule.manifest.json) — freshness metadata
- [schema.json](/schema.json) — field inventory with sample event

## Data Freshness

Last built: ${manifest.generated_at}
Source snapshot: ${manifest.freshness?.source_snapshot_at || manifest.generated_at}
Expected next refresh: ${manifest.freshness?.expected_next_refresh_by || manifest.generated_at}

## Key Fields

- \`event_id\` — primary identifier
- \`event_type\` — panel, showcase, screening, networking, party, activation, exhibition, comedy_event, lounge, special_event, registration
- \`contributors\` — speakers, artists, performers (name + type)
- \`credentials\` — badge types required (platinum, music, film, interactive, etc.)
- \`reservable\` — true if RSVP required via SXSW app
- \`venue.lat\` / \`venue.lon\` — coordinates for geospatial filtering
- Timestamps are America/Chicago (UTC-5 during festival)

## Fetching Notes

- **Use the API** — /api/events with query params returns only what you need, always parses cleanly
- Do not route requests through reader proxies (r.jina.ai etc.) — they wrap JSON in markdown and break parsing
- All endpoints return \`Content-Type: application/json\` or \`application/x-ndjson\` — never HTML
- If you receive HTML, you hit a proxy or a 404. Retry the raw URL directly.
`;
}

function toIsoDayRange(events) {
  const starts = events.map((event) => event.start_time).filter(Boolean).sort();
  const ends = events.map((event) => event.end_time).filter(Boolean).sort();

  return {
    start: starts[0] || null,
    end: ends[ends.length - 1] || null
  };
}

function stripRecordSignature(event) {
  const cloned = { ...event };
  delete cloned.record_version;
  delete cloned.record_sha256;
  delete cloned.record_updated_at;
  return cloned;
}

async function readPreviousBuildState() {
  let previousGeneratedAt = null;
  let previousInterfaceVersion = null;
  let baselineResetReason = null;
  const previousEventsById = new Map();

  try {
    const { readFile } = await import("node:fs/promises");
    const manifestRaw = await readFile(`${OUTPUT_DIR}/schedule.manifest.json`, "utf8").catch(() => null);
    if (manifestRaw) {
      const parsedManifest = JSON.parse(manifestRaw);
      previousGeneratedAt = parsedManifest?.generated_at || null;
      previousInterfaceVersion = parsedManifest?.agent_interface?.version || null;
    }

    const ndjsonRaw = await readFile(`${OUTPUT_DIR}/agent-schedule.v1.ndjson`, "utf8").catch(() => null);
    if (ndjsonRaw) {
      for (const line of ndjsonRaw.split("\n").filter(Boolean)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed?.event_id) {
            previousEventsById.set(parsed.event_id, parsed);
          }
        } catch {
          // Ignore malformed historical lines.
        }
      }
    }
  } catch {
    // No previous state is a valid first-run case.
  }

  if (previousInterfaceVersion && previousInterfaceVersion !== INTERFACE_VERSION) {
    baselineResetReason = `Interface changed from ${previousInterfaceVersion} to ${INTERFACE_VERSION}; baseline reset.`;
    return {
      previousGeneratedAt: null,
      previousInterfaceVersion,
      baselineResetReason,
      previousEventsById: new Map()
    };
  }

  return { previousGeneratedAt, previousInterfaceVersion, baselineResetReason, previousEventsById };
}

function buildChangeRecords(currentEvents, previousEventsById, generatedAt, baselineGeneratedAt) {
  const currentById = new Map(currentEvents.map((event) => [event.event_id, event]));
  const records = [];

  for (const [eventIdValue, current] of currentById.entries()) {
    const previous = previousEventsById.get(eventIdValue);
    if (!previous) {
      records.push({
        record_type: "change",
        change_type: "added",
        detected_at: generatedAt,
        baseline_generated_at: baselineGeneratedAt,
        event_id: eventIdValue,
        name: current.name,
        date: current.date,
        status: current.status,
        record_version: current.record_version,
        record_sha256: current.record_sha256,
        previous_record_version: null,
        previous_record_sha256: null,
        tombstone: false,
        canonical_event_url: current.canonical?.event_page_url || absoluteUrl(eventPagePath({ event_id: eventIdValue }))
      });
      continue;
    }

    const previousHash = previous.record_sha256 || hashStable(stripRecordSignature(previous));
    const currentHash = current.record_sha256 || hashStable(stripRecordSignature(current));
    const previousStatus = previous.status || "active";
    const currentStatus = current.status || "active";

    let changeType = null;
    let tombstone = false;
    if (previousStatus !== currentStatus && currentStatus === "cancelled") {
      changeType = "cancelled";
      tombstone = true;
    } else if (previousStatus !== currentStatus && currentStatus === "active") {
      changeType = "uncancelled";
    } else if (previousHash !== currentHash) {
      changeType = "modified";
    }

    if (changeType) {
      records.push({
        record_type: "change",
        change_type: changeType,
        detected_at: generatedAt,
        baseline_generated_at: baselineGeneratedAt,
        event_id: eventIdValue,
        name: current.name,
        date: current.date,
        status: current.status,
        record_version: current.record_version,
        record_sha256: current.record_sha256,
        previous_record_version: previous.record_version || null,
        previous_record_sha256: previousHash,
        tombstone,
        canonical_event_url: current.canonical?.event_page_url || absoluteUrl(eventPagePath({ event_id: eventIdValue }))
      });
    }
  }

  for (const [eventIdValue, previous] of previousEventsById.entries()) {
    if (currentById.has(eventIdValue)) {
      continue;
    }
    records.push({
      record_type: "change",
      change_type: "removed",
      detected_at: generatedAt,
      baseline_generated_at: baselineGeneratedAt,
      event_id: eventIdValue,
      name: previous.name || null,
      date: previous.date || null,
      status: "removed",
      record_version: null,
      record_sha256: null,
      previous_record_version: previous.record_version || null,
      previous_record_sha256:
        previous.record_sha256 || hashStable(stripRecordSignature(previous)),
      tombstone: true,
      canonical_event_url:
        previous.canonical?.event_page_url ||
        absoluteUrl(eventPagePath({ event_id: eventIdValue }))
    });
  }

  records.sort((a, b) => {
    const byId = String(a.event_id).localeCompare(String(b.event_id));
    if (byId !== 0) {
      return byId;
    }
    return String(a.change_type).localeCompare(String(b.change_type));
  });

  const counts = {
    added: records.filter((record) => record.change_type === "added").length,
    modified: records.filter((record) => record.change_type === "modified").length,
    removed: records.filter((record) => record.change_type === "removed").length,
    cancelled: records.filter((record) => record.change_type === "cancelled").length,
    uncancelled: records.filter((record) => record.change_type === "uncancelled").length
  };

  const metadata = {
    record_type: "metadata",
    generated_at: generatedAt,
    baseline_generated_at: baselineGeneratedAt,
    festival_year: YEAR,
    total_changes: records.length,
    ...counts,
    tombstone_count: records.filter((record) => record.tombstone).length,
    note:
      previousEventsById.size === 0
        ? "No previous build found; this is the first snapshot baseline."
        : "Diff against previous published snapshot."
  };

  return { metadata, records, counts };
}

function buildCompatibilityPolicy() {
  return {
    schema_semver: SCHEMA_VERSION,
    interface_semver: INTERFACE_VERSION,
    policy: {
      non_breaking_changes: [
        "Adding nullable fields",
        "Adding enum variants",
        "Adding new feed files",
        "Adding new manifest metadata keys"
      ],
      breaking_changes: [
        "Removing or renaming existing fields",
        "Changing field types",
        "Changing primary identifiers",
        "Changing route templates"
      ]
    }
  };
}

function buildDateSummaries(groupedByDate) {
  const dateSummaries = [];
  for (const [date, events] of groupedByDate.entries()) {
    const pathDate = dateSlug(date);
    dateSummaries.push({
      date,
      slug: pathDate,
      label: formatDateLabel(date),
      event_count: events.length,
      page_path: datePagePath(date)
    });
  }
  return dateSummaries;
}

async function loadPublishedSnapshotForSiteBuild() {
  const manifestPath = `${OUTPUT_DIR}/schedule.manifest.json`;
  const fullPath = `${OUTPUT_DIR}/schedule.json.gz`;

  const [manifestRaw, fullRaw] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(fullPath)
  ]);

  const manifest = JSON.parse(manifestRaw);
  const full = JSON.parse(gunzipSync(fullRaw).toString("utf8"));
  const detailedEvents = Array.isArray(full.events) ? full.events.slice().sort(byStartTime) : [];
  const groupedByDate = groupByDate(detailedEvents);
  const dateSummaries = buildDateSummaries(groupedByDate);

  return {
    manifest,
    groupedByDate,
    dateSummaries,
    changeRecords: []
  };
}

async function writeSiteArtifacts({ manifest, groupedByDate, dateSummaries, changeRecords, generatedAt }) {

  await rm(`${OUTPUT_DIR}/schedule`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/prompts`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/faq`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/changelog`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/stability`, { recursive: true, force: true });
  await mkdir(`${OUTPUT_DIR}/schedule/date`, { recursive: true });
  await mkdir(`${OUTPUT_DIR}/schedule/event`, { recursive: true });

  const pageWrites = [];

  pageWrites.push({
    path: `${OUTPUT_DIR}/index.html`,
    route: "/",
    content: renderLandingPage(manifest, dateSummaries)
  });

  pageWrites.push({
    path: `${OUTPUT_DIR}/schedule/index.html`,
    route: "/schedule/",
    content: renderScheduleIndexPage(manifest, dateSummaries)
  });

  pageWrites.push({
    path: `${OUTPUT_DIR}/schedule/styles.css`,
    route: null,
    content: renderSiteCss()
  });

  pageWrites.push({
    path: `${OUTPUT_DIR}/schedule/og-default.svg`,
    route: null,
    content:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" role="img" aria-label="SXSW ${YEAR} Schedule for Agents">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0%" stop-color="#0a1a2a"/><stop offset="100%" stop-color="#153c5e"/></linearGradient></defs>` +
      `<rect width="1200" height="630" fill="url(#g)"/>` +
      `<text x="70" y="250" font-family="Arial, Helvetica, sans-serif" font-size="76" fill="#ffffff" font-weight="700">SXSW ${YEAR}</text>` +
      `<text x="70" y="340" font-family="Arial, Helvetica, sans-serif" font-size="52" fill="#cfe9ff" font-weight="600">Schedule for Agents</text>` +
      `<text x="70" y="410" font-family="Arial, Helvetica, sans-serif" font-size="28" fill="#9ac9ee">Agent-first website export</text>` +
      `</svg>`
  });

  for (const day of dateSummaries) {
    const events = groupedByDate.get(day.date) || [];
    pageWrites.push({
      path: `${OUTPUT_DIR}${day.page_path}`,
      route: day.page_path,
      content: renderDatePage(manifest, day, events)
    });

    for (const event of events) {
      pageWrites.push({
        path: `${OUTPUT_DIR}${eventPagePath(event)}`,
        route: eventPagePath(event),
        content: renderEventPage(manifest, event)
      });
    }
  }

  const sitemapPaths = pageWrites
    .map((page) => page.route)
    .filter((route) => typeof route === "string")
    .concat([
      "/agents.json",
      "/schedule.manifest.json",
      "/schema.json",
      "/llms.txt"
    ])
    .sort();

  // Rebuild agents.json with API entrypoints only
  const siteAgentsDescriptor = {
    ...manifest.source_descriptor,
    agent_contract_version: manifest.schema_version || SCHEMA_VERSION,
    generated_at: generatedAt,
    festival_year: manifest.festival_year || YEAR,
    purpose: "Agent-first SXSW schedule feed from official source",
    freshness: manifest.freshness,
    compatibility: manifest.compatibility,
    identity: manifest.identity,
    api: {
      openapi: "/api/openapi.json",
      base_url: "/api",
      endpoints: {
        search_events: "GET /api/events?date=&category=&venue=&type=&contributor=&q=&q_mode=&limit=&offset=",
        get_event:     "GET /api/events/{event_id}",
        shortlist:     "GET /api/shortlist?topic=&per_day=",
        health:        "GET /api/health",
        list_dates:    "GET /api/dates",
        list_venues:   "GET /api/venues?name=",
        list_categories: "GET /api/categories",
        search_contributors: "GET /api/contributors?name="
      },
      param_notes: {
        q: "Tokenized full-text search across name, venue, category, contributors with synonym normalization (e.g. AI, llm, dev).",
        q_mode: "Search mode: any (default), all, phrase. If all returns 0 results, retry with q=AI&q_mode=any.",
        category: "Format label, not a topic (Panel, Rock, Mentor Session, Presentation…). Use /api/categories for valid values.",
        type: "event_type: panel, showcase, screening, networking, party, activation, exhibition, comedy_event, lounge, special_event, registration",
        contributor: "Partial match on speaker, artist, or performer name"
      },
      example_urls: {
        health: absoluteUrl("/api/health"),
        dates: absoluteUrl("/api/dates"),
        shortlist_ai_developer_tooling: absoluteUrl("/api/shortlist?topic=ai-developer-tooling&per_day=5"),
        events_ai_any: absoluteUrl("/api/events?date=2026-03-14&q=AI&q_mode=any&limit=200"),
        events_ai_dev_tooling_all: absoluteUrl("/api/events?date=2026-03-14&q=AI+developer+tooling&q_mode=all&limit=200")
      },
      note: "Query API returns filtered results <10 KB. No bulk download needed for most queries."
    },
    entrypoints: {
      llms_txt: "/llms.txt",
      website_home: "/index.html",
      schedule_index: "/schedule/index.html",
      robots: "/robots.txt",
      sitemap: "/sitemap.xml",
      manifest: "/schedule.manifest.json",
      schema: "/schema.json"
    },
    recommended_ingestion_order: [
      "Import /api/openapi.json if your framework supports OpenAPI tool discovery",
      "Use /api/shortlist?topic=ai-developer-tooling&per_day=5 for one-call ranked daily shortlists",
      "Query /api/events with date/venue/type/contributor/q params — returns <10 KB",
      "Use /api/dates, /api/venues, /api/categories, /api/contributors for reference data"
    ],
    fetching_tips: [
      "The /api/* endpoints are the only access pattern — small responses, no bulk downloads",
      "Fetch JSON directly — do not route through reader proxies (e.g. r.jina.ai). They wrap responses in markdown and break JSON parsing.",
      "All endpoints return Content-Type: application/json — never HTML",
      "If you receive HTML or a markdown wrapper, you are hitting a proxy or a 404. Retry the raw URL directly."
    ],
    expectations: manifest.expectations,
    source: manifest.source
  };

  await Promise.all([
    writeFile(`${OUTPUT_DIR}/robots.txt`, renderRobotsTxt()),
    writeFile(`${OUTPUT_DIR}/sitemap.xml`, renderSitemapXml(sitemapPaths, generatedAt)),
    writeFile(`${OUTPUT_DIR}/llms.txt`, renderLlmsTxt(manifest)),
    writeFile(`${OUTPUT_DIR}/agents.json`, JSON.stringify(siteAgentsDescriptor, null, 2) + "\n")
  ]);

  await mapWithConcurrency(pageWrites, 32, async (page) => {
    await writeFile(page.path, page.content);
  });

  return pageWrites.length;
}

async function main() {
  if (BUILD_MODE === "site") {
    console.log(`Building website from committed data snapshot (SXSW ${YEAR})...`);
    const { manifest, groupedByDate, dateSummaries, changeRecords } =
      await loadPublishedSnapshotForSiteBuild();
    const pageCount = await writeSiteArtifacts({
      manifest,
      groupedByDate,
      dateSummaries,
      changeRecords,
      generatedAt: manifest.generated_at || new Date().toISOString()
    });
    console.log(`Done. Rebuilt website pages (${pageCount} files) from committed snapshot.`);
    return;
  }

  if (BUILD_MODE !== "refresh") {
    throw new Error(`Unsupported BUILD_MODE="${BUILD_MODE}". Use "site" or "refresh".`);
  }

  console.log(`Building SXSW ${YEAR} export from official schedule source...`);

  const indexData = await fetchEventIndex();
  const hits = Array.isArray(indexData.hits) ? indexData.hits : [];

  const eventIds = Array.from(
    new Set(
      hits
        .map((hit) => hit?._source?.event_id || hit?._id || hit?.favorite_id)
        .filter(Boolean)
    )
  ).sort();

  if (eventIds.length === 0) {
    throw new Error("No event IDs were found in search response");
  }

  console.log(`Collected ${eventIds.length} event IDs from /${YEAR}/search`);
  const { success: detailedEvents, failed: failedEventIds } = await fetchEventDetails(eventIds);

  detailedEvents.sort(byStartTime);

  const fields = collectFieldStats(detailedEvents);
  const dateRange = toIsoDayRange(detailedEvents);
  const generatedAt = new Date().toISOString();
  const groupedByDate = groupByDate(detailedEvents);

  const dateSummaries = [];

  await rm(`${OUTPUT_DIR}/schedule`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/prompts`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/faq`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/changelog`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/stability`, { recursive: true, force: true });
  await mkdir(`${OUTPUT_DIR}/schedule/date`, { recursive: true });
  await mkdir(`${OUTPUT_DIR}/schedule/event`, { recursive: true });

  for (const [date, events] of groupedByDate.entries()) {
    const pathDate = dateSlug(date);
    dateSummaries.push({
      date,
      slug: pathDate,
      label: formatDateLabel(date),
      event_count: events.length,
      page_path: datePagePath(date)
    });
  }

  const sourceSnapshotAt = maxIsoTimestamp(detailedEvents.map((event) => event.publish_at)) || generatedAt;
  const compatibility = buildCompatibilityPolicy();
  const identity = {
    primary_event_id_field: "event_id",
    canonical_templates: {
      event_page_path: "/schedule/event/{event_id}.html",
      date_page_path: "/schedule/date/{date}.html",
      official_event_url: `${BASE_URL}/${YEAR}/events/{event_id}`,
      venue_entity_id: "venue:{venue.id}",
      contributor_entity_id: "contributor:{contributors[].entity_id|contributors[].id}"
    },
    slug_policy: "Non-alphanumeric characters are replaced with underscores."
  };

  const agentEvents = detailedEvents.map((event) => normalizeAgentEvent(event, sourceSnapshotAt));
  const agentSchedule = {
    schema_version: SCHEMA_VERSION,
    interface_version: INTERFACE_VERSION,
    generated_at: generatedAt,
    festival_year: YEAR,
    event_count: agentEvents.length,
    fields: Object.keys(agentEvents[0] || {}),
    events: agentEvents
  };
  const agentNdjson = toNdjson(agentEvents);

  const { previousGeneratedAt, previousEventsById, baselineResetReason } = await readPreviousBuildState();
  const baselineGeneratedAt = previousGeneratedAt || null;
  const { metadata: changesMetadata, records: changeRecords, counts: changeCounts } =
    buildChangeRecords(agentEvents, previousEventsById, generatedAt, baselineGeneratedAt);
  if (baselineResetReason) {
    changesMetadata.note = `${changesMetadata.note} ${baselineResetReason}`;
  }

  const expectedNextRefreshBy = addHours(generatedAt, REFRESH_INTERVAL_HOURS);
  const staleAfter = addHours(generatedAt, STALE_AFTER_HOURS);
  const sourceAgeHours = Math.max(
    0,
    Math.round(((Date.now() - Date.parse(sourceSnapshotAt)) / (60 * 60 * 1000)) * 10) / 10
  );
  const isStale = Date.now() > Date.parse(staleAfter);
  const freshness = {
    refresh_mode: "manual",
    refresh_cadence_target: "daily",
    last_successful_refresh_at: generatedAt,
    source_snapshot_at: sourceSnapshotAt,
    expected_next_refresh_by: expectedNextRefreshBy,
    stale_after: staleAfter,
    data_staleness: {
      is_stale: isStale,
      status: isStale ? "stale" : "fresh",
      source_snapshot_age_hours: sourceAgeHours
    }
  };

  const fullSchedule = {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    festival_year: YEAR,
    source: {
      system: "Official SXSW schedule website",
      base_url: BASE_URL,
      endpoints: [`/${YEAR}/search`, `/api/web/${YEAR}/events/{event_id}`],
      source_snapshot_at: sourceSnapshotAt,
      extraction_notes:
        "Event IDs are discovered from official search index; event records are hydrated from official detail endpoint."
    },
    stats: {
      event_count: detailedEvents.length,
      field_count: fields.length,
      failed_event_ids: failedEventIds,
      date_range: dateRange
    },
    fields,
    events: detailedEvents
  };

  fullSchedule.sha256 = buildHash({
    schema_version: fullSchedule.schema_version,
    generated_at: fullSchedule.generated_at,
    festival_year: fullSchedule.festival_year,
    stats: fullSchedule.stats,
    fields: fullSchedule.fields,
    events: fullSchedule.events
  });

  const manifest = {
    schema_version: fullSchedule.schema_version,
    generated_at: fullSchedule.generated_at,
    festival_year: fullSchedule.festival_year,
    source: fullSchedule.source,
    freshness,
    compatibility,
    identity,
    stats: fullSchedule.stats,
    fields: fullSchedule.fields,
    changes: {
      generated_at: generatedAt,
      baseline_generated_at: baselineGeneratedAt,
      total: changesMetadata.total_changes,
      ...changeCounts
    },
    website: {
      home: "/index.html",
      schedule_index: "/schedule/index.html",
      date_pages: "/schedule/date/{date}.html",
      event_pages: "/schedule/event/{event_id}.html"
    }
  };

  const agentsDescriptor = {
    agent_contract_version: SCHEMA_VERSION,
    generated_at: manifest.generated_at,
    festival_year: manifest.festival_year,
    purpose: "Agent-first SXSW schedule feed from official source",
    freshness,
    compatibility,
    identity,
    api: {
      openapi: "/api/openapi.json",
      base_url: "/api",
      endpoints: {
        search_events:       "GET /api/events?date=&category=&venue=&type=&contributor=&q=&q_mode=&limit=&offset=",
        get_event:           "GET /api/events/{event_id}",
        shortlist:           "GET /api/shortlist?topic=&per_day=",
        health:              "GET /api/health",
        list_dates:          "GET /api/dates",
        list_venues:         "GET /api/venues?name=",
        list_categories:     "GET /api/categories",
        search_contributors: "GET /api/contributors?name="
      },
      param_notes: {
        q: "Tokenized full-text search across name, venue, category, contributors with synonym normalization (e.g. AI, llm, dev).",
        q_mode: "Search mode: any (default), all, phrase. If all returns 0 results, retry with q=AI&q_mode=any.",
        category: "Format label, not a topic (Panel, Rock, Mentor Session, Presentation…). Use /api/categories for valid values.",
        type: "event_type: panel, showcase, screening, networking, party, activation, exhibition, comedy_event, lounge, special_event, registration",
        contributor: "Partial match on speaker, artist, or performer name"
      },
      example_urls: {
        health: absoluteUrl("/api/health"),
        dates: absoluteUrl("/api/dates"),
        shortlist_ai_developer_tooling: absoluteUrl("/api/shortlist?topic=ai-developer-tooling&per_day=5"),
        events_ai_any: absoluteUrl("/api/events?date=2026-03-14&q=AI&q_mode=any&limit=200"),
        events_ai_dev_tooling_all: absoluteUrl("/api/events?date=2026-03-14&q=AI+developer+tooling&q_mode=all&limit=200")
      },
      note: "Query API returns filtered results <10 KB. No bulk download needed for most queries."
    },
    entrypoints: {
      llms_txt: "/llms.txt",
      website_home: "/index.html",
      schedule_index: "/schedule/index.html",
      robots: "/robots.txt",
      sitemap: "/sitemap.xml",
      manifest: "/schedule.manifest.json",
      schema: "/schema.json"
    },
    recommended_ingestion_order: [
      "Import /api/openapi.json if your framework supports OpenAPI tool discovery",
      "Use /api/shortlist?topic=ai-developer-tooling&per_day=5 for one-call ranked daily shortlists",
      "Query /api/events with date/category/venue/type/contributor/q params — returns <10 KB",
      "Use /api/dates, /api/venues, /api/categories, /api/contributors for reference data"
    ],
    fetching_tips: [
      "The /api/* endpoints are the only access pattern — small responses, no bulk downloads",
      "Fetch JSON directly — do not route through reader proxies (e.g. r.jina.ai). They wrap responses in markdown and break JSON parsing.",
      "All endpoints return Content-Type: application/json — never HTML",
      "If you receive HTML or a markdown wrapper, you are hitting a proxy or a 404. Retry the raw URL directly."
    ],
    expectations: {
      timezone_note: "Event timestamps include local offsets from source data.",
      id_field: "event_id",
      date_field: "date",
      shard_strategy: "one NDJSON file per event date plus unknown-date shard",
      max_file_size_bytes: 25 * 1024 * 1024,
      refresh_mode: freshness.refresh_mode,
      refresh_cadence_target: freshness.refresh_cadence_target
    },
    source: manifest.source
  };

  const normalizedFieldMap = {
    event_id: "raw.event_id (fallback raw.id)",
    id: "raw.id",
    name: "raw.name",
    date: "raw.date",
    start_time: "raw.start_time",
    end_time: "raw.end_time",
    event_type: "raw.event_type",
    format: "raw.format",
    category: "raw.category",
    genre: "raw.genre",
    subgenre: "raw.subgenre",
    track: "raw.track",
    focus_area: "raw.focus_area",
    presented_by: "raw.presented_by",
    reservable: "raw.reservable",
    reservable_id: "raw.reservable_id",
    official_url: "computed from event_id",
    venue: "raw.venue.*",
    credentials: "raw.credentials[]",
    contributors: "raw.contributors[]",
    tags: "raw.tags[]",
    hash_tags: "raw.hash_tags[]",
    publish_at: "raw.publish_at",
    status: "derived from message/description token scan",
    source_updated_at: "raw.publish_at (fallback)",
    record_updated_at: "source_updated_at or generated_at fallback",
    record_version: "deterministic signature from record_updated_at + record_sha256",
    record_sha256: "deterministic SHA256 over normalized event without signature fields",
    canonical: "derived canonical IDs/URLs",
    provenance: "build-time provenance metadata",
    raw: "raw passthrough block (selected source fields)",
    derived: "derived analytics block"
  };

  const normalizedFieldTiers = {
    event_id: "identity",
    id: "raw",
    name: "raw",
    date: "raw",
    start_time: "raw",
    end_time: "raw",
    event_type: "raw",
    format: "raw",
    category: "raw",
    genre: "raw",
    subgenre: "raw",
    track: "raw",
    focus_area: "raw",
    presented_by: "raw",
    reservable: "raw",
    reservable_id: "raw",
    official_url: "derived",
    venue: "raw",
    credentials: "raw",
    contributors: "raw",
    tags: "raw",
    hash_tags: "raw",
    publish_at: "raw",
    status: "derived",
    source_updated_at: "provenance",
    record_updated_at: "provenance",
    record_version: "provenance",
    record_sha256: "provenance",
    canonical: "identity",
    provenance: "provenance",
    raw: "raw",
    derived: "derived"
  };

  const directRawFieldsInNormalized = new Set([
    "event_id",
    "id",
    "name",
    "date",
    "start_time",
    "end_time",
    "event_type",
    "format",
    "category",
    "genre",
    "subgenre",
    "track",
    "focus_area",
    "presented_by",
    "reservable",
    "reservable_id",
    "venue",
    "credentials",
    "contributors",
    "tags",
    "hash_tags",
    "publish_at"
  ]);

  const droppedFields = fullSchedule.fields.filter((field) => !directRawFieldsInNormalized.has(field));

  const normalizedRequiredFields = [
    "event_id",
    "date",
    "status",
    "record_updated_at",
    "record_version",
    "record_sha256",
    "canonical",
    "provenance",
    "raw",
    "derived"
  ];

  const normalizedJsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `SXSW ${YEAR} Agent Event`,
    type: "object",
    required: normalizedRequiredFields,
    additionalProperties: false,
    properties: {
      event_id: { type: "string" },
      id: { type: ["string", "number", "null"] },
      name: { type: ["string", "null"] },
      date: { type: ["string", "null"] },
      start_time: { type: ["string", "null"] },
      end_time: { type: ["string", "null"] },
      event_type: { type: ["string", "null"] },
      format: { type: ["string", "null"] },
      category: { type: ["string", "null"] },
      genre: { type: ["string", "null"] },
      subgenre: { type: ["string", "null"] },
      track: { type: ["string", "null"] },
      focus_area: { type: ["string", "null"] },
      presented_by: { type: ["string", "null"] },
      reservable: { type: "boolean" },
      reservable_id: { type: ["string", "null"] },
      official_url: { type: "string" },
      venue: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: ["string", "number", "null"] },
          name: { type: ["string", "null"] },
          root: { type: ["string", "null"] },
          address: { type: ["string", "null"] },
          city: { type: ["string", "null"] },
          state: { type: ["string", "null"] },
          postal_code: { type: ["string", "null"] },
          lat: { type: ["number", "null"] },
          lon: { type: ["number", "null"] }
        }
      },
      credentials: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: ["string", "null"] },
            name: { type: ["string", "null"] }
          }
        }
      },
      contributors: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            entity_id: { type: ["string", "number", "null"] },
            id: { type: ["string", "number", "null"] },
            name: { type: ["string", "null"] },
            type: { type: ["string", "null"] }
          }
        }
      },
      tags: { type: "array", items: { type: "string" } },
      hash_tags: { type: "array", items: { type: "string" } },
      publish_at: { type: ["string", "null"] },
      status: { type: "string", enum: ["active", "cancelled"] },
      source_updated_at: { type: ["string", "null"] },
      record_updated_at: { type: "string" },
      record_version: { type: "string" },
      record_sha256: { type: "string" },
      canonical: {
        type: "object",
        required: ["event_id", "event_page_path", "event_page_url"],
        additionalProperties: false,
        properties: {
          event_id: { type: "string" },
          event_page_path: { type: "string" },
          event_page_url: { type: "string" },
          date_page_path: { type: "string" },
          date_page_url: { type: "string" },
          official_event_url: { type: "string" },
          venue_id: { type: ["string", "null"] },
          contributor_entity_ids: { type: "array", items: { type: "string" } }
        }
      },
      provenance: {
        type: "object",
        required: ["source_system", "source_event_id", "source_detail_path", "source_snapshot_at", "raw_record_sha256"],
        additionalProperties: false,
        properties: {
          source_system: { type: "string" },
          source_event_id: { type: "string" },
          source_search_path: { type: "string" },
          source_detail_path: { type: "string" },
          source_snapshot_at: { type: "string" },
          raw_fields: { type: "array", items: { type: "string" } },
          raw_record_sha256: { type: "string" }
        }
      },
      raw: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: ["string", "null"] },
          publish_at: { type: ["string", "null"] },
          message: { type: ["string", "null"] },
          reserved: { type: ["boolean", "null"] },
          recommended_ids: { type: "array", items: { type: ["string", "number"] } },
          track_display_name: { type: ["string", "null"] },
          summit_display_name: { type: ["string", "null"] },
          title_only: { type: ["boolean", "null"] }
        }
      },
      derived: {
        type: "object",
        additionalProperties: false,
        properties: {
          normalized_name: { type: "string" },
          normalized_tags: { type: "array", items: { type: "string" } },
          start_epoch_ms: { type: ["number", "null"] },
          end_epoch_ms: { type: ["number", "null"] },
          duration_minutes: { type: ["number", "null"] },
          is_tbd_time: { type: "boolean" }
        }
      }
    }
  };

  const rawJsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `SXSW ${YEAR} Raw Event`,
    type: "object",
    required: ["event_id"],
    properties: {
      event_id: { type: "string" },
      date: { type: ["string", "null"] },
      publish_at: { type: ["string", "null"] }
    },
    additionalProperties: true
  };

  const changeFeedSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `SXSW ${YEAR} Change Feed Record`,
    type: "object",
    required: ["record_type"],
    additionalProperties: true,
    properties: {
      record_type: { type: "string", enum: ["metadata", "change"] },
      change_type: { type: "string", enum: ["added", "modified", "removed", "cancelled", "uncancelled"] },
      event_id: { type: "string" },
      tombstone: { type: "boolean" }
    }
  };

  const schema = {
    schema_version: fullSchedule.schema_version,
    interface_version: INTERFACE_VERSION,
    generated_at: fullSchedule.generated_at,
    festival_year: fullSchedule.festival_year,
    compatibility_policy: compatibility,
    identity,
    normalized_field_count: Object.keys(normalizedFieldMap).length,
    raw_field_count: fullSchedule.fields.length,
    normalized_fields: normalizedFieldMap,
    normalized_field_tiers: normalizedFieldTiers,
    normalized_required_fields: normalizedRequiredFields,
    dropped_fields: droppedFields,
    dropped_fields_note: "These raw fields are not in the normalized agent feed.",
    raw_fields: fullSchedule.fields,
    normalized_json_schema: normalizedJsonSchema,
    raw_json_schema: rawJsonSchema,
    changes_json_schema: changeFeedSchema,
    sample_record: agentEvents[0] || null,
    sample_raw_record: fullSchedule.events[0] || null,
    stats: fullSchedule.stats
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    rm(`${OUTPUT_DIR}/schedule.json`, { force: true }),
    rm(`${OUTPUT_DIR}/events.ndjson`, { force: true }),
    rm(`${OUTPUT_DIR}/schedule/index.html`, { force: true })
  ]);

  const gzippedFull = gzipSync(Buffer.from(JSON.stringify(fullSchedule)), { level: 9 });
  const pageWrites = [];

  pageWrites.push({
    path: `${OUTPUT_DIR}/index.html`,
    route: "/",
    content: renderLandingPage(manifest, dateSummaries)
  });

  pageWrites.push({
    path: `${OUTPUT_DIR}/schedule/index.html`,
    route: "/schedule/",
    content: renderScheduleIndexPage(manifest, dateSummaries)
  });

  pageWrites.push({
    path: `${OUTPUT_DIR}/schedule/styles.css`,
    route: null,
    content: renderSiteCss()
  });

  pageWrites.push({
    path: `${OUTPUT_DIR}/schedule/og-default.svg`,
    route: null,
    content:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" role="img" aria-label="SXSW ${YEAR} Schedule for Agents">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0%" stop-color="#0a1a2a"/><stop offset="100%" stop-color="#153c5e"/></linearGradient></defs>` +
      `<rect width="1200" height="630" fill="url(#g)"/>` +
      `<text x="70" y="250" font-family="Arial, Helvetica, sans-serif" font-size="76" fill="#ffffff" font-weight="700">SXSW ${YEAR}</text>` +
      `<text x="70" y="340" font-family="Arial, Helvetica, sans-serif" font-size="52" fill="#cfe9ff" font-weight="600">Schedule for Agents</text>` +
      `<text x="70" y="410" font-family="Arial, Helvetica, sans-serif" font-size="28" fill="#9ac9ee">Agent-first website export</text>` +
      `</svg>`
  });

  for (const day of dateSummaries) {
    const events = groupedByDate.get(day.date) || [];
    pageWrites.push({
      path: `${OUTPUT_DIR}${day.page_path}`,
      route: day.page_path,
      content: renderDatePage(manifest, day, events)
    });

    for (const event of events) {
      pageWrites.push({
        path: `${OUTPUT_DIR}${eventPagePath(event)}`,
        route: eventPagePath(event),
        content: renderEventPage(manifest, event)
      });
    }
  }

  const sitemapPaths = pageWrites
    .map((page) => page.route)
    .filter((route) => typeof route === "string")
    .concat([
      "/agents.json",
      "/schedule.manifest.json",
      "/schema.json",
      "/llms.txt"
    ])
    .sort();

  await Promise.all([
    writeFile(`${OUTPUT_DIR}/schedule.manifest.json`, JSON.stringify(manifest, null, 2) + "\n"),
    writeFile(`${OUTPUT_DIR}/agents.json`, JSON.stringify(agentsDescriptor, null, 2) + "\n"),
    writeFile(`${OUTPUT_DIR}/agent-schedule.v1.ndjson`, agentNdjson),
    writeFile(`${OUTPUT_DIR}/schema.json`, JSON.stringify(schema, null, 2) + "\n"),
    writeFile(`${OUTPUT_DIR}/schedule.json.gz`, gzippedFull),
    writeFile(`${OUTPUT_DIR}/robots.txt`, renderRobotsTxt()),
    writeFile(`${OUTPUT_DIR}/sitemap.xml`, renderSitemapXml(sitemapPaths, generatedAt)),
    writeFile(`${OUTPUT_DIR}/llms.txt`, renderLlmsTxt(manifest))
  ]);

  await mapWithConcurrency(pageWrites, 32, async (page) => {
    await writeFile(page.path, page.content);
  });

  console.log(
    `Done. Wrote ${OUTPUT_DIR}/schedule pages (${pageWrites.length} files) and data manifest.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
