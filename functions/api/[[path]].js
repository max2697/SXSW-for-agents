/**
 * SXSW 2026 Schedule API — Cloudflare Worker
 *
 * Serves filtered query results from the static slim JSON feed hosted on
 * the same Cloudflare Pages origin. Agents never need to download bulk data.
 *
 * Endpoints:
 *   GET /api/events?date=&category=&venue=&type=&contributor=&q=&limit=&offset=
 *   GET /api/events/{event_id}
 *   GET /api/dates
 *   GET /api/venues?name=
 *   GET /api/categories
 *   GET /api/contributors?name=
 *   GET /api/openapi.json
 */

const ORIGIN = "https://sxsw.0fn.net";
const SLIM_JSON_URL = `${ORIGIN}/agent-schedule.v1.slim.json`;
const CACHE_TTL = 300; // seconds — matches Pages Cache-Control

// ---------------------------------------------------------------------------
// Cache: load slim JSON once per Worker isolate lifetime (~minutes)
// ---------------------------------------------------------------------------
let _cache = null;
let _cacheExpiry = 0;

async function getEvents(env) {
  const now = Date.now();
  if (_cache && now < _cacheExpiry) return _cache;

  const res = await fetch(SLIM_JSON_URL, {
    headers: { "Accept": "application/json" },
    cf: { cacheEverything: true, cacheTtl: CACHE_TTL }
  });
  if (!res.ok) throw new Error(`Failed to fetch slim feed: ${res.status}`);
  const data = await res.json();
  _cache = data.events || [];
  _cacheExpiry = now + CACHE_TTL * 1000;
  return _cache;
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
  return (str || "").toLowerCase().trim();
}

function matches(haystack, needle) {
  if (!needle) return true;
  return normalize(haystack).includes(normalize(needle));
}

function paginate(arr, limit, offset) {
  const total = arr.length;
  const items = arr.slice(offset, offset + limit);
  return { total, offset, limit, count: items.length, results: items };
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
  const limit       = Math.min(parseInt(p.get("limit") || "50", 10), 200);
  const offset      = Math.max(parseInt(p.get("offset") || "0", 10), 0);

  const events = await getEvents(env);

  const results = events.filter(e => {
    if (date && e.date !== date) return false;
    if (type && e.event_type !== type) return false;
    if (category && !matches(e.category, category)) return false;
    if (venue && !matches(e.venue?.name, venue)) return false;
    if (contributor) {
      const hit = (e.contributors || []).some(c => matches(c.name, contributor));
      if (!hit) return false;
    }
    if (q) {
      const blob = [e.name, e.category, e.venue?.name, e.event_type,
                    ...(e.contributors || []).map(c => c.name)].join(" ");
      if (!matches(blob, q)) return false;
    }
    return true;
  });

  return json(paginate(results, limit, offset));
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
    paths: {
      "/events": {
        get: {
          operationId: "searchEvents",
          summary: "Search and filter events",
          description: "Returns events matching all supplied filters. All params are optional and combinable. Results are paginated (default 50, max 200).",
          parameters: [
            { name: "date", in: "query", schema: { type: "string", example: "2026-03-14" }, description: "Festival date (YYYY-MM-DD). One of: 2026-03-12 through 2026-03-18." },
            { name: "category", in: "query", schema: { type: "string", example: "AI" }, description: "Partial match on category name (case-insensitive)." },
            { name: "venue", in: "query", schema: { type: "string", example: "Hilton" }, description: "Partial match on venue name (case-insensitive)." },
            { name: "type", in: "query", schema: { type: "string", enum: ["panel","showcase","screening","networking","party","activation","exhibition","comedy_event","lounge","special_event","registration"] }, description: "Exact match on event_type." },
            { name: "contributor", in: "query", schema: { type: "string", example: "Carmen Simon" }, description: "Partial match on contributor/speaker/artist name." },
            { name: "q", in: "query", schema: { type: "string" }, description: "Full-text search across event name, category, venue, and contributor names." },
            { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 }, description: "Max results to return." },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 }, description: "Pagination offset." },
          ],
          responses: {
            "200": {
              description: "Matching events",
              content: { "application/json": { schema: { "$ref": "#/components/schemas/EventList" } } },
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
      "/dates": {
        get: {
          operationId: "getDates",
          summary: "List all festival dates with event counts",
          responses: { "200": { description: "Date list" } },
        },
      },
      "/venues": {
        get: {
          operationId: "getVenues",
          summary: "List venues, optionally filtered by name",
          parameters: [{ name: "name", in: "query", schema: { type: "string", example: "Hilton" }, description: "Partial match on venue name." }],
          responses: { "200": { description: "Venue list with event counts" } },
        },
      },
      "/categories": {
        get: {
          operationId: "getCategories",
          summary: "List all event categories with counts",
          responses: { "200": { description: "Category list" } },
        },
      },
      "/contributors": {
        get: {
          operationId: "searchContributors",
          summary: "Find speakers, artists, or performers by name",
          parameters: [{ name: "name", in: "query", required: true, schema: { type: "string", example: "Carmen Simon" }, description: "Partial match on contributor name." }],
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
