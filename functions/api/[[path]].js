/**
 * SXSW 2026 Schedule API — Cloudflare Worker
 *
 * Serves filtered query results from the static slim JSON feed hosted on
 * the same Cloudflare Pages origin. Agents never need to download bulk data.
 *
 * Endpoints:
 *   GET /api/events?date=&category=&venue=&type=&contributor=&q=&q_mode=&limit=&offset=
 *   GET /api/events/{event_id}
 *   GET /api/shortlist?topic=&per_day=
 *   GET /api/health
 *   GET /api/dates
 *   GET /api/venues?name=
 *   GET /api/categories
 *   GET /api/contributors?name=
 *   GET /api/openapi.json
 */

const ORIGIN = "https://sxsw.0fn.net";
const SLIM_JSON_URL = `${ORIGIN}/agent-schedule.v1.slim.json`;
const CACHE_TTL = 300; // seconds — matches Pages Cache-Control
const QUERY_MODES = new Set(["any", "all", "phrase"]);

const SYNONYM_GROUPS = [
  ["ai", ["ai", "llm", "genai", "gpt", "ml"]],
  ["developer", ["developer", "developers", "dev", "engineer", "engineering", "software", "coder", "coding", "programmer", "programming"]],
  ["tooling", ["tooling", "tool", "tools", "sdk", "framework", "frameworks", "platform", "platforms", "stack", "workflow", "workflows", "ide"]],
  ["agent", ["agent", "agents", "agentic", "assistant", "assistants"]],
  ["api", ["api", "apis"]],
  ["infrastructure", ["infrastructure", "infra", "devops", "mlops", "deployment", "deploy"]],
];

const TOKEN_CANONICAL = Object.fromEntries(
  SYNONYM_GROUPS.flatMap(([canonical, variants]) => [
    [canonical, canonical],
    ...variants.map((variant) => [variant, canonical]),
  ])
);

const TOPIC_PRESETS = {
  "ai-developer-tooling": {
    slug: "ai-developer-tooling",
    primary_query: "AI developer tooling",
    primary_mode: "any",
    fallback_query: "AI",
    fallback_mode: "any",
    ranking_terms: [
      "developer",
      "tooling",
      "agent",
      "api",
      "platform",
      "engineering",
      "software",
      "code",
      "coding",
      "llm",
      "infrastructure",
      "devops",
      "mlops",
      "sdk",
      "framework",
    ],
  },
};

// ---------------------------------------------------------------------------
// Cache: load slim JSON once per Worker isolate lifetime (~minutes)
// ---------------------------------------------------------------------------
let _cache = null;
let _cacheMeta = null;
let _cacheExpiry = 0;

async function getSnapshot(env) {
  const now = Date.now();
  if (_cache && _cacheMeta && now < _cacheExpiry) {
    return { events: _cache, ..._cacheMeta };
  }

  const res = await fetch(SLIM_JSON_URL, {
    headers: { "Accept": "application/json" },
    cf: { cacheEverything: true, cacheTtl: CACHE_TTL }
  });
  if (!res.ok) throw new Error(`Failed to fetch slim feed: ${res.status}`);
  const data = await res.json();
  _cache = data.events || [];
  _cacheMeta = {
    festival_year: data.festival_year || 2026,
    event_count: data.event_count || _cache.length,
    index_timestamp: data.generated_at || null,
  };
  _cacheExpiry = now + CACHE_TTL * 1000;
  return { events: _cache, ..._cacheMeta };
}

async function getEvents(env) {
  return (await getSnapshot(env)).events;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
    },
  });
}

function error(message, status = 400) {
  return json({ error: message, status }, status);
}

function normalize(str) {
  return String(str || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function matches(haystack, needle) {
  if (!needle) return true;
  return normalize(haystack).includes(normalize(needle));
}

function tokenize(str) {
  const parts = normalize(str).match(/[a-z0-9]+/g);
  return parts || [];
}

function canonicalizeToken(token) {
  return TOKEN_CANONICAL[token] || token;
}

function canonicalizeText(str) {
  return tokenize(str).map(canonicalizeToken).join(" ");
}

function parsePositiveInt(raw, fallback, maxValue = Number.POSITIVE_INFINITY) {
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maxValue);
}

function parseNonNegativeInt(raw, fallback) {
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function paginate(arr, limit, offset) {
  const total = arr.length;
  const items = arr.slice(offset, offset + limit);
  return { total, offset, limit, count: items.length, results: items };
}

function buildSearchIndex(event) {
  const fields = {
    name: normalize(event.name),
    category: normalize(event.category),
    venue: normalize(event.venue?.name),
    event_type: normalize(event.event_type),
    contributors: normalize((event.contributors || []).map((c) => c?.name || "").join(" ")),
  };

  const tokensByField = {};
  for (const [field, value] of Object.entries(fields)) {
    tokensByField[field] = new Set(tokenize(value).map(canonicalizeToken));
  }

  const rawBlob = Object.values(fields).join(" ").trim();
  const canonicalBlob = Object.values(fields)
    .map((value) => canonicalizeText(value))
    .join(" ")
    .trim();

  return { fields, tokensByField, rawBlob, canonicalBlob };
}

function scoreTokenMatches(index, queryTokens) {
  const weights = {
    name: 5,
    contributors: 4,
    category: 2,
    venue: 2,
    event_type: 2,
  };

  const matchedTerms = [];
  const matchedFields = new Set();
  let score = 0;

  for (const token of queryTokens) {
    const hitFields = [];
    for (const [field, fieldTokens] of Object.entries(index.tokensByField)) {
      if (fieldTokens.has(token)) {
        hitFields.push(field);
        matchedFields.add(field);
        score += weights[field] || 1;
      }
    }
    if (hitFields.length > 0) {
      matchedTerms.push(token);
    }
  }

  score += matchedTerms.length;
  return {
    score,
    matched_terms: matchedTerms,
    matched_fields: [...matchedFields].sort(),
  };
}

function analyzeQuery(event, query, qMode) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return { matches: true, score: 0, matched_terms: [], matched_fields: [] };
  }

  const index = buildSearchIndex(event);
  const queryTokens = [...new Set(tokenize(normalizedQuery).map(canonicalizeToken))];

  if (qMode === "phrase") {
    const rawMatch = index.rawBlob.includes(normalizedQuery);
    const canonicalQuery = canonicalizeText(normalizedQuery);
    const canonicalMatch = canonicalQuery ? index.canonicalBlob.includes(canonicalQuery) : false;
    if (!rawMatch && !canonicalMatch) {
      return { matches: false, score: 0, matched_terms: [], matched_fields: [] };
    }
    const scored = scoreTokenMatches(index, queryTokens);
    return {
      matches: true,
      score: scored.score + 4,
      matched_terms: scored.matched_terms,
      matched_fields: scored.matched_fields,
    };
  }

  const scored = scoreTokenMatches(index, queryTokens);
  if (qMode === "all" && scored.matched_terms.length !== queryTokens.length) {
    return { matches: false, score: 0, matched_terms: [], matched_fields: [] };
  }
  if (qMode === "any" && scored.matched_terms.length === 0) {
    return { matches: false, score: 0, matched_terms: [], matched_fields: [] };
  }

  if (qMode === "all") {
    scored.score += 3;
  }

  return { matches: true, ...scored };
}

function searchSort(a, b) {
  const scoreA = a.meta?.score || 0;
  const scoreB = b.meta?.score || 0;
  if (scoreB !== scoreA) return scoreB - scoreA;
  const startA = String(a.event.start_time || "");
  const startB = String(b.event.start_time || "");
  if (startA !== startB) return startA.localeCompare(startB);
  return String(a.event.event_id || "").localeCompare(String(b.event.event_id || ""));
}

function shortlistBoost(event, rankingTerms) {
  const name = normalize(event.name);
  const blob = normalize(
    [
      event.name,
      event.category,
      event.event_type,
      event.venue?.name,
      ...(event.contributors || []).map((c) => c?.name),
    ].join(" ")
  );

  let boost = 0;
  for (const term of rankingTerms || []) {
    const normalizedTerm = normalize(term);
    if (!normalizedTerm) continue;
    if (name.includes(normalizedTerm)) {
      boost += 3;
    } else if (blob.includes(normalizedTerm)) {
      boost += 1;
    }
  }

  if (event.event_type === "panel") boost += 2;
  return boost;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET /api/events */
async function handleEvents(url, env) {
  const p = url.searchParams;
  const date        = p.get("date");        // "2026-03-14"
  const category    = p.get("category");    // partial match
  const venue       = p.get("venue");       // partial match on venue name
  const type        = p.get("type");        // exact: panel, showcase, screening …
  const contributor = p.get("contributor"); // partial match on contributor name
  const q           = p.get("q");           // full-text across name + category + venue
  const qMode       = normalize(p.get("q_mode") || "any");
  const limit       = parsePositiveInt(p.get("limit"), 50, 200);
  const offset      = parseNonNegativeInt(p.get("offset"), 0);

  if (!QUERY_MODES.has(qMode)) {
    return error("Invalid q_mode. Use one of: any, all, phrase", 400);
  }

  const events = await getEvents(env);
  const hits = [];

  for (const e of events) {
    if (date && e.date !== date) continue;
    if (type && e.event_type !== type) continue;
    if (category && !matches(e.category, category)) continue;
    if (venue && !matches(e.venue?.name, venue)) continue;
    if (contributor) {
      const hit = (e.contributors || []).some(c => matches(c.name, contributor));
      if (!hit) continue;
    }

    let meta = null;
    if (q) {
      meta = analyzeQuery(e, q, qMode);
      if (!meta.matches) continue;
    }

    hits.push({ event: e, meta });
  }

  if (q) {
    hits.sort(searchSort);
  }

  const results = hits.map(({ event, meta }) => {
    if (!meta) return event;
    return {
      ...event,
      score: meta.score,
      matched_terms: meta.matched_terms,
      matched_fields: meta.matched_fields,
    };
  });

  return json(paginate(results, limit, offset));
}

/** GET /api/shortlist?topic=&per_day= */
async function handleShortlist(url, env) {
  const topicRaw = normalize(url.searchParams.get("topic") || "ai-developer-tooling");
  const perDay = parsePositiveInt(url.searchParams.get("per_day"), 5, 20);
  const preset = TOPIC_PRESETS[topicRaw] || {
    slug: topicRaw || "custom",
    primary_query: (topicRaw || "ai").replace(/-/g, " "),
    primary_mode: "any",
    fallback_query: "AI",
    fallback_mode: "any",
    ranking_terms: ["developer", "tooling", "agent", "api", "platform", "code", "llm", "infrastructure"],
  };

  const snapshot = await getSnapshot(env);
  const events = snapshot.events;
  const dates = [...new Set(events.map((e) => e.date).filter((d) => d && d !== "unknown"))].sort();
  const days = [];

  for (const date of dates) {
    const dayEvents = events.filter((e) => e.date === date);
    let usedQuery = preset.primary_query;
    let usedMode = preset.primary_mode;
    let hits = dayEvents
      .map((event) => ({ event, meta: analyzeQuery(event, preset.primary_query, preset.primary_mode) }))
      .filter((row) => row.meta.matches);

    if (hits.length === 0 && preset.fallback_query) {
      usedQuery = preset.fallback_query;
      usedMode = preset.fallback_mode || "any";
      hits = dayEvents
        .map((event) => ({ event, meta: analyzeQuery(event, usedQuery, usedMode) }))
        .filter((row) => row.meta.matches);
    }

    hits = hits
      .map((row) => ({
        ...row,
        rank_score: row.meta.score + shortlistBoost(row.event, preset.ranking_terms),
      }))
      .sort((a, b) => {
        if (b.rank_score !== a.rank_score) return b.rank_score - a.rank_score;
        return searchSort(a, b);
      });

    const top = hits.slice(0, perDay).map((row) => ({
      event_id: row.event.event_id,
      name: row.event.name,
      date: row.event.date,
      start_time: row.event.start_time,
      end_time: row.event.end_time,
      event_type: row.event.event_type,
      category: row.event.category,
      venue: row.event.venue,
      official_url: row.event.official_url,
      score: row.rank_score,
      matched_terms: row.meta.matched_terms,
      matched_fields: row.meta.matched_fields,
    }));

    days.push({
      date,
      query_used: usedQuery,
      q_mode_used: usedMode,
      total_candidates: hits.length,
      count: top.length,
      results: top,
    });
  }

  return json({
    topic: preset.slug,
    topic_label: topicRaw,
    per_day: perDay,
    festival_year: snapshot.festival_year || 2026,
    index_timestamp: snapshot.index_timestamp,
    generated_at: new Date().toISOString(),
    days,
  });
}

/** GET /api/health */
async function handleHealth(env) {
  const snapshot = await getSnapshot(env);
  return json({
    status: "ok",
    service: "sxsw-2026-schedule-api",
    festival_year: snapshot.festival_year || 2026,
    event_count: snapshot.events.length,
    index_timestamp: snapshot.index_timestamp,
    cache_ttl_seconds: CACHE_TTL,
    source_feed: SLIM_JSON_URL,
    now: new Date().toISOString(),
  });
}

/** GET /api/events/:id */
async function handleEventById(id, env) {
  const events = await getEvents(env);
  const event = events.find(e => e.event_id === id);
  if (!event) return error(`Event not found: ${id}`, 404);
  return json(event);
}

/** GET /api/dates */
async function handleDates(env) {
  const events = await getEvents(env);
  const counts = {};
  for (const e of events) {
    const d = e.date || "unknown";
    counts[d] = (counts[d] || 0) + 1;
  }
  const dates = Object.entries(counts)
    .filter(([d]) => d !== "unknown")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, event_count]) => ({
      date,
      event_count,
      slim_shard: `/events/by-date/${date}.slim.json`,
      full_shard: `/events/by-date/${date}.ndjson`,
    }));
  return json({ festival_year: 2026, dates });
}

/** GET /api/venues?name= */
async function handleVenues(url, env) {
  const name = url.searchParams.get("name");
  const events = await getEvents(env);
  const map = new Map();
  for (const e of events) {
    if (!e.venue?.name) continue;
    if (!map.has(e.venue.id)) {
      map.set(e.venue.id, { ...e.venue, event_count: 0 });
    }
    map.get(e.venue.id).event_count++;
  }
  let venues = [...map.values()].sort((a, b) => b.event_count - a.event_count);
  if (name) venues = venues.filter(v => matches(v.name, name));
  return json({ total: venues.length, venues });
}

/** GET /api/categories */
async function handleCategories(env) {
  const events = await getEvents(env);
  const counts = {};
  for (const e of events) {
    if (e.category) counts[e.category] = (counts[e.category] || 0) + 1;
  }
  const categories = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([category, event_count]) => ({ category, event_count }));
  return json({ total: categories.length, categories });
}

/** GET /api/contributors?name= */
async function handleContributors(url, env) {
  const name = url.searchParams.get("name");
  if (!name) return error("name param required. Example: ?name=carmen+simon");
  const events = await getEvents(env);
  const map = new Map();
  for (const e of events) {
    for (const c of e.contributors || []) {
      if (!c.name || !matches(c.name, name)) continue;
      if (!map.has(c.name)) map.set(c.name, { name: c.name, type: c.type, events: [] });
      map.get(c.name).events.push({
        event_id: e.event_id,
        name: e.name,
        date: e.date,
        start_time: e.start_time,
        venue: e.venue?.name,
      });
    }
  }
  const contributors = [...map.values()].sort((a, b) => b.events.length - a.events.length);
  return json({ total: contributors.length, contributors });
}

/** GET /api/openapi.json */
function handleOpenApi(url) {
  const base = `${url.protocol}//${url.host}`;
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "SXSW 2026 Schedule API",
      description: "Query the SXSW 2026 festival schedule. All 2790 events across March 12–18, 2026. Data refreshed daily from schedule.sxsw.com.",
      version: "1.0.0",
      "x-agents-json": `${base}/agents.json`,
      "x-llms-txt": `${base}/llms.txt`,
    },
    servers: [{ url: `${base}/api`, description: "SXSW 2026 Schedule API" }],
    "x-example-urls": [
      `${base}/api/health`,
      `${base}/api/dates`,
      `${base}/api/events?date=2026-03-14&q=AI&q_mode=any&limit=50`,
      `${base}/api/events?date=2026-03-14&q=AI+developer+tooling&q_mode=all&limit=50`,
      `${base}/api/shortlist?topic=ai-developer-tooling&per_day=5`,
    ],
    paths: {
      "/events": {
        get: {
          operationId: "searchEvents",
          summary: "Search and filter events",
          description: "Returns events matching all supplied filters. All params optional and combinable. NOTE: 'category' is a format label (Panel, Rock, Mentor Session, etc.) — use 'q' for topic search. q_mode controls token behavior (any/all/phrase). Results paginated (default 50, max 200).",
          parameters: [
            { name: "date", in: "query", schema: { type: "string", example: "2026-03-14" }, description: "Festival date (YYYY-MM-DD). One of: 2026-03-12 through 2026-03-18." },
            { name: "category", in: "query", schema: { type: "string", example: "Mentor Session" }, description: "Partial match on category (case-insensitive). Category is a format label: Panel, Rock, Mentor Session, Presentation, Documentary Feature, etc. Use /api/categories for the full list. Use 'q' for topic-based search." },
            { name: "venue", in: "query", schema: { type: "string", example: "Hilton" }, description: "Partial match on venue name (case-insensitive)." },
            { name: "type", in: "query", schema: { type: "string", enum: ["panel","showcase","screening","networking","party","activation","exhibition","comedy_event","lounge","special_event","registration"] }, description: "Exact match on event_type." },
            { name: "contributor", in: "query", schema: { type: "string", example: "Carmen Simon" }, description: "Partial match on contributor/speaker/artist name." },
            { name: "q", in: "query", schema: { type: "string", example: "artificial intelligence developer tooling" }, description: "Full-text search across event name, category, venue, and contributor names. Tokenized with synonym normalization." },
            { name: "q_mode", in: "query", schema: { type: "string", enum: ["any", "all", "phrase"], default: "any" }, description: "Search mode: any token, all tokens, or phrase match." },
            { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 }, description: "Max results to return." },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 }, description: "Pagination offset." },
          ],
          "x-agent-example-url": `${base}/api/events?date=2026-03-14&q=AI&q_mode=any&limit=50`,
          responses: {
            "200": {
              description: "Matching events",
              content: {
                "application/json": {
                  schema: { "$ref": "#/components/schemas/EventList" },
                  examples: {
                    aiAny: {
                      summary: "Broad AI topic search",
                      value: {
                        total: 48,
                        offset: 0,
                        limit: 50,
                        count: 50,
                        results: [
                          {
                            event_id: "PP1162244",
                            name: "The New Lab Partner: AI and Future Scientific Discovery",
                            date: "2026-03-14",
                            event_type: "panel",
                            official_url: "https://schedule.sxsw.com/2026/events/PP1162244",
                            score: 11,
                            matched_terms: ["ai"],
                            matched_fields: ["name"],
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/shortlist": {
        get: {
          operationId: "getShortlist",
          summary: "Get ranked top sessions per day for a topic",
          description: "Single-call endpoint optimized for agent workflows. Returns ranked sessions by day with event_id and official_url in each item.",
          parameters: [
            { name: "topic", in: "query", schema: { type: "string", example: "ai-developer-tooling", default: "ai-developer-tooling" }, description: "Preset topic slug. Unknown values are treated as custom topic text." },
            { name: "per_day", in: "query", schema: { type: "integer", default: 5, maximum: 20 }, description: "Number of sessions to return per date." },
          ],
          "x-agent-example-url": `${base}/api/shortlist?topic=ai-developer-tooling&per_day=5`,
          responses: {
            "200": {
              description: "Ranked daily shortlist",
              content: { "application/json": { schema: { "$ref": "#/components/schemas/ShortlistResponse" } } },
            },
          },
        },
      },
      "/events/{event_id}": {
        get: {
          operationId: "getEvent",
          summary: "Get a single event by ID",
          parameters: [{ name: "event_id", in: "path", required: true, schema: { type: "string", example: "PP1162244" } }],
          responses: {
            "200": { description: "Event object", content: { "application/json": { schema: { "$ref": "#/components/schemas/Event" } } } },
            "404": { description: "Not found" },
          },
        },
      },
      "/health": {
        get: {
          operationId: "getHealth",
          summary: "Health and index freshness info",
          description: "Returns service health, current event count, and index timestamp from the latest loaded slim feed.",
          "x-agent-example-url": `${base}/api/health`,
          responses: {
            "200": { description: "Health status", content: { "application/json": { schema: { "$ref": "#/components/schemas/HealthResponse" } } } },
          },
        },
      },
      "/dates": {
        get: {
          operationId: "getDates",
          summary: "List all festival dates with event counts",
          "x-agent-example-url": `${base}/api/dates`,
          responses: { "200": { description: "Date list" } },
        },
      },
      "/venues": {
        get: {
          operationId: "getVenues",
          summary: "List venues, optionally filtered by name",
          parameters: [{ name: "name", in: "query", schema: { type: "string", example: "Hilton" }, description: "Partial match on venue name." }],
          "x-agent-example-url": `${base}/api/venues?name=Hilton`,
          responses: { "200": { description: "Venue list with event counts" } },
        },
      },
      "/categories": {
        get: {
          operationId: "getCategories",
          summary: "List all event categories with counts",
          "x-agent-example-url": `${base}/api/categories`,
          responses: { "200": { description: "Category list" } },
        },
      },
      "/contributors": {
        get: {
          operationId: "searchContributors",
          summary: "Find speakers, artists, or performers by name",
          parameters: [{ name: "name", in: "query", required: true, schema: { type: "string", example: "Carmen Simon" }, description: "Partial match on contributor name." }],
          "x-agent-example-url": `${base}/api/contributors?name=Carmen+Simon`,
          responses: { "200": { description: "Matching contributors with their events" } },
        },
      },
    },
    components: {
      schemas: {
        Event: {
          type: "object",
          properties: {
            event_id: { type: "string" },
            name: { type: "string" },
            date: { type: "string", format: "date" },
            start_time: { type: "string", format: "date-time", nullable: true },
            end_time: { type: "string", format: "date-time", nullable: true },
            event_type: { type: "string" },
            category: { type: "string", nullable: true },
            reservable: { type: "boolean" },
            official_url: { type: "string", format: "uri" },
            score: { type: "number", description: "Search relevance score (present when q is provided)." },
            matched_terms: { type: "array", items: { type: "string" }, description: "Canonical query terms matched for this event (present when q is provided)." },
            matched_fields: { type: "array", items: { type: "string" }, description: "Event fields where query matches were found (present when q is provided)." },
            credentials: { type: "array", items: { type: "object" } },
            status: { type: "string" },
            venue: {
              type: "object", nullable: true,
              properties: {
                id: { type: "string" }, name: { type: "string" },
                lat: { type: "number" }, lon: { type: "number" },
              },
            },
            contributors: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" }, type: { type: "string" } },
              },
            },
          },
        },
        EventList: {
          type: "object",
          properties: {
            total: { type: "integer" },
            offset: { type: "integer" },
            limit: { type: "integer" },
            count: { type: "integer" },
            results: { type: "array", items: { "$ref": "#/components/schemas/Event" } },
          },
        },
        ShortlistItem: {
          type: "object",
          properties: {
            event_id: { type: "string" },
            name: { type: "string" },
            date: { type: "string", format: "date" },
            start_time: { type: "string", format: "date-time", nullable: true },
            end_time: { type: "string", format: "date-time", nullable: true },
            event_type: { type: "string" },
            category: { type: "string", nullable: true },
            official_url: { type: "string", format: "uri" },
            score: { type: "number" },
            matched_terms: { type: "array", items: { type: "string" } },
            matched_fields: { type: "array", items: { type: "string" } },
          },
        },
        ShortlistDay: {
          type: "object",
          properties: {
            date: { type: "string", format: "date" },
            query_used: { type: "string" },
            q_mode_used: { type: "string" },
            total_candidates: { type: "integer" },
            count: { type: "integer" },
            results: { type: "array", items: { "$ref": "#/components/schemas/ShortlistItem" } },
          },
        },
        ShortlistResponse: {
          type: "object",
          properties: {
            topic: { type: "string" },
            topic_label: { type: "string" },
            per_day: { type: "integer" },
            festival_year: { type: "integer" },
            index_timestamp: { type: "string", format: "date-time", nullable: true },
            generated_at: { type: "string", format: "date-time" },
            days: { type: "array", items: { "$ref": "#/components/schemas/ShortlistDay" } },
          },
        },
        HealthResponse: {
          type: "object",
          properties: {
            status: { type: "string" },
            service: { type: "string" },
            festival_year: { type: "integer" },
            event_count: { type: "integer" },
            index_timestamp: { type: "string", format: "date-time", nullable: true },
            cache_ttl_seconds: { type: "integer" },
            source_feed: { type: "string", format: "uri" },
            now: { type: "string", format: "date-time" },
          },
        },
      },
    },
  };
  return json(spec);
}

// ---------------------------------------------------------------------------
// Router — Cloudflare Pages Functions export
// ---------------------------------------------------------------------------
export async function onRequest({ request, env }) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return error("Method not allowed", 405);
    }

    // Strip /api prefix — Pages Functions routes /api/* here
    const path = url.pathname.replace(/^\/api/, "").replace(/\/$/, "") || "/";

    try {
      // /api/openapi.json
      if (path === "/openapi.json") return handleOpenApi(url);

      // /api/dates
      if (path === "/dates") return handleDates(env);

      // /api/health
      if (path === "/health") return handleHealth(env);

      // /api/shortlist
      if (path === "/shortlist") return handleShortlist(url, env);

      // /api/categories
      if (path === "/categories") return handleCategories(env);

      // /api/venues
      if (path === "/venues") return handleVenues(url, env);

      // /api/contributors
      if (path === "/contributors") return handleContributors(url, env);

      // /api/events/:id
      const eventById = path.match(/^\/events\/([^/]+)$/);
      if (eventById) return handleEventById(decodeURIComponent(eventById[1]), env);

      // /api/events
      if (path === "/events" || path === "/events/") return handleEvents(url, env);

      return error(`Unknown endpoint: ${path}. See /api/openapi.json for available routes.`, 404);
    } catch (err) {
      console.error("API error:", err);
      return error("Internal server error", 500);
    }
}
