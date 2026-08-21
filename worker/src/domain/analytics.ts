import type { D1Database } from "./applications.ts";
import { tokyoDateKey } from "./userQuota.ts";

const SLUG_PATTERN = /^[a-z0-9-]{4,80}$/u;
const SID_PATTERN = /^[a-z0-9]{8,32}$/u;
const BEAT_TYPES = new Set(["pv", "beat", "tel", "map"] as const);
const MAX_BODY_BYTES = 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export type BeatType = "pv" | "beat" | "tel" | "map";

export interface BeatInput {
  slug: string;
  sid: string;
  type: BeatType;
  ref: string;
}

interface CloudflareRequest extends Request {
  cf?: {
    country?: unknown;
    city?: unknown;
    region?: unknown;
    latitude?: unknown;
    longitude?: unknown;
  };
}

export interface LiveVisitor {
  sid: string;
  path: string;
  city: string;
  country: string;
  device: "mobile" | "pc";
  last_seen: number;
  lat: number | null;
  lon: number | null;
  region: string;
}

export interface StatsSummary {
  pv: number;
  visitors: number;
  tel: number;
  map: number;
}

export interface AnalyticsStats {
  online: number;
  live: LiveVisitor[];
  today: StatsSummary;
  last7: StatsSummary;
  last30: StatsSummary;
  hourly: number[];
  daily: Array<{ day: string; visitors: number; pv: number }>;
  refs: Array<{ host: string; count: number }>;
  devices: { mobile: number; pc: number };
  regions: Array<{ city: string; count: number }>;
}

function textValue(value: unknown, maxLength = 100): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function coordinate(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 10) / 10 : null;
}

function refHost(ref: string): string {
  if (!ref) return "";
  try {
    return new URL(ref).hostname.toLowerCase().slice(0, 253);
  } catch {
    return "";
  }
}

export function validateBeatInput(raw: unknown): BeatInput | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.slug !== "string" || !SLUG_PATTERN.test(data.slug)) return null;
  if (typeof data.sid !== "string" || !SID_PATTERN.test(data.sid)) return null;
  if (typeof data.type !== "string" || !BEAT_TYPES.has(data.type as BeatType)) return null;
  if (data.ref !== undefined && typeof data.ref !== "string") return null;
  return {
    slug: data.slug,
    sid: data.sid,
    type: data.type as BeatType,
    ref: textValue(data.ref, 2048),
  };
}

async function requestTextWithinLimit(request: Request): Promise<string | null> {
  const statedLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(statedLength) && statedLength > MAX_BODY_BYTES) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).byteLength <= MAX_BODY_BYTES ? text : null;
}

const UPSERT_VISIT_SQL = `INSERT INTO visits (
  slug, sid, day, first_seen, last_seen, path, ref_host, device,
  country, city, lat, lon, region, pv_count
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(slug, sid, day) DO UPDATE SET
  last_seen = excluded.last_seen,
  path = excluded.path,
  pv_count = visits.pv_count + excluded.pv_count`;

export async function handleBeat(request: Request, db: D1Database | undefined, now = Date.now()): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8", allow: "POST" },
    });
  }
  const text = await requestTextWithinLimit(request);
  if (text === null) return new Response(JSON.stringify({ error: "request is too large" }), { status: 413 });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({ error: "invalid request" }), { status: 400 });
  }
  const input = validateBeatInput(raw);
  if (!input) return new Response(JSON.stringify({ error: "invalid request" }), { status: 400 });
  if (!db) return new Response(JSON.stringify({ error: "analytics unavailable" }), { status: 503 });

  const cf = (request as CloudflareRequest).cf;
  const userAgent = request.headers.get("user-agent") ?? "";
  const values = [
    input.slug,
    input.sid,
    tokyoDateKey(now),
    now,
    now,
    `/s/${input.slug}`,
    input.type === "pv" ? refHost(input.ref) : "",
    /Mobile/iu.test(userAgent) ? "mobile" : "pc",
    textValue(cf?.country, 8),
    textValue(cf?.city, 100),
    coordinate(cf?.latitude),
    coordinate(cf?.longitude),
    textValue(cf?.region, 100),
    input.type === "pv" ? 1 : 0,
  ];

  try {
    if (input.type === "pv" || input.type === "beat") {
      await db.prepare(UPSERT_VISIT_SQL).bind(...values).run();
    } else {
      await db.prepare("INSERT INTO events (slug, sid, day, type, ts) VALUES (?,?,?,?,?)")
        .bind(input.slug, input.sid, tokyoDateKey(now), input.type, now)
        .run();
      await db.prepare("UPDATE visits SET last_seen = ?, path = ? WHERE slug = ? AND sid = ? AND day = ?")
        .bind(now, `/s/${input.slug}`, input.slug, input.sid, tokyoDateKey(now))
        .run();
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("[analytics] write failed", error instanceof Error ? error.message : String(error));
    return new Response(JSON.stringify({ error: "analytics unavailable" }), { status: 503 });
  }
}

export const BEACON_SCRIPT = String.raw`(()=>{try{
  const m=location.pathname.match(/^\/s\/([a-z0-9-]{4,80})(?:\/|$)/);if(!m)return;
  const jst=new Date(Date.now()+32400000).toISOString().slice(0,10);
  const key='fh_sid_'+jst;let sid=localStorage.getItem(key);
  if(!sid){const a=new Uint8Array(16);crypto.getRandomValues(a);const chars='abcdefghijklmnopqrstuvwxyz0123456789';sid=Array.from(a,n=>chars[n%chars.length]).join('');localStorage.setItem(key,sid)}
  const send=(type,ref='')=>{try{const body=JSON.stringify({slug:m[1],sid,type,ref});let sent=false;try{if(navigator.sendBeacon)sent=navigator.sendBeacon('/api/beat',new Blob([body],{type:'application/json'}))}catch{}if(!sent)fetch('/api/beat',{method:'POST',headers:{'content-type':'application/json'},body,keepalive:true}).catch(()=>{})}catch{}};
  send('pv',document.referrer);
  setInterval(()=>{if(document.visibilityState==='visible')send('beat')},30000);
  document.addEventListener('click',e=>{try{const a=e.target instanceof Element?e.target.closest('a'):null;if(!a)return;const href=a.getAttribute('href')||'';if(href.startsWith('tel:'))send('tel');else if(href.includes('google.')&&href.includes('maps'))send('map')}catch{}});
}catch{}})();`;

export function beaconResponse(): Response {
  return new Response(BEACON_SCRIPT, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}

function daysBefore(day: string, count: number): string {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(start - count * DAY_MS).toISOString().slice(0, 10);
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function summary(db: D1Database, slug: string, startDay: string): Promise<StatsSummary> {
  const visits = await db.prepare(`SELECT COALESCE(SUM(pv_count), 0) AS pv, COUNT(DISTINCT sid) AS visitors
    FROM visits WHERE slug = ? AND day >= ?`).bind(slug, startDay).all<{ pv: number; visitors: number }>();
  const events = await db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN type = 'tel' THEN 1 ELSE 0 END), 0) AS tel,
    COALESCE(SUM(CASE WHEN type = 'map' THEN 1 ELSE 0 END), 0) AS map
    FROM events WHERE slug = ? AND day >= ?`).bind(slug, startDay).all<{ tel: number; map: number }>();
  return {
    pv: numberValue(visits.results[0]?.pv),
    visitors: numberValue(visits.results[0]?.visitors),
    tel: numberValue(events.results[0]?.tel),
    map: numberValue(events.results[0]?.map),
  };
}

export async function getAnalyticsStats(db: D1Database, slug: string, now = Date.now()): Promise<AnalyticsStats> {
  const today = tokyoDateKey(now);
  const day7 = daysBefore(today, 6);
  const day30 = daysBefore(today, 29);
  const onlineSince = now - 5 * 60 * 1000;

  const [onlineRows, liveRows, todaySummary, last7Summary, last30Summary, hourlyRows, dailyRows, refRows, deviceRows, regionRows] = await Promise.all([
    db.prepare("SELECT COUNT(DISTINCT sid) AS count FROM visits WHERE slug = ? AND last_seen >= ?")
      .bind(slug, onlineSince).all<{ count: number }>(),
    db.prepare(`SELECT sid, path, city, country, device, last_seen, lat, lon, region
      FROM visits WHERE slug = ? AND last_seen >= ? ORDER BY last_seen DESC LIMIT 40`)
      .bind(slug, onlineSince).all<LiveVisitor>(),
    summary(db, slug, today),
    summary(db, slug, day7),
    summary(db, slug, day30),
    db.prepare(`SELECT CAST(strftime('%H', first_seen / 1000, 'unixepoch', '+9 hours') AS INTEGER) AS hour,
      COUNT(DISTINCT sid) AS visitors FROM visits WHERE slug = ? AND day = ? GROUP BY hour ORDER BY hour`)
      .bind(slug, today).all<{ hour: number; visitors: number }>(),
    db.prepare("SELECT day, COUNT(DISTINCT sid) AS visitors, COALESCE(SUM(pv_count), 0) AS pv FROM visits WHERE slug = ? AND day >= ? GROUP BY day ORDER BY day")
      .bind(slug, day30).all<{ day: string; visitors: number; pv: number }>(),
    db.prepare("SELECT ref_host AS host, COUNT(*) AS count FROM visits WHERE slug = ? AND day >= ? AND ref_host <> '' GROUP BY ref_host ORDER BY count DESC LIMIT 10")
      .bind(slug, day30).all<{ host: string; count: number }>(),
    db.prepare("SELECT device, COUNT(*) AS count FROM visits WHERE slug = ? AND day >= ? GROUP BY device")
      .bind(slug, day30).all<{ device: string; count: number }>(),
    db.prepare("SELECT city, COUNT(*) AS count FROM visits WHERE slug = ? AND day >= ? AND city <> '' GROUP BY city ORDER BY count DESC LIMIT 10")
      .bind(slug, day30).all<{ city: string; count: number }>(),
  ]);

  const seen = new Set<string>();
  const live = liveRows.results.filter((visitor) => {
    if (seen.has(visitor.sid) || seen.size >= 20) return false;
    seen.add(visitor.sid);
    return true;
  }).map((visitor) => ({
    ...visitor,
    sid: visitor.sid.slice(0, 6),
    last_seen: numberValue(visitor.last_seen),
    lat: visitor.lat == null ? null : numberValue(visitor.lat),
    lon: visitor.lon == null ? null : numberValue(visitor.lon),
  }));

  const hourly = Array<number>(24).fill(0);
  for (const row of hourlyRows.results) if (row.hour >= 0 && row.hour < 24) hourly[row.hour] = numberValue(row.visitors);

  const dailyByDay = new Map(dailyRows.results.map((row) => [row.day, row]));
  const daily = Array.from({ length: 30 }, (_, index) => {
    const day = daysBefore(today, 29 - index);
    const row = dailyByDay.get(day);
    return { day, visitors: numberValue(row?.visitors), pv: numberValue(row?.pv) };
  });

  const devices = { mobile: 0, pc: 0 };
  for (const row of deviceRows.results) if (row.device === "mobile" || row.device === "pc") devices[row.device] = numberValue(row.count);

  return {
    online: numberValue(onlineRows.results[0]?.count),
    live,
    today: todaySummary,
    last7: last7Summary,
    last30: last30Summary,
    hourly,
    daily,
    refs: refRows.results.map((row) => ({ host: row.host, count: numberValue(row.count) })),
    devices,
    regions: regionRows.results.map((row) => ({ city: row.city, count: numberValue(row.count) })),
  };
}

export async function statsAccessKey(adminKey: string, slug: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(adminKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`stats:${slug}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export function constantTimeEqual(actual: string | null, expected: string): boolean {
  const left = actual ?? "";
  if (left.length > 64) return false;
  const length = Math.max(left.length, expected.length);
  let difference = left.length ^ expected.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}
