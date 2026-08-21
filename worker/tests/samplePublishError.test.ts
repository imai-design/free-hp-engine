import assert from "node:assert/strict";
import test from "node:test";
import type { D1Database, D1PreparedStatement } from "../src/domain/applications.ts";
import { handleRequest } from "../src/index.ts";

/**
 * handleSample（POST /api/sample）の「生成は成功したがKV/D1書き込みで落ちる」経路を再現するテスト群。
 * 本番で毎回503「公開処理に失敗しました。」になる不具合の原因切り分け用に、
 * catch{}を構造化ログ・detail付きレスポンスへ変更した実装（src/index.ts handleSample）を検証する。
 */

const validInput = {
  storeName: "喫茶かえる",
  industry: "飲食店",
  catchphrase: "三代つづく、町の定食屋",
  description: "季節の食材を使ったごはんを、ゆっくり楽しめる小さな喫茶店です。",
  colorTheme: "あたたかい",
  phone: "03-1234-5678",
  address: "東京都渋谷区道玄坂1-2-3",
  businessHours: "11:00〜18:00（水曜定休）",
};

const generated = {
  subheadline: "飲食店として、町の毎日に寄り添う一皿を届けます。",
  aboutText: "喫茶かえるは、季節の食材を使ったごはんを楽しめる小さな喫茶店です。",
  highlights: ["季節の食材", "ゆっくりできる空間"],
  closingText: "飲食店 喫茶かえるで、皆さまをお待ちしています。",
};

const stubProvider = async () => generated;
const BATCH_KEY = "correct-key";

function sampleRequest(body: unknown = validInput): Request {
  return new Request("https://example.com/api/sample", {
    method: "POST",
    headers: { "content-type": "application/json", "x-batch-key": BATCH_KEY },
    body: JSON.stringify(body),
  });
}

/** put()の挙動を差し替えられるKVモック。get/list/deleteは通常のMemoryKvと同じ。 */
class ConfigurableKv {
  values = new Map<string, string>();
  failOnKeyPrefix?: string;
  failError?: Error;
  /** get()が常に非nullを返すよう固定すると、createUniqueSlugが5回とも衝突扱いになり失敗する。 */
  alwaysCollide = false;

  async get(key: string): Promise<string | null> {
    if (this.alwaysCollide) return "collision";
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string, _options?: { expirationTtl?: number }): Promise<void> {
    if (this.failOnKeyPrefix && key.startsWith(this.failOnKeyPrefix) && this.failError) {
      throw this.failError;
    }
    this.values.set(key, value);
  }
}

function testEnv(store: ConfigurableKv, db?: D1Database) {
  return {
    SITES: store,
    BATCH_KEY,
    DB: db,
    PUBLIC_BASE_URL: "https://free-hp-engine.example.workers.dev",
  };
}

test("正常系: KV/D1がすべて成功すれば200でurl/slugを返し、エラー系フィールドを含まない", async () => {
  const store = new ConfigurableKv();
  const response = await handleRequest(sampleRequest(), testEnv(store), { generate: stubProvider });
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.match(body.url as string, /^https:\/\/free-hp-engine\.example\.workers\.dev\/s\//);
  assert.equal(Object.hasOwn(body, "step"), false);
  assert.equal(Object.hasOwn(body, "likely_cause"), false);
});

test("KVのput()がquota超過エラーを投げると503・step=put:site・likely_cause=kv_quotaを返し、ログに分類が出る", async () => {
  const store = new ConfigurableKv();
  store.failOnKeyPrefix = "site:";
  store.failError = new Error("KV PUT failed: 400 Bad Request: KV GET failed: KV quota exceeded for this account");

  const originalConsoleError = console.error;
  const logs: unknown[][] = [];
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const response = await handleRequest(sampleRequest(), testEnv(store), { generate: stubProvider });
    assert.equal(response.status, 503);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.error, "公開処理に失敗しました。");
    assert.equal(body.step, "put:site");
    assert.equal(body.likely_cause, "kv_quota");
    assert.match(body.detail as string, /quota/u);

    const publishLog = logs.find((entry) => entry[0] === "[handleSample] publish failed");
    assert.ok(publishLog, "構造化ログが出力されること");
    const detail = publishLog?.[1] as Record<string, unknown>;
    assert.equal(detail.step, "put:site");
    assert.equal(detail.likelyCause, "kv_quota");
  } finally {
    console.error = originalConsoleError;
  }
});

test("KVのput()が429 rate limitエラーを投げるとlikely_cause=kv_rate_limitを返す", async () => {
  const store = new ConfigurableKv();
  store.failOnKeyPrefix = "site:";
  store.failError = new Error("KV PUT failed: 429 Too Many Requests");

  const response = await handleRequest(sampleRequest(), testEnv(store), { generate: stubProvider });
  assert.equal(response.status, 503);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.likely_cause, "kv_rate_limit");
});

test("createUniqueSlugが5回とも衝突すると503・step=createUniqueSlugを返す", async () => {
  const store = new ConfigurableKv();
  store.alwaysCollide = true;

  const originalConsoleError = console.error;
  const logs: unknown[][] = [];
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const response = await handleRequest(sampleRequest(), testEnv(store), { generate: stubProvider });
    assert.equal(response.status, 503);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.step, "createUniqueSlug");
    assert.match(body.detail as string, /unique slug/u);

    const publishLog = logs.find((entry) => entry[0] === "[handleSample] publish failed");
    const detail = publishLog?.[1] as Record<string, unknown>;
    assert.equal(detail.step, "createUniqueSlug");
  } finally {
    console.error = originalConsoleError;
  }
});

test("D1のrecordApplicationが失敗しても、KV書き込みまで成功していれば200のまま（D1は503の原因になり得ない）", async () => {
  class FailingD1 implements D1Database {
    prepare(_sql: string): D1PreparedStatement {
      return {
        bind: () => ({
          bind: () => { throw new Error("should not rebind twice"); },
          run: async () => { throw new Error("mock D1 insert failure"); },
          all: async () => ({ results: [] }),
        }),
        run: async () => { throw new Error("mock D1 insert failure"); },
        all: async () => ({ results: [] }),
      };
    }
  }
  const store = new ConfigurableKv();

  const originalConsoleError = console.error;
  const logs: unknown[][] = [];
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const response = await handleRequest(sampleRequest(), testEnv(store, new FailingD1()), { generate: stubProvider });
    // recordApplication自身がtry/catchで例外を握りつぶす設計なので、D1が落ちてもhandleSampleのcatchには来ない。
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(Object.hasOwn(body, "step"), false);

    // ただしD1失敗自体は recordApplication 内部でログされている（[recordApplication] insert failed）。
    const recordLog = logs.find((entry) => entry[0] === "[recordApplication] insert failed");
    assert.ok(recordLog, "recordApplication内部のログが出力されること");
  } finally {
    console.error = originalConsoleError;
  }
});
