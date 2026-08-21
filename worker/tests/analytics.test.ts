import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Database, D1PreparedStatement } from "../src/domain/applications.ts";
import { statsAccessKey } from "../src/domain/analytics.ts";
import { renderSite } from "../src/domain/render.ts";
import { handleRequest } from "../src/index.ts";

type SqliteModule = typeof import("node:sqlite");
let sqliteModule: SqliteModule | undefined;
try {
  sqliteModule = await import("node:sqlite");
} catch {
  sqliteModule = undefined;
}

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(dirname, "..", "migrations");

class MemoryKv {
  private readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.values.set(key, value); }
}

function wrapAsD1(db: InstanceType<SqliteModule["DatabaseSync"]>): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      const statement = (bound: unknown[]): D1PreparedStatement => ({
        bind(...values: unknown[]): D1PreparedStatement { return statement(values); },
        async run(): Promise<unknown> { return db.prepare(sql).run(...(bound as never[])); },
        async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
          return { results: db.prepare(sql).all(...(bound as never[])) as T[] };
        },
      });
      return statement([]);
    },
  };
}

function createDatabase(): { raw: InstanceType<SqliteModule["DatabaseSync"]>; d1: D1Database } {
  if (!sqliteModule) throw new Error("node:sqlite unavailable");
  const raw = new sqliteModule.DatabaseSync(":memory:");
  for (const file of fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    raw.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  return { raw, d1: wrapAsD1(raw) };
}

function env(db?: D1Database, adminKey?: string) {
  return { SITES: new MemoryKv(), DB: db, ADMIN_KEY: adminKey };
}

function beat(body: unknown, init: { method?: string; userAgent?: string; cf?: Record<string, unknown> } = {}): Request {
  const request = new Request("https://engine.example/api/beat", {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", "user-agent": init.userAgent ?? "Desktop" },
    body: init.method === "GET" ? undefined : JSON.stringify(body),
  });
  if (init.cf) Object.defineProperty(request, "cf", { value: init.cf });
  return request;
}

if (!sqliteModule) {
  test("analytics: node:sqliteが使えないためスキップ", { skip: true }, () => {});
} else {
  test("beat: 不正入力は400、POST以外は405、1KB超は413", async () => {
    const { d1 } = createDatabase();
    for (const body of [
      { slug: "BAD!", sid: "abcdefgh", type: "pv" },
      { slug: "valid-slug", sid: "short", type: "pv" },
      { slug: "valid-slug", sid: "abcdefgh", type: "other" },
    ]) {
      assert.equal((await handleRequest(beat(body), env(d1))).status, 400);
    }
    assert.equal((await handleRequest(beat({}, { method: "GET" }), env(d1))).status, 405);
    const large = beat({ slug: "valid-slug", sid: "abcdefgh", type: "pv", ref: "x".repeat(1100) });
    assert.equal((await handleRequest(large, env(d1))).status, 413);
  });

  test("beat: PVをUPSERTして回数・匿名化した位置・端末・参照元を保存する", async () => {
    const { raw, d1 } = createDatabase();
    const first = Date.parse("2026-08-21T01:00:00.000Z");
    const body = { slug: "kissa-kaeru", sid: "abcdefgh12345678", type: "pv", ref: "https://example.com/from?q=secret" };
    const request = beat(body, {
      userAgent: "Mozilla Mobile Safari",
      cf: { country: "JP", city: "渋谷区", region: "東京都", latitude: "35.658", longitude: 139.702 },
    });
    assert.equal((await handleRequest(request, env(d1), { now: () => first })).status, 204);
    assert.equal((await handleRequest(beat(body), env(d1), { now: () => first + 1000 })).status, 204);
    const rows = raw.prepare("SELECT * FROM visits").all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pv_count, 2);
    assert.equal(rows[0].first_seen, first);
    assert.equal(rows[0].last_seen, first + 1000);
    assert.equal(rows[0].ref_host, "example.com");
    assert.equal(rows[0].path, "/s/kissa-kaeru");
    assert.equal(rows[0].device, "mobile");
    assert.equal(rows[0].lat, 35.7);
    assert.equal(rows[0].lon, 139.7);
    assert.ok(!Object.hasOwn(rows[0], "ip"));
  });

  test("beat: tel/mapイベントを記録し、訪問の最終時刻を進める", async () => {
    const { raw, d1 } = createDatabase();
    const now = Date.parse("2026-08-21T03:00:00.000Z");
    const base = { slug: "kissa-kaeru", sid: "abcdefgh12345678" };
    await handleRequest(beat({ ...base, type: "pv" }), env(d1), { now: () => now });
    await handleRequest(beat({ ...base, type: "tel" }), env(d1), { now: () => now + 1000 });
    await handleRequest(beat({ ...base, type: "map" }), env(d1), { now: () => now + 2000 });
    const events = raw.prepare("SELECT type FROM events ORDER BY id").all() as Array<{ type: string }>;
    assert.deepEqual(events.map((row) => row.type), ["tel", "map"]);
    const visit = raw.prepare("SELECT last_seen FROM visits").get() as { last_seen: number };
    assert.equal(visit.last_seen, now + 2000);
  });

  test("beat: 初回がbeatでも訪問行を作り、PVは加算しない", async () => {
    const { raw, d1 } = createDatabase();
    const now = Date.parse("2026-08-21T04:00:00.000Z");
    const response = await handleRequest(beat({ slug: "kissa-kaeru", sid: "abcdefgh12345678", type: "beat" }), env(d1), { now: () => now });
    assert.equal(response.status, 204);
    const visit = raw.prepare("SELECT day, pv_count FROM visits").get() as { day: string; pv_count: number };
    assert.equal(visit.day, "2026-08-21");
    assert.equal(visit.pv_count, 0);
  });

  test("beat: JST午前0時を境に日付行を分ける", async () => {
    const { raw, d1 } = createDatabase();
    const body = { slug: "kissa-kaeru", sid: "abcdefgh12345678", type: "pv" };
    await handleRequest(beat(body), env(d1), { now: () => Date.parse("2026-08-20T14:59:59.999Z") });
    await handleRequest(beat(body), env(d1), { now: () => Date.parse("2026-08-20T15:00:00.000Z") });
    const rows = raw.prepare("SELECT day FROM visits ORDER BY day").all() as Array<{ day: string }>;
    assert.deepEqual(rows.map((row) => row.day), ["2026-08-20", "2026-08-21"]);
  });

  test("stats: HMAC鍵が正しければHTML/JSONを返し、不一致と未設定は404", async () => {
    const { d1 } = createDatabase();
    const secret = "test-admin-secret";
    const key = await statsAccessKey(secret, "kissa-kaeru");
    const pageUrl = `https://engine.example/s/kissa-kaeru/stats?k=${key}`;
    const page = await handleRequest(new Request(pageUrl), env(d1, secret));
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    const inlineScript = pageHtml.match(/<script>([\s\S]*)<\/script>/u)?.[1];
    assert.ok(inlineScript);
    assert.doesNotThrow(() => new Function(inlineScript));
    assert.equal((await handleRequest(new Request("https://engine.example/s/kissa-kaeru/stats?k=wrong"), env(d1, secret))).status, 404);
    assert.equal((await handleRequest(new Request(pageUrl), env(d1))).status, 404);
    const api = await handleRequest(new Request(`https://engine.example/api/stats?slug=kissa-kaeru&k=${key}`), env(d1, secret));
    assert.equal(api.status, 200);
  });

  test("stats: 今日・期間・ライブ・時間帯・内訳を集計する", async () => {
    const { d1 } = createDatabase();
    const secret = "test-admin-secret";
    const now = Date.parse("2026-08-21T01:30:00.000Z");
    const first = { slug: "kissa-kaeru", sid: "aaaaaaaa11111111", path: "/s/kissa-kaeru" };
    const second = { slug: "kissa-kaeru", sid: "bbbbbbbb22222222", path: "/s/kissa-kaeru" };
    await handleRequest(beat({ ...first, type: "pv", ref: "https://search.example/result" }, { cf: { country: "JP", city: "新宿区", region: "東京都", latitude: 35.69, longitude: 139.7 } }), env(d1), { now: () => now - 1000 });
    await handleRequest(beat({ ...first, type: "pv" }), env(d1), { now: () => now - 500 });
    await handleRequest(beat({ ...first, type: "tel" }), env(d1), { now: () => now - 400 });
    await handleRequest(beat({ ...second, type: "pv" }), env(d1), { now: () => now - 300 });
    await handleRequest(beat({ ...second, type: "map" }), env(d1), { now: () => now - 200 });

    const key = await statsAccessKey(secret, "kissa-kaeru");
    const response = await handleRequest(new Request(`https://engine.example/api/stats?slug=kissa-kaeru&k=${key}`), env(d1, secret), { now: () => now });
    const stats = await response.json() as Record<string, any>;
    assert.equal(stats.online, 2);
    assert.equal(stats.live.length, 2);
    assert.equal(stats.live[0].sid.length, 6);
    assert.equal(stats.live.find((item: Record<string, unknown>) => item.city === "新宿区").lat, 35.7);
    assert.deepEqual(stats.today, { pv: 3, visitors: 2, tel: 1, map: 1 });
    assert.deepEqual(stats.last7, stats.today);
    assert.deepEqual(stats.last30, stats.today);
    assert.equal(stats.hourly[10], 2);
    assert.equal(stats.daily.length, 30);
    assert.deepEqual(stats.refs, [{ host: "search.example", count: 1 }]);
    assert.equal(stats.devices.pc, 2);
    assert.deepEqual(stats.regions, [{ city: "新宿区", count: 1 }]);
  });
}

test("beacon.js: キャッシュ、sid、PV、30秒beat、電話・地図イベントを含む", async () => {
  const response = await handleRequest(new Request("https://engine.example/beacon.js"), env());
  const script = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
  assert.match(script, /fh_sid_/u);
  assert.match(script, /send\('pv'/u);
  assert.match(script, /30000/u);
  assert.match(script, /send\('tel'\)/u);
  assert.match(script, /send\('map'\)/u);
});

test("renderSite: beacon scriptをbody末尾に注入しCSPでself通信だけを許可する", () => {
  const html = renderSite({
    storeName: "喫茶かえる",
    industry: "飲食店",
    catchphrase: "町の喫茶店",
    description: "季節の飲み物を提供する喫茶店です。",
    colorTheme: "あたたかい",
  }, {
    subheadline: "町の日々に寄り添います。",
    aboutText: "落ち着いて過ごせる喫茶店です。",
    highlights: ["季節の飲み物"],
    closingText: "ご来店をお待ちしています。",
  });
  assert.match(html, /script-src 'self'; connect-src 'self'/u);
  assert.match(html, /<script src="\/beacon\.js" defer><\/script>\s*<\/body>/u);
});
