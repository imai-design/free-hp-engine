import assert from "node:assert/strict";
import test from "node:test";
import type { D1Database, D1PreparedStatement, ApplicationRow } from "../src/domain/applications.ts";
import { hashIp, recordApplication, toCsv } from "../src/domain/applications.ts";
import { handleRequest } from "../src/index.ts";

class MemoryKv {
  values = new Map<string, string>();
  ttls = new Map<string, number | undefined>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.values.set(key, value);
    this.ttls.set(key, options?.expirationTtl);
  }

  async list(options: { prefix: string; limit?: number }): Promise<{ keys: Array<{ name: string }> }> {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(options.prefix))
      .sort()
      .slice(0, options.limit ?? 1_000)
      .map((name) => ({ name }));
    return { keys };
  }
}

/**
 * applications.ts / adminRateLimit.ts が要求する最小限のD1インターフェースだけを実装するモック。実DBは呼ばない。
 * admin_attempts向けのINSERT/COUNTだけはSQL文字列で見分けて別配列で扱う（他のINSERTと混ざらないように）。
 * 実際のSQLite制約（UNIQUE等）そのものはここでは検証しない＝tests/dbConstraints.test.ts が実DB(node:sqlite)で担当する。
 */
class MockStatement implements D1PreparedStatement {
  db: MockD1;
  sql: string;
  values: unknown[];

  constructor(db: MockD1, sql: string, values: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new MockStatement(this.db, this.sql, values);
  }

  async run(): Promise<unknown> {
    if (this.db.failInsert) throw new Error("mock insert failure");
    if (/INSERT INTO admin_attempts/u.test(this.sql)) {
      const [ipHash, ts] = this.values as [string, number];
      this.db.adminAttempts.push({ ipHash, ts });
      return {};
    }
    this.db.inserted.push({ sql: this.sql, values: this.values });
    return {};
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    if (this.db.failQuery) throw new Error("mock query failure");
    if (/FROM admin_attempts/u.test(this.sql)) {
      const [ipHash, windowStartMs] = this.values as [string, number];
      const count = this.db.adminAttempts.filter((attempt) => attempt.ipHash === ipHash && attempt.ts >= windowStartMs).length;
      return { results: [{ count }] as unknown as T[] };
    }
    return { results: this.db.rows as unknown as T[] };
  }
}

class MockD1 implements D1Database {
  inserted: Array<{ sql: string; values: unknown[] }> = [];
  rows: ApplicationRow[] = [];
  adminAttempts: Array<{ ipHash: string; ts: number }> = [];
  failInsert = false;
  failQuery = false;

  prepare(sql: string): D1PreparedStatement {
    return new MockStatement(this, sql);
  }
}

const validInput = {
  storeName: "喫茶かえる",
  industry: "飲食店",
  catchphrase: "三代つづく、町の定食屋",
  description: "季節の食材を使ったごはんを、ゆっくり楽しめる小さな喫茶店です。",
  colorTheme: "あたたかい",
  phone: "03-1234-5678",
};

const generated = {
  subheadline: "飲食店として、町の毎日に寄り添う一皿を届けます。",
  aboutText: "喫茶かえるは、季節の食材を使ったごはんを楽しめる小さな喫茶店です。",
  highlights: ["季節の食材", "ゆっくりできる空間"],
  closingText: "飲食店 喫茶かえるで、皆さまをお待ちしています。",
};

const stubProvider = async () => generated;

function generateRequest(body: unknown = validInput): Request {
  return new Request("https://free-hp-engine.example.workers.dev/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://freehp.jp", "CF-Connecting-IP": "198.51.100.10" },
    body: JSON.stringify(body),
  });
}

function baseEnv(overrides: Record<string, unknown> = {}) {
  return { SITES: new MemoryKv(), PUBLIC_BASE_URL: "https://free-hp-engine.example.workers.dev", ...overrides };
}

test("handleGenerate: 成功時にapplicationsへINSERTする(kind=site)", async () => {
  const db = new MockD1();
  const response = await handleRequest(generateRequest(), baseEnv({ DB: db }), { generate: stubProvider });
  assert.equal(response.status, 200);
  assert.equal(db.inserted.length, 1);
  assert.match(db.inserted[0].sql, /INSERT INTO applications/u);
  const [, kind, slug, , storeName] = db.inserted[0].values as string[];
  assert.equal(kind, "site");
  assert.ok(slug);
  assert.equal(storeName, "喫茶かえる");
});

test("handleGenerate: DB未設定でも生成は成功する(applications記録はスキップ)", async () => {
  const response = await handleRequest(generateRequest(), baseEnv(), { generate: stubProvider });
  assert.equal(response.status, 200);
});

test("handleGenerate: applicationsへのINSERTが失敗しても生成レスポンスは200のまま", async () => {
  const db = new MockD1();
  db.failInsert = true;
  const response = await handleRequest(generateRequest(), baseEnv({ DB: db }), { generate: stubProvider });
  assert.equal(response.status, 200);
  const result = await response.json() as { url: string };
  assert.match(result.url, /^https:\/\//u);
});

test("handleSample: 成功時にkind=sample・partner_keyつきでINSERTする", async () => {
  const db = new MockD1();
  const request = new Request("https://free-hp-engine.example.workers.dev/api/sample", {
    method: "POST",
    headers: { "content-type": "application/json", "x-batch-key": "batch-secret" },
    body: JSON.stringify(validInput),
  });
  const response = await handleRequest(request, baseEnv({ DB: db, BATCH_KEY: "batch-secret" }), { generate: stubProvider });
  assert.equal(response.status, 200);
  assert.equal(db.inserted.length, 1);
  const values = db.inserted[0].values as unknown[];
  const kindIndex = 1;
  assert.equal(values[kindIndex], "sample");
});

test("handleDomainRequest: 成功時にkind=domain_requestでINSERTする", async () => {
  const db = new MockD1();
  const domainInput = {
    storeName: "喫茶かえる",
    siteUrl: "https://free-hp-engine.example.workers.dev/s/kissa-kaeru",
    domains: ["kissa-kaeru.com"],
    contactName: "山田 太郎",
    email: "taro@example.com",
    method: "self",
    agree: true,
  };
  const request = new Request("https://free-hp-engine.example.workers.dev/api/domain-request", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://freehp.jp", "CF-Connecting-IP": "198.51.100.30" },
    body: JSON.stringify(domainInput),
  });
  const response = await handleRequest(
    request,
    baseEnv({ DB: db }),
    { fetch: async () => new Response(null, { status: 404 }) },
  );
  assert.equal(response.status, 200);
  assert.equal(db.inserted.length, 1);
  const values = db.inserted[0].values as unknown[];
  assert.equal(values[1], "domain_request");
  assert.equal(values[2], "kissa-kaeru"); // siteUrlから拾ったslug
});

function adminRequest(query: string): Request {
  return new Request(`https://free-hp-engine.example.workers.dev/api/admin/applications${query}`);
}

test("admin: ADMIN_KEY未設定なら404で経路を隠す", async () => {
  const response = await handleRequest(adminRequest("?key=anything"), baseEnv({ DB: new MockD1() }));
  assert.equal(response.status, 404);
});

test("admin: keyが一致しなければ401", async () => {
  const response = await handleRequest(adminRequest("?key=wrong"), baseEnv({ DB: new MockD1(), ADMIN_KEY: "correct-key" }));
  assert.equal(response.status, 401);
});

test("admin: DB未設定なら503", async () => {
  const response = await handleRequest(adminRequest("?key=correct-key"), baseEnv({ ADMIN_KEY: "correct-key" }));
  assert.equal(response.status, 503);
});

test("admin: 既定でCSV(UTF-8 BOM・日本語ヘッダー)を返す", async () => {
  const db = new MockD1();
  db.rows = [{
    id: 1,
    created_at: "2026-08-17T00:00:00.000Z",
    kind: "site",
    status: "new",
    slug: "kissa-kaeru",
    public_url: "https://free-hp-engine.example.workers.dev/s/kissa-kaeru",
    store_name: "喫茶かえる",
    business_type: "飲食店",
    catchcopy: "三代つづく、町の定食屋",
    description: "説明文",
    mood: "あたたかい",
    phone: "03-1234-5678",
    address: null,
    hours: null,
    menu_text: null,
    reserve_url: null,
    instagram: null,
    line_official: null,
    has_photo: 0,
    owner_email: "taro@example.com",
    partner_key: null,
    partner_key_hash: null,
    extra_json: null,
    note: null,
  }];
  const response = await handleRequest(adminRequest("?key=correct-key"), baseEnv({ DB: db, ADMIN_KEY: "correct-key" }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/csv/u);
  // .text()はUTF-8デコード時に先頭のBOMを取り除く仕様(WHATWG Encoding Standard)なので、
  // BOMが実際に送出されているかは生バイト列で確かめる。
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = await response.text();
  assert.match(text, /作成日時/u);
  assert.match(text, /喫茶かえる/u);
});

test("admin: format=jsonでJSONを返す", async () => {
  const db = new MockD1();
  const response = await handleRequest(adminRequest("?key=correct-key&format=json"), baseEnv({ DB: db, ADMIN_KEY: "correct-key" }));
  assert.equal(response.status, 200);
  const result = await response.json() as { items: unknown[] };
  assert.deepEqual(result.items, []);
});

test("admin: sinceが不正な値なら422", async () => {
  const response = await handleRequest(adminRequest("?key=correct-key&since=not-a-date"), baseEnv({ DB: new MockD1(), ADMIN_KEY: "correct-key" }));
  assert.equal(response.status, 422);
});

test("admin: 鍵の総当たりは同一IPからのレート制限で頭打ちになる", async () => {
  const store = new MemoryKv();
  const env = baseEnv({ SITES: store, DB: new MockD1(), ADMIN_KEY: "correct-key" });
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    lastResponse = await handleRequest(adminRequest("?key=wrong"), env);
  }
  assert.equal(lastResponse?.status, 429);
});

test("admin: Authorization: Bearer ヘッダーが正式な渡し方で、非推奨警告は付かない", async () => {
  const db = new MockD1();
  const request = new Request(`https://free-hp-engine.example.workers.dev/api/admin/applications?format=json`, {
    headers: { authorization: "Bearer correct-key" },
  });
  const response = await handleRequest(request, baseEnv({ DB: db, ADMIN_KEY: "correct-key" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-deprecated-auth"), null);
});

test("admin: ?key= でも従来どおり動くが、後方互換の警告ヘッダーX-Deprecated-Authが付く", async () => {
  const db = new MockD1();
  const response = await handleRequest(adminRequest("?key=correct-key&format=json"), baseEnv({ DB: db, ADMIN_KEY: "correct-key" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-deprecated-auth"), "query");
});

test("admin: Authorizationヘッダーと?key=の両方があればヘッダーを優先する", async () => {
  const db = new MockD1();
  const request = new Request(`https://free-hp-engine.example.workers.dev/api/admin/applications?key=wrong&format=json`, {
    headers: { authorization: "Bearer correct-key" },
  });
  const response = await handleRequest(request, baseEnv({ DB: db, ADMIN_KEY: "correct-key" }));
  assert.equal(response.status, 200, "?keyが間違っていてもAuthorizationヘッダーが正しければ通る");
  assert.equal(response.headers.get("x-deprecated-auth"), null);
});

test("admin: failed=1 でD1保存に失敗しKVへ退避した申込の件数だけを返す(内容は返さない)", async () => {
  const store = new MemoryKv();
  await store.put("dbfail:2026-08-18T00:00:00.000Z:slug-a", JSON.stringify({ storeName: "非公開の店名" }));
  await store.put("dbfail:2026-08-18T00:01:00.000Z:slug-b", JSON.stringify({ storeName: "もう1件" }));
  const response = await handleRequest(
    adminRequest("?key=correct-key&failed=1"),
    baseEnv({ SITES: store, DB: new MockD1(), ADMIN_KEY: "correct-key" }),
  );
  assert.equal(response.status, 200);
  const result = await response.json() as { failedCount: number };
  assert.equal(result.failedCount, 2);
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /非公開の店名/u, "件数のみでPIIそのものは含めない");
});

test("recordApplication: D1への保存が失敗したら、内容をKVへ dbfail: プレフィックスで退避する", async () => {
  const store = new MemoryKv();
  const db = new MockD1();
  db.failInsert = true;
  const ok = await recordApplication(
    db,
    { createdAt: "2026-08-18T00:00:00.000Z", kind: "site", slug: "failed-slug", storeName: "退避されるべき店", hasPhoto: false },
    store,
  );
  assert.equal(ok, false);
  const keys = [...store.values.keys()].filter((key) => key.startsWith("dbfail:"));
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^dbfail:2026-08-18T00:00:00\.000Z:failed-slug$/u);
  const saved = JSON.parse(store.values.get(keys[0]) ?? "{}") as { storeName?: string };
  assert.equal(saved.storeName, "退避されるべき店");
});

test("toCsv: カンマ・改行・ダブルクォートを含む値はRFC4180形式でクォートする", () => {
  const csv = toCsv([{
    id: 1,
    created_at: "2026-08-17T00:00:00.000Z",
    kind: "site",
    status: "new",
    slug: null,
    public_url: null,
    store_name: '店名,"かえる"\n2号店',
    business_type: null,
    catchcopy: null,
    description: null,
    mood: null,
    phone: null,
    address: null,
    hours: null,
    menu_text: null,
    reserve_url: null,
    instagram: null,
    line_official: null,
    has_photo: 1,
    owner_email: null,
    partner_key: null,
    partner_key_hash: null,
    extra_json: null,
    note: null,
  }]);
  assert.match(csv, /"店名,""かえる""\n2号店"/u);
  assert.match(csv, /あり/u);
});

test("toCsv: 先頭が = + - @ タブの値はExcelで数式として実行されないようシングルクォートを足す(CSVインジェクション対策)", () => {
  const row: ApplicationRow = {
    id: 1,
    created_at: "2026-08-17T00:00:00.000Z",
    kind: "site",
    status: "new",
    slug: null,
    public_url: null,
    store_name: null,
    business_type: null,
    catchcopy: null,
    description: null,
    mood: null,
    phone: null,
    address: null,
    hours: null,
    menu_text: null,
    reserve_url: null,
    instagram: null,
    line_official: null,
    has_photo: 0,
    owner_email: null,
    partner_key: null,
    partner_key_hash: null,
    extra_json: null,
    note: null,
  };
  // ("@SUM(1,1)"のようにカンマを含む値はRFC4180クォートの区切りと混ざるため、ここではカンマを含まない値だけで検証する。
  const dangerous = ['=HYPERLINK("http://evil.example")', "+1+1", "-1", "@SUM(1;1)", "\tcmd"];
  for (const value of dangerous) {
    const csv = toCsv([{ ...row, note: value }]);
    const noteCell = csv.trim().split("\r\n")[1].split(",").pop() ?? "";
    assert.ok(noteCell.replace(/^"|"$/gu, "").startsWith("'"), `${JSON.stringify(value)} should be neutralized, got ${noteCell}`);
  }
  // 通常のメモはそのまま(先頭にシングルクォートを足さない)。
  const safe = toCsv([{ ...row, note: "普通のメモ" }]);
  assert.match(safe, /,普通のメモ\r\n$/u);
});

test("hashIp: 同じ入力からは同じハッシュ、別入力からは別ハッシュを返す(先頭16桁)", async () => {
  const a = await hashIp("198.51.100.10");
  const b = await hashIp("198.51.100.10");
  const c = await hashIp("198.51.100.11");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 16);
  assert.match(a, /^[0-9a-f]{16}$/u);
});
