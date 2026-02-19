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
  const aiPromptsSection = `<section class="panel">
  <h2>AI Assistant Prompts</h2>
  <p class="small">Copy and paste into Claude, ChatGPT, Gemini, Perplexity, or coding agents.</p>
  <details>
    <summary>Find AI sessions on 2026-03-15</summary>
    <pre>Use ${escapeHtml(absoluteUrl("/"))} as source.
Read /schedule.manifest.json first, then /agent-schedule.v1.slim.json.
Find SXSW ${manifest.festival_year} sessions on 2026-03-15 about AI.
Return: event_id, name, start_time, end_time, venue.name, official_url.
Sort by start_time.</pre>
  </details>
  <details>
    <summary>Find sessions at Hilton Austin Downtown</summary>
    <pre>Use ${escapeHtml(absoluteUrl("/agent-schedule.v1.slim.json"))}.
Find all sessions at Hilton Austin Downtown on 2026-03-14.
Return a compact table with time, session name, category, and event_id.</pre>
  </details>
  <details>
    <summary>Summarize what changed since last refresh</summary>
    <pre>Use ${escapeHtml(absoluteUrl("/changes.ndjson"))}.
Summarize added/modified/removed/cancelled events since the previous snapshot.
If there are removed/cancelled events, list tombstones first.</pre>
  </details>
  <p><a class="button" href="/prompts/index.html">Open Prompt Examples</a></p>
</section>`;

  const cards = dateSummaries
    .map(
      (day) => `<article class="card">
  <h3><a href="${day.page_path}">${escapeHtml(day.label)}</a></h3>
  <p class="meta"><strong>${day.event_count}</strong> events</p>
  <p class="small"><a href="${day.ndjson_path}">NDJSON shard</a></p>
</article>`
    )
    .join("");

  return renderShell({
    title: `SXSW ${manifest.festival_year} Schedule for Agents`,
    description: `SXSW ${manifest.festival_year} schedule for agents: human-browsable pages and agent-ready feeds from official source data.`,
    body: `<section class="hero">
  <h1>SXSW ${manifest.festival_year} Schedule for Agents</h1>
  <p>This project makes the SXSW schedule easy for agents to parse and easy for humans to browse, using official SXSW source data.</p>
  <p class="meta"><strong>Freshness:</strong> ${escapeHtml(manifest.freshness?.data_staleness?.status || "unknown")} | Source snapshot: ${escapeHtml(manifest.freshness?.source_snapshot_at || "n/a")} | Next expected refresh: ${escapeHtml(manifest.freshness?.expected_next_refresh_by || "n/a")}</p>
  <p><a class="button" href="/schedule/index.html">Browse Full Schedule</a></p>
  <p class="meta">Generated: ${escapeHtml(manifest.generated_at)} | Events: ${manifest.stats.event_count}</p>
</section>
${aiPromptsSection}
<section class="panel">
  <h2>What This Is</h2>
  <p>A human-browsable SXSW ${manifest.festival_year} schedule plus agent-ready data feeds. Built for people, LLMs, chatbots, and automation workflows.</p>
  <ul class="flat">
    <li><a href="/faq/index.html">FAQ</a> for common usage questions</li>
    <li><a href="/changelog/index.html">Changelog</a> for latest snapshot differences</li>
    <li><a href="/stability/index.html">Schema stability policy</a> for compatibility guarantees</li>
  </ul>
</section>
<section class="panel">
  <h2>By Day</h2>
  <div class="grid">${cards}</div>
</section>
<section class="panel">
  <h2>Machine Access</h2>
  <ul class="flat">
    <li><a href="/agents.json"><code>/agents.json</code></a></li>
    <li><a href="/schedule.manifest.json"><code>/schedule.manifest.json</code></a></li>
    <li><a href="/changes.ndjson"><code>/changes.ndjson</code></a></li>
    <li><a href="/entities/venues.v1.ndjson"><code>/entities/venues.v1.ndjson</code></a></li>
    <li><a href="/entities/contributors.v1.ndjson"><code>/entities/contributors.v1.ndjson</code></a></li>
    <li><a href="/schedule.json.gz"><code>/schedule.json.gz</code></a></li>
    <li><a href="/schema.json"><code>/schema.json</code></a></li>
  </ul>
</section>`,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Dataset",
      name: `SXSW ${manifest.festival_year} Schedule`,
      description: "Static, browsable schedule export sourced from official SXSW data.",
      distribution: [
        { "@type": "DataDownload", contentUrl: absoluteUrl("/schedule.manifest.json") },
        { "@type": "DataDownload", contentUrl: absoluteUrl("/schedule.json.gz") }
      ]
    },
    pagePath: "/"
  });
}

function renderPromptExamplesPage(manifest) {
  const base = absoluteUrl("/");
  return renderShell({
    title: `AI Prompt Examples | SXSW ${manifest.festival_year}`,
    description: `Copy/paste prompt examples for querying SXSW ${manifest.festival_year} schedule with popular AI assistants.`,
    body: `<p class="breadcrumbs"><a href="/index.html">Home</a></p>
<section class="hero">
  <h1>AI Assistant Prompt Examples</h1>
  <p>Copy and paste these into Claude, ChatGPT, Gemini, Perplexity, or coding agents.</p>
  <p class="meta">Base URL: <code>${escapeHtml(base)}</code></p>
</section>
<section class="panel">
  <h2>Prompt Builder</h2>
  <div style="display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));">
    <label>Topic <input id="pb-topic" type="text" value="AI" style="width:100%;margin-top:4px;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);"></label>
    <label>Date <input id="pb-date" type="date" value="2026-03-15" style="width:100%;margin-top:4px;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);"></label>
    <label>Speaker (optional) <input id="pb-speaker" type="text" placeholder="Dr. Carmen Simon" style="width:100%;margin-top:4px;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);"></label>
  </div>
  <p style="margin-top:10px;"><button id="pb-copy" class="button" type="button">Copy Generated Prompt</button></p>
  <pre id="pb-output"></pre>
</section>
<section class="panel">
  <h2>1) Find Sessions by Topic and Date</h2>
  <p><button class="button copy-prompt" type="button" data-target="prompt-1">Copy</button></p>
  <pre id="prompt-1">Use ${escapeHtml(base)} as source.
Read /schedule.manifest.json first, then /agent-schedule.v1.slim.json.
Find SXSW ${manifest.festival_year} sessions on 2026-03-15 about AI.
Return: event_id, name, start_time, end_time, venue.name, official_url.
Sort by start_time.</pre>
</section>
<section class="panel">
  <h2>2) Venue-Based Search</h2>
  <p><button class="button copy-prompt" type="button" data-target="prompt-2">Copy</button></p>
  <pre id="prompt-2">Use ${escapeHtml(base)}agent-schedule.v1.slim.json.
Find all sessions at Hilton Austin Downtown on 2026-03-14.
Return a compact table with time, session name, category, and event_id.</pre>
</section>
<section class="panel">
  <h2>3) Speaker Lookup</h2>
  <p><button class="button copy-prompt" type="button" data-target="prompt-3">Copy</button></p>
  <pre id="prompt-3">Use ${escapeHtml(base)}agent-schedule.v1.slim.json.
Find sessions where contributors include "Dr. Carmen Simon".
Return date, time, event name, venue.name, event_id, and official_url.</pre>
</section>
<section class="panel">
  <h2>4) Incremental Update Check</h2>
  <p><button class="button copy-prompt" type="button" data-target="prompt-4">Copy</button></p>
  <pre id="prompt-4">Use ${escapeHtml(base)}changes.ndjson.
Summarize added/modified/removed/cancelled events since the previous snapshot.
If there are removed/cancelled events, list tombstones first.</pre>
</section>
<section class="panel">
  <h2>5) Best Ingestion Flow for an Agent</h2>
  <p><button class="button copy-prompt" type="button" data-target="prompt-5">Copy</button></p>
  <pre id="prompt-5">Use ${escapeHtml(base)}agents.json and follow its recommended ingestion order.
Build a shortlist of "top AI + developer tooling sessions" for each day.
Use only SXSW ${manifest.festival_year} events and include event_id + official_url in every item.</pre>
</section>
<section class="panel">
  <h2>See Also</h2>
  <ul class="flat">
    <li><a href="/faq/index.html">FAQ</a></li>
    <li><a href="/changelog/index.html">Changelog</a></li>
    <li><a href="/stability/index.html">Schema stability policy</a></li>
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

  function buildPrompt() {
    var topic = (document.getElementById('pb-topic').value || 'AI').trim();
    var date = (document.getElementById('pb-date').value || '2026-03-15').trim();
    var speaker = (document.getElementById('pb-speaker').value || '').trim();
    var lines = [
      'Use ${escapeHtml(base)} as source.',
      'Read /schedule.manifest.json first, then /agent-schedule.v1.slim.json.',
      'Find SXSW ${manifest.festival_year} sessions on ' + date + ' about ' + topic + '.',
      'Return: event_id, name, start_time, end_time, venue.name, official_url.',
      'Sort by start_time.'
    ];
    if (speaker) {
      lines.push('Prefer events where contributors include \"' + speaker + '\".');
    }
    var text = lines.join('\\n');
    document.getElementById('pb-output').textContent = text;
    return text;
  }

  ['pb-topic','pb-date','pb-speaker'].forEach(function(id) {
    var el = document.getElementById(id);
    el.addEventListener('input', buildPrompt);
  });
  buildPrompt();

  document.getElementById('pb-copy').addEventListener('click', function() {
    copyText(buildPrompt());
  });

  document.querySelectorAll('.copy-prompt').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var target = document.getElementById(btn.getAttribute('data-target'));
      if (!target) return;
      copyText(target.textContent || '');
    });
  });
})();
</script>
`,
    pagePath: "/prompts/"
  });
}

function renderFaqPage(manifest) {
  return renderShell({
    title: `FAQ | SXSW ${manifest.festival_year} Agent-First Schedule`,
    description: `Frequently asked questions about using the SXSW ${manifest.festival_year} schedule website and data feeds.`,
    body: `<p class="breadcrumbs"><a href="/index.html">Home</a></p>
<section class="hero">
  <h1>FAQ</h1>
  <p>Practical answers for using the website and data feeds.</p>
</section>
<section class="panel">
  <h2>What is this website?</h2>
  <p>A static SXSW ${manifest.festival_year} schedule mirror designed for both humans and agents.</p>
</section>
<section class="panel">
  <h2>Where should agents start?</h2>
  <p>Start with <a href="/schedule.manifest.json"><code>/schedule.manifest.json</code></a>, then use <a href="/agent-schedule.v1.json"><code>/agent-schedule.v1.json</code></a>.</p>
</section>
<section class="panel">
  <h2>How do I track updates?</h2>
  <p>Read <a href="/changes.ndjson"><code>/changes.ndjson</code></a>. It includes added, modified, removed, and cancelled records plus tombstones.</p>
</section>
<section class="panel">
  <h2>How fresh is the data?</h2>
  <p>Check <code>freshness</code> fields in <a href="/schedule.manifest.json"><code>/schedule.manifest.json</code></a>: <code>source_snapshot_at</code>, <code>expected_next_refresh_by</code>, and <code>data_staleness</code>.</p>
</section>
<section class="panel">
  <h2>Can I browse by day?</h2>
  <p>Yes. Use <a href="/schedule/index.html"><code>/schedule/index.html</code></a> and each date page for filterable tables.</p>
</section>
<section class="panel">
  <h2>Can I use this with Claude/ChatGPT/Gemini?</h2>
  <p>Yes. Use <a href="/prompts/index.html"><code>/prompts/index.html</code></a> for copy/paste prompt examples and a prompt builder.</p>
</section>`,
    pagePath: "/faq/"
  });
}

function renderChangelogPage(manifest, changeRecords) {
  const rows = changeRecords
    .slice(0, 200)
    .map((record) => `<tr>
  <td class="mono">${escapeHtml(record.change_type || "n/a")}</td>
  <td class="mono">${escapeHtml(record.event_id || "n/a")}</td>
  <td>${escapeHtml(record.name || "(untitled)")}</td>
  <td class="mono">${escapeHtml(record.date || "n/a")}</td>
  <td class="mono">${escapeHtml(record.status || "n/a")}</td>
</tr>`)
    .join("");

  return renderShell({
    title: `Changelog | SXSW ${manifest.festival_year} Agent-First Schedule`,
    description: `Latest snapshot-level changes for SXSW ${manifest.festival_year} schedule data.`,
    body: `<p class="breadcrumbs"><a href="/index.html">Home</a></p>
<section class="hero">
  <h1>Changelog</h1>
  <p class="meta">Generated: ${escapeHtml(manifest.generated_at)}</p>
  <p class="meta">Total changes: ${manifest.changes?.total ?? 0} | Added: ${manifest.changes?.added ?? 0} | Modified: ${manifest.changes?.modified ?? 0} | Removed: ${manifest.changes?.removed ?? 0} | Cancelled: ${manifest.changes?.cancelled ?? 0}</p>
  <p><a class="button" href="/changes.ndjson">Download /changes.ndjson</a></p>
</section>
<section class="panel">
  <h2>Recent Changes (first 200)</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>Type</th><th>Event ID</th><th>Name</th><th>Date</th><th>Status</th></tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="5">No changes in this snapshot.</td></tr>`}</tbody>
    </table>
  </div>
</section>`,
    pagePath: "/changelog/"
  });
}

function renderStabilityPage(manifest) {
  const nonBreaking = (manifest.compatibility?.policy?.non_breaking_changes || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const breaking = (manifest.compatibility?.policy?.breaking_changes || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");

  return renderShell({
    title: `Schema Stability | SXSW ${manifest.festival_year} Agent-First Schedule`,
    description: `Compatibility guarantees and deprecation policy for SXSW ${manifest.festival_year} schedule data contracts.`,
    body: `<p class="breadcrumbs"><a href="/index.html">Home</a></p>
<section class="hero">
  <h1>Schema Stability Policy</h1>
  <p class="meta">Schema: ${escapeHtml(manifest.compatibility?.schema_semver || "n/a")} | Interface: ${escapeHtml(manifest.compatibility?.interface_semver || "n/a")}</p>
</section>
<section class="panel">
  <h2>Non-Breaking Changes</h2>
  <ul class="flat">${nonBreaking}</ul>
</section>
<section class="panel">
  <h2>Breaking Changes</h2>
  <ul class="flat">${breaking}</ul>
</section>
<section class="panel">
  <h2>Deprecation Policy</h2>
  <p>Breaking changes require a schema/interface version bump. Existing paths remain stable within the same interface version.</p>
  <p>Before relying on a feed in production, always read <a href="/schedule.manifest.json"><code>/schedule.manifest.json</code></a> and compare <code>schema_version</code> and <code>agent_interface.version</code>.</p>
</section>`,
    pagePath: "/stability/"
  });
}

function renderScheduleIndexPage(manifest, dateSummaries) {
  const aiPromptsSection = `<section class="panel">
  <h2>AI Assistant Prompts</h2>
  <details>
    <summary>Top AI + developer tooling sessions per day</summary>
    <pre>Use ${escapeHtml(absoluteUrl("/agents.json"))} and follow its recommended ingestion order.
Build a shortlist of top AI + developer tooling sessions for each day.
Include event_id and official_url for every item.</pre>
  </details>
  <details>
    <summary>Speaker lookup prompt</summary>
    <pre>Use ${escapeHtml(absoluteUrl("/agent-schedule.v1.slim.json"))}.
Find sessions where contributors include "Dr. Carmen Simon".
Return date, time, event name, venue.name, event_id, and official_url.</pre>
  </details>
  <p><a class="button" href="/prompts/index.html">Open Prompt Examples</a></p>
</section>`;

  const cards = dateSummaries
    .map(
      (day) => `<article class="card">
  <h3><a href="${day.page_path}">${escapeHtml(day.label)}</a></h3>
  <p class="meta"><strong>${day.event_count}</strong> events</p>
  <p class="small"><a href="${day.ndjson_path}">Raw shard</a></p>
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
${aiPromptsSection}
<section class="panel">
  <h2>Helpful Pages</h2>
  <ul class="flat">
    <li><a href="/prompts/index.html">Prompt examples</a></li>
    <li><a href="/faq/index.html">FAQ</a></li>
    <li><a href="/changelog/index.html">Changelog</a></li>
    <li><a href="/stability/index.html">Schema stability</a></li>
  </ul>
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
  <p class="meta">Events: ${day.event_count} | Data shard: <a href="${day.ndjson_path}">${day.ndjson_path}</a></p>
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

function renderLlmsTxt(manifest, dateSummaries) {
  const shardLines = dateSummaries
    .filter((d) => d.date !== "unknown")
    .map((d) => {
      const slimPath = d.ndjson_path.replace(/\.ndjson$/, ".slim.json");
      return `- [${d.label} slim JSON](${slimPath}) — ${d.event_count} events, key fields only | [full NDJSON](${d.ndjson_path})`;
    })
    .join("\n");

  const ai = manifest.agent_interface || {};
  const fmtMb = (bytes) => (typeof bytes === "number" ? `~${Math.round(bytes / 1024 / 1024 * 10) / 10} MB` : "see manifest");

  const normalizedFields = [
    "event_id", "name", "date", "start_time", "end_time", "event_type", "format", "category",
    "genre", "subgenre", "track", "focus_area", "presented_by", "reservable", "official_url",
    "venue (id, name, address, lat, lon)", "contributors (name, type)", "tags", "hash_tags"
  ].join(", ");

  return `# SXSW ${manifest.festival_year} Agent-First Schedule

> A static, machine-readable export of the official SXSW ${manifest.festival_year} schedule.
> ${manifest.stats.event_count} events across March 12–18, ${manifest.festival_year}. All data sourced from schedule.sxsw.com.

## What This Site Is

This site publishes the SXSW ${manifest.festival_year} festival schedule as structured, agent-friendly data.
It is designed to be easy for LLMs and AI agents to ingest, filter, and reason over.

## Recommended Ingestion (Start Here)

- [Agent ingestion contract](/agents.json) — machine-readable guide: endpoints, field names, ingestion order
- [**Slim JSON feed**](/agent-schedule.v1.slim.json) — all ${manifest.stats.event_count} events, 10 key fields only, **${fmtMb(ai.bytes_slim_json)}** — recommended for most agent tool calls
- [Slim NDJSON feed](/agent-schedule.v1.slim.ndjson) — same slim data, one event per line, **${fmtMb(ai.bytes_slim_ndjson)}**
- [Full normalized JSON feed](/agent-schedule.v1.json) — all ${manifest.stats.event_count} events, raw + derived + provenance blocks, ${fmtMb(ai.bytes_json)} (large — prefer slim feed or per-day shards)
- [Full normalized NDJSON feed](/agent-schedule.v1.ndjson) — same full data, one event per line, ${fmtMb(ai.bytes_ndjson)}
- [Manifest + hashes](/schedule.manifest.json) — metadata, SHA256 hashes, shard map, field inventory
- [Field schema + sample record](/schema.json) — all ${manifest.stats.field_count} raw fields documented with a sample event
- [Change feed + tombstones](/changes.ndjson) — added/modified/removed/cancelled records for incremental sync
- [Entity indexes](/entities/venues.v1.ndjson), [/entities/contributors.v1.ndjson] — canonical cross-event joins

## Date-Sharded Feeds (Recommended for Tool Calls)

Fetch only the days you need. Each day has a **slim JSON** (~280-410 KB) and a full NDJSON shard:

${shardLines}

## Full Raw Snapshot

- [Full compressed export](/schedule.json.gz) — all ${manifest.stats.field_count} raw fields, gzip compressed

## Human-Browsable Pages

- [Schedule index](/schedule/index.html) — browse by day
- [Individual event pages](/schedule/event/{event_id}.html) — one HTML page per event with JSON payload

## Key Fields (Normalized Feed)

${normalizedFields}

## Data Freshness

Last built: ${manifest.generated_at}
Source snapshot: ${manifest.freshness?.source_snapshot_at || manifest.generated_at}
Expected next refresh by: ${manifest.freshness?.expected_next_refresh_by || manifest.generated_at}
Refresh mode: daily cadence.

## Notes for LLMs

- Primary event identifier: \`event_id\`
- All timestamps include timezone offsets (America/Chicago, UTC-5 during festival)
- \`contributors\` array contains speakers, artists, and performers
- \`credentials\` array indicates badge types required to attend
- \`reservable: true\` means the event requires a reservation via the official SXSW app
- Venue objects include \`lat\`/\`lon\` for geospatial filtering
- **File size warning:** The full feeds (/agent-schedule.v1.json ${fmtMb(ai.bytes_json)}, /agent-schedule.v1.ndjson ${fmtMb(ai.bytes_ndjson)}) may exceed tool call response limits. Use per-day slim shards (~280-410 KB) or /agent-schedule.v1.slim.json (${fmtMb(ai.bytes_slim_json)}) for most queries.

## Fetching Tips for AI Agents

- **Fetch JSON directly** — do not route through reader proxies (e.g. r.jina.ai, reader.llmstxt.cloud). These wrap the response in markdown and break JSON parsing. Use your HTTP/fetch tool with the raw URL.
- **Per-day slim shards are best** for tool calls: /events/by-date/2026-03-12.slim.json through 2026-03-18.slim.json. Each is ~280-410 KB and parses cleanly.
- **Check /agents.json first** — it lists all endpoints, recommended ingestion order, and field names.
- All endpoints return \`Content-Type: application/json\` or \`application/x-ndjson\` — never HTML.
- If you receive HTML or a markdown wrapper, you are hitting a proxy or a 404 fallback. Retry the raw URL directly.

## Optional: Full Raw Data

The \`/schedule.json.gz\` file contains all ${manifest.stats.field_count} source fields including accessibility flags,
streaming URLs, film data, and related event IDs. Decompress with standard gzip tools.
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
      ndjson_path: `/events/by-date/${pathDate}.ndjson`,
      page_path: datePagePath(date)
    });
  }
  return dateSummaries;
}

async function loadPublishedSnapshotForSiteBuild() {
  const manifestPath = `${OUTPUT_DIR}/schedule.manifest.json`;
  const fullPath = `${OUTPUT_DIR}/schedule.json.gz`;
  const changesPath = `${OUTPUT_DIR}/changes.ndjson`;
  const agentNdjsonPath = `${OUTPUT_DIR}/agent-schedule.v1.ndjson`;

  const [manifestRaw, fullRaw, changesRaw, agentNdjsonRaw] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(fullPath),
    readFile(changesPath, "utf8").catch(() => ""),
    readFile(agentNdjsonPath, "utf8").catch(() => "")
  ]);

  const manifest = JSON.parse(manifestRaw);
  const full = JSON.parse(gunzipSync(fullRaw).toString("utf8"));
  const detailedEvents = Array.isArray(full.events) ? full.events.slice().sort(byStartTime) : [];
  const groupedByDate = groupByDate(detailedEvents);
  const dateSummaries = buildDateSummaries(groupedByDate);
  const changeLines = parseNdjson(changesRaw);
  const changeRecords = changeLines.filter((line) => line?.record_type === "change");
  const agentEvents = agentNdjsonRaw ? parseNdjson(agentNdjsonRaw) : [];

  return {
    manifest,
    groupedByDate,
    dateSummaries,
    changeRecords,
    agentEvents
  };
}

async function writeSiteArtifacts({ manifest, groupedByDate, dateSummaries, changeRecords, agentEvents, generatedAt }) {
  // Generate slim feeds from normalized agent events
  const slimEvents = (agentEvents || []).map(slimEvent);
  const slimSchedule = {
    schema_version: manifest.schema_version || SCHEMA_VERSION,
    interface_version: manifest.agent_interface?.version || INTERFACE_VERSION,
    generated_at: generatedAt,
    festival_year: YEAR,
    event_count: slimEvents.length,
    note: "Slim feed: key fields only. Full data at /agent-schedule.v1.json.",
    fields: Object.keys(slimEvents[0] || {}),
    events: slimEvents
  };
  const slimNdjson = toNdjson(slimEvents);
  const slimJsonText = JSON.stringify(slimSchedule, null, 2) + "\n";

  // Patch slim byte sizes into manifest.agent_interface for renderLlmsTxt
  manifest.agent_interface.bytes_slim_json = Buffer.byteLength(slimJsonText);
  manifest.agent_interface.bytes_slim_ndjson = Buffer.byteLength(slimNdjson);

  // Per-day slim JSON shards (~280-410 KB each, suitable for web tool fetches)
  const slimByDate = groupByDate(slimEvents);
  const slimShardWrites = [];
  for (const [date, events] of slimByDate.entries()) {
    const pathDate = dateSlug(date);
    const shard = {
      schema_version: manifest.schema_version || SCHEMA_VERSION,
      generated_at: generatedAt,
      festival_year: YEAR,
      date: date || null,
      event_count: events.length,
      note: `Slim shard for ${date}. Full day data at /events/by-date/${pathDate}.ndjson.`,
      fields: Object.keys(events[0] || {}),
      events
    };
    slimShardWrites.push(
      writeFile(`${OUTPUT_DIR}/events/by-date/${pathDate}.slim.json`, JSON.stringify(shard, null, 2) + "\n")
    );
  }
  await Promise.all(slimShardWrites);

  await rm(`${OUTPUT_DIR}/schedule`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/prompts`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/faq`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/changelog`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/stability`, { recursive: true, force: true });
  await mkdir(`${OUTPUT_DIR}/schedule/date`, { recursive: true });
  await mkdir(`${OUTPUT_DIR}/schedule/event`, { recursive: true });
  await mkdir(`${OUTPUT_DIR}/prompts`, { recursive: true });
  await mkdir(`${OUTPUT_DIR}/faq`, { recursive: true });
  await mkdir(`${OUTPUT_DIR}/changelog`, { recursive: true });
  await mkdir(`${OUTPUT_DIR}/stability`, { recursive: true });

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
    path: `${OUTPUT_DIR}/prompts/index.html`,
    route: "/prompts/",
    content: renderPromptExamplesPage(manifest)
  });

  pageWrites.push({
    path: `${OUTPUT_DIR}/faq/index.html`,
    route: "/faq/",
    content: renderFaqPage(manifest)
  });

  pageWrites.push({
    path: `${OUTPUT_DIR}/changelog/index.html`,
    route: "/changelog/",
    content: renderChangelogPage(manifest, changeRecords)
  });

  pageWrites.push({
    path: `${OUTPUT_DIR}/stability/index.html`,
    route: "/stability/",
    content: renderStabilityPage(manifest)
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
      "/agent-schedule.v1.slim.json",
      "/agent-schedule.v1.slim.ndjson",
      "/agent-schedule.v1.json",
      "/agent-schedule.v1.ndjson",
      "/changes.ndjson",
      "/schema.json",
      "/entities/venues.v1.ndjson",
      "/entities/contributors.v1.ndjson",
      "/llms.txt"
    ])
    .sort();

  // Rebuild agents.json with slim feed entrypoints so agents read the right feed
  const siteAgentsDescriptor = {
    ...manifest.source_descriptor,
    agent_contract_version: manifest.schema_version || SCHEMA_VERSION,
    generated_at: generatedAt,
    festival_year: manifest.festival_year || YEAR,
    purpose: "Agent-first SXSW schedule feed from official source",
    freshness: manifest.freshness,
    compatibility: manifest.compatibility,
    identity: manifest.identity,
    entrypoints: {
      llms_txt: "/llms.txt",
      website_home: "/index.html",
      schedule_index: "/schedule/index.html",
      robots: "/robots.txt",
      sitemap: "/sitemap.xml",
      slim_json: "/agent-schedule.v1.slim.json",
      slim_ndjson: "/agent-schedule.v1.slim.ndjson",
      easy_json: "/agent-schedule.v1.json",
      easy_ndjson: "/agent-schedule.v1.ndjson",
      manifest: "/schedule.manifest.json",
      full_export_gzip: "/schedule.json.gz",
      schema: "/schema.json",
      slim_shards: "/events/by-date/*.slim.json",
      shards: "/events/by-date/*.ndjson",
      changes: "/changes.ndjson",
      venues: "/entities/venues.v1.ndjson",
      contributors: "/entities/contributors.v1.ndjson"
    },
    recommended_ingestion_order: [
      "Read /schedule.manifest.json for schema version, freshness metadata, and hashes",
      "Fetch per-day slim JSON at /events/by-date/{date}.slim.json (~280-410 KB each) — best for most tool calls",
      "Read /agent-schedule.v1.slim.json for all events in one request (~2.5 MB) — if per-day is too granular",
      "Read /agent-schedule.v1.json for the full normalized feed (14 MB — only when all fields are needed)",
      "Read /changes.ndjson to apply tombstones and incremental updates",
      "Read /entities/venues.v1.ndjson and /entities/contributors.v1.ndjson for cross-event identity joins",
      "Use /events/by-date/*.ndjson for full-fidelity date-scoped streaming refreshes",
      "Use /schedule.json.gz only when complete raw snapshot fidelity is required"
    ],
    fetching_tips: [
      "Fetch JSON directly — do not route through reader proxies (e.g. r.jina.ai). They wrap responses in markdown and break JSON parsing.",
      "Per-day slim shards are best for tool calls: /events/by-date/2026-03-12.slim.json through 2026-03-18.slim.json",
      "All endpoints return Content-Type: application/json or application/x-ndjson — never HTML",
      "If you receive HTML or a markdown wrapper, you are hitting a proxy or a 404. Retry the raw URL directly."
    ],
    expectations: manifest.expectations,
    source: manifest.source
  };

  await Promise.all([
    writeFile(`${OUTPUT_DIR}/robots.txt`, renderRobotsTxt()),
    writeFile(`${OUTPUT_DIR}/sitemap.xml`, renderSitemapXml(sitemapPaths, generatedAt)),
    writeFile(`${OUTPUT_DIR}/llms.txt`, renderLlmsTxt(manifest, dateSummaries)),
    writeFile(`${OUTPUT_DIR}/agents.json`, JSON.stringify(siteAgentsDescriptor, null, 2) + "\n"),
    writeFile(`${OUTPUT_DIR}/agent-schedule.v1.slim.json`, slimJsonText),
    writeFile(`${OUTPUT_DIR}/agent-schedule.v1.slim.ndjson`, slimNdjson)
  ]);

  await mapWithConcurrency(pageWrites, 32, async (page) => {
    await writeFile(page.path, page.content);
  });

  return pageWrites.length;
}

async function main() {
  if (BUILD_MODE === "site") {
    console.log(`Building website from committed data snapshot (SXSW ${YEAR})...`);
    const { manifest, groupedByDate, dateSummaries, changeRecords, agentEvents } =
      await loadPublishedSnapshotForSiteBuild();
    const pageCount = await writeSiteArtifacts({
      manifest,
      groupedByDate,
      dateSummaries,
      changeRecords,
      agentEvents,
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

  const shardSummaries = [];
  const dateSummaries = [];
  const shardWrites = [];

  await rm(`${OUTPUT_DIR}/events`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/schedule`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/entities`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/prompts`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/faq`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/changelog`, { recursive: true, force: true });
  await rm(`${OUTPUT_DIR}/stability`, { recursive: true, force: true });
  await mkdir(`${OUTPUT_DIR}/events/by-date`, { recursive: true });
  await mkdir(`${OUTPUT_DIR}/schedule/date`, { recursive: true });
  await mkdir(`${OUTPUT_DIR}/schedule/event`, { recursive: true });
  await mkdir(`${OUTPUT_DIR}/entities`, { recursive: true });
  await mkdir(`${OUTPUT_DIR}/prompts`, { recursive: true });
  await mkdir(`${OUTPUT_DIR}/faq`, { recursive: true });
  await mkdir(`${OUTPUT_DIR}/changelog`, { recursive: true });
  await mkdir(`${OUTPUT_DIR}/stability`, { recursive: true });

  for (const [date, events] of groupedByDate.entries()) {
    const pathDate = dateSlug(date);
    const relPath = `/events/by-date/${pathDate}.ndjson`;
    const absPath = `${OUTPUT_DIR}${relPath}`;
    const ndjson = toNdjson(events);

    dateSummaries.push({
      date,
      slug: pathDate,
      label: formatDateLabel(date),
      event_count: events.length,
      ndjson_path: relPath,
      page_path: datePagePath(date)
    });

    shardSummaries.push({
      date,
      path: relPath,
      event_count: events.length,
      sha256: createHash("sha256").update(ndjson).digest("hex"),
      bytes: Buffer.byteLength(ndjson)
    });

    shardWrites.push(writeFile(absPath, ndjson));
  }

  await Promise.all(shardWrites);

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
  const venueEntities = buildVenueEntityIndex(agentEvents);
  const contributorEntities = buildContributorEntityIndex(agentEvents);
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
  const agentJsonText = JSON.stringify(agentSchedule, null, 2) + "\n";

  const slimEvents = agentEvents.map(slimEvent);
  const slimSchedule = {
    schema_version: SCHEMA_VERSION,
    interface_version: INTERFACE_VERSION,
    generated_at: generatedAt,
    festival_year: YEAR,
    event_count: slimEvents.length,
    note: "Slim feed: key fields only. Full data at /agent-schedule.v1.json.",
    fields: Object.keys(slimEvents[0] || {}),
    events: slimEvents
  };
  const slimNdjson = toNdjson(slimEvents);
  const slimJsonText = JSON.stringify(slimSchedule, null, 2) + "\n";

  // Per-day slim JSON shards (~280-410 KB each, suitable for web tool fetches)
  const slimByDate = groupByDate(slimEvents);
  const slimShardWrites = [];
  for (const [date, events] of slimByDate.entries()) {
    const pathDate = dateSlug(date);
    const shard = {
      schema_version: SCHEMA_VERSION,
      generated_at: generatedAt,
      festival_year: YEAR,
      date: date || null,
      event_count: events.length,
      note: `Slim shard for ${date}. Full day data at /events/by-date/${pathDate}.ndjson.`,
      fields: Object.keys(events[0] || {}),
      events
    };
    slimShardWrites.push(
      writeFile(`${OUTPUT_DIR}/events/by-date/${pathDate}.slim.json`, JSON.stringify(shard, null, 2) + "\n")
    );
  }
  await Promise.all(slimShardWrites);

  const { previousGeneratedAt, previousEventsById, baselineResetReason } = await readPreviousBuildState();
  const baselineGeneratedAt = previousGeneratedAt || null;
  const { metadata: changesMetadata, records: changeRecords, counts: changeCounts } =
    buildChangeRecords(agentEvents, previousEventsById, generatedAt, baselineGeneratedAt);
  if (baselineResetReason) {
    changesMetadata.note = `${changesMetadata.note} ${baselineResetReason}`;
  }
  const changesNdjson =
    [JSON.stringify(changesMetadata), ...changeRecords.map((record) => JSON.stringify(record))].join("\n") + "\n";

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
      date_range: dateRange,
      shard_count: shardSummaries.length,
      venue_entity_count: venueEntities.length,
      contributor_entity_count: contributorEntities.length
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
    full_export_gzip: {
      path: "/schedule.json.gz",
      sha256: fullSchedule.sha256
    },
    agent_interface: {
      version: INTERFACE_VERSION,
      path_json: "/agent-schedule.v1.json",
      path_ndjson: "/agent-schedule.v1.ndjson",
      layering: {
        raw_fields_block: "raw",
        derived_fields_block: "derived",
        provenance_block: "provenance",
        canonical_block: "canonical"
      }
    },
    changes: {
      path: "/changes.ndjson",
      generated_at: generatedAt,
      baseline_generated_at: baselineGeneratedAt,
      baseline_reset_reason: baselineResetReason,
      total: changesMetadata.total_changes,
      ...changeCounts,
      tombstone_count: changesMetadata.tombstone_count
    },
    entity_indexes: {
      venues_ndjson: "/entities/venues.v1.ndjson",
      contributors_ndjson: "/entities/contributors.v1.ndjson",
      venue_count: venueEntities.length,
      contributor_count: contributorEntities.length
    },
    shards: shardSummaries,
    website: {
      home: "/index.html",
      schedule_index: "/schedule/index.html",
      date_pages: "/schedule/date/{date}.html",
      event_pages: "/schedule/event/{event_id}.html"
    }
  };

  manifest.agent_interface.sha256_json = createHash("sha256")
    .update(agentJsonText)
    .digest("hex");
  manifest.agent_interface.sha256_ndjson = createHash("sha256")
    .update(agentNdjson)
    .digest("hex");
  manifest.agent_interface.bytes_json = Buffer.byteLength(agentJsonText);
  manifest.agent_interface.bytes_ndjson = Buffer.byteLength(agentNdjson);
  manifest.agent_interface.path_slim_json = "/agent-schedule.v1.slim.json";
  manifest.agent_interface.path_slim_ndjson = "/agent-schedule.v1.slim.ndjson";
  manifest.agent_interface.sha256_slim_json = createHash("sha256").update(slimJsonText).digest("hex");
  manifest.agent_interface.sha256_slim_ndjson = createHash("sha256").update(slimNdjson).digest("hex");
  manifest.agent_interface.bytes_slim_json = Buffer.byteLength(slimJsonText);
  manifest.agent_interface.bytes_slim_ndjson = Buffer.byteLength(slimNdjson);
  manifest.agent_interface.slim_fields = Object.keys(slimEvents[0] || {});

  const agentsDescriptor = {
    agent_contract_version: SCHEMA_VERSION,
    generated_at: manifest.generated_at,
    festival_year: manifest.festival_year,
    purpose: "Agent-first SXSW schedule feed from official source",
    freshness,
    compatibility,
    identity,
    entrypoints: {
      llms_txt: "/llms.txt",
      website_home: "/index.html",
      schedule_index: "/schedule/index.html",
      robots: "/robots.txt",
      sitemap: "/sitemap.xml",
      slim_json: "/agent-schedule.v1.slim.json",
      slim_ndjson: "/agent-schedule.v1.slim.ndjson",
      slim_shards: "/events/by-date/*.slim.json",
      easy_json: "/agent-schedule.v1.json",
      easy_ndjson: "/agent-schedule.v1.ndjson",
      manifest: "/schedule.manifest.json",
      full_export_gzip: "/schedule.json.gz",
      schema: "/schema.json",
      shards: "/events/by-date/*.ndjson",
      changes: "/changes.ndjson",
      venues: "/entities/venues.v1.ndjson",
      contributors: "/entities/contributors.v1.ndjson"
    },
    recommended_ingestion_order: [
      "Read /schedule.manifest.json for schema version, freshness metadata, and hashes",
      "Fetch per-day slim JSON at /events/by-date/{date}.slim.json (~280-410 KB each) — best for most tool calls",
      "Read /agent-schedule.v1.slim.json for all events in one request (~2.5 MB) — if per-day is too granular",
      "Read /agent-schedule.v1.json for the full normalized feed (14 MB — only when all fields are needed)",
      "Read /changes.ndjson to apply tombstones and incremental updates",
      "Read /entities/venues.v1.ndjson and /entities/contributors.v1.ndjson for cross-event identity joins",
      "Use /events/by-date/*.ndjson for full-fidelity date-scoped streaming refreshes",
      "Use /schedule.json.gz only when complete raw snapshot fidelity is required"
    ],
    fetching_tips: [
      "Fetch JSON directly — do not route through reader proxies (e.g. r.jina.ai). They wrap responses in markdown and break JSON parsing.",
      "Per-day slim shards are best for tool calls: /events/by-date/2026-03-12.slim.json through 2026-03-18.slim.json",
      "All endpoints return Content-Type: application/json or application/x-ndjson — never HTML",
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
    dropped_fields_note: "These raw fields are not in the normalized agent feed. Access them via /schedule.json.gz.",
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
    path: `${OUTPUT_DIR}/prompts/index.html`,
    route: "/prompts/",
    content: renderPromptExamplesPage(manifest)
  });

  pageWrites.push({
    path: `${OUTPUT_DIR}/faq/index.html`,
    route: "/faq/",
    content: renderFaqPage(manifest)
  });

  pageWrites.push({
    path: `${OUTPUT_DIR}/changelog/index.html`,
    route: "/changelog/",
    content: renderChangelogPage(manifest, changeRecords)
  });

  pageWrites.push({
    path: `${OUTPUT_DIR}/stability/index.html`,
    route: "/stability/",
    content: renderStabilityPage(manifest)
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
      "/agent-schedule.v1.slim.json",
      "/agent-schedule.v1.slim.ndjson",
      "/agent-schedule.v1.json",
      "/agent-schedule.v1.ndjson",
      "/changes.ndjson",
      "/schema.json",
      "/entities/venues.v1.ndjson",
      "/entities/contributors.v1.ndjson",
      "/llms.txt"
    ])
    .sort();

  const venueNdjson = toNdjson(venueEntities);
  const contributorNdjson = toNdjson(contributorEntities);

  await Promise.all([
    writeFile(`${OUTPUT_DIR}/schedule.manifest.json`, JSON.stringify(manifest, null, 2) + "\n"),
    writeFile(`${OUTPUT_DIR}/agents.json`, JSON.stringify(agentsDescriptor, null, 2) + "\n"),
    writeFile(`${OUTPUT_DIR}/agent-schedule.v1.json`, agentJsonText),
    writeFile(`${OUTPUT_DIR}/agent-schedule.v1.ndjson`, agentNdjson),
    writeFile(`${OUTPUT_DIR}/agent-schedule.v1.slim.json`, slimJsonText),
    writeFile(`${OUTPUT_DIR}/agent-schedule.v1.slim.ndjson`, slimNdjson),
    writeFile(`${OUTPUT_DIR}/schema.json`, JSON.stringify(schema, null, 2) + "\n"),
    writeFile(`${OUTPUT_DIR}/schedule.json.gz`, gzippedFull),
    writeFile(`${OUTPUT_DIR}/changes.ndjson`, changesNdjson),
    writeFile(`${OUTPUT_DIR}/entities/venues.v1.ndjson`, venueNdjson),
    writeFile(`${OUTPUT_DIR}/entities/contributors.v1.ndjson`, contributorNdjson),
    writeFile(`${OUTPUT_DIR}/robots.txt`, renderRobotsTxt()),
    writeFile(`${OUTPUT_DIR}/sitemap.xml`, renderSitemapXml(sitemapPaths, generatedAt)),
    writeFile(`${OUTPUT_DIR}/llms.txt`, renderLlmsTxt(manifest, dateSummaries))
  ]);

  await mapWithConcurrency(pageWrites, 32, async (page) => {
    await writeFile(page.path, page.content);
  });

  console.log(
    `Done. Wrote ${OUTPUT_DIR}/schedule pages (${pageWrites.length} files), data manifest, and ${shardSummaries.length} shard files.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
