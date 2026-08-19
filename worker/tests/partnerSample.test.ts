import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../src/index.ts";

class MemoryKv {
  values = new Map<string, string>();
  ttls = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.values.set(key, value);
    if (options?.expirationTtl !== undefined) this.ttls.set(key, options.expirationTtl);
  }
}

const validInput = {
  storeName: "喫茶かえる",
  industry: "飲食店",
  catchphrase: "三代つづく、町の定食屋",
  description: "季節の食材を使ったごはんを、ゆっくり楽しめる小さな喫茶店です。",
  colorTheme: "あたたかい",
};

const generated = {
  subheadline: "飲食店として、町の毎日に寄り添う一皿を届けます。",
  aboutText: "喫茶かえるは、季節の食材を使ったごはんを楽しめる小さな喫茶店です。",
  highlights: ["季節の食材", "ゆっくりできる空間"],
  closingText: "飲食店 喫茶かえるで、皆さまをお待ちしています。",
};

const stubProvider = async () => generated;
const PARTNER_KEY = "partner-secret-key";
const NOW = Date.UTC(2026, 7, 7, 3, 0, 0);
const FOURTEEN_DAYS = 60 * 60 * 24 * 14;

function sampleRequest(key: string): Request {
  return new Request("https://example.com/api/sample", {
    method: "POST",
    headers: { "content-type": "application/json", "x-batch-key": key },
    body: JSON.stringify(validInput),
  });
}

function testEnv(store: MemoryKv, batchKey?: string) {
  return {
    SITES: store,
    BATCH_KEY: batchKey,
    PUBLIC_BASE_URL: "https://free-hp-engine.example.workers.dev",
  };
}

test("有効なパートナー鍵でmap見本を生成でき、作成者記録を14日保存する", async () => {
  const store = new MemoryKv();
  await store.put(`partner:${PARTNER_KEY}`, JSON.stringify({ name: "かえるパートナー", active: true }));

  const response = await handleRequest(sampleRequest(PARTNER_KEY), testEnv(store), {
    generate: stubProvider,
    now: () => NOW,
  });

  assert.equal(response.status, 200);
  const { slug } = await response.json() as { slug: string };
  assert.ok(await store.get(`site:${slug}`));
  assert.deepEqual(JSON.parse(await store.get(`partner_site:${slug}`) as string), {
    key: PARTNER_KEY,
    name: "かえるパートナー",
    at: "2026-08-07T03:00:00.000Z",
  });
  assert.equal(store.ttls.get(`partner_site:${slug}`), FOURTEEN_DAYS);
});

test("active:false のパートナー鍵は401", async () => {
  const store = new MemoryKv();
  await store.put(`partner:${PARTNER_KEY}`, JSON.stringify({ name: "停止中パートナー", active: false }));

  const response = await handleRequest(sampleRequest(PARTNER_KEY), testEnv(store), { generate: stubProvider });

  assert.equal(response.status, 401);
  assert.equal([...store.values.keys()].some((key) => key.startsWith("site:")), false);
});

test("存在しないパートナー鍵は401", async () => {
  const store = new MemoryKv();

  const response = await handleRequest(sampleRequest("missing-partner-key"), testEnv(store), { generate: stubProvider });

  assert.equal(response.status, 401);
  assert.equal([...store.values.keys()].some((key) => key.startsWith("site:")), false);
});

test("パートナー生成のたびに月次件数をインクリメントする", async () => {
  const store = new MemoryKv();
  await store.put(`partner:${PARTNER_KEY}`, JSON.stringify({ name: "かえるパートナー", active: true }));
  const context = { generate: stubProvider, now: () => NOW };

  assert.equal((await handleRequest(sampleRequest(PARTNER_KEY), testEnv(store), context)).status, 200);
  assert.equal((await handleRequest(sampleRequest(PARTNER_KEY), testEnv(store), context)).status, 200);

  assert.equal(await store.get(`partner_count:${PARTNER_KEY}:2026-08`), "2");
});

test("従来のBATCH_KEYもパートナー登録なしで引き続き通る", async () => {
  const store = new MemoryKv();
  const batchKey = "original-batch-key";

  const response = await handleRequest(sampleRequest(batchKey), testEnv(store, batchKey), { generate: stubProvider });

  assert.equal(response.status, 200);
  assert.equal([...store.values.keys()].some((key) => key.startsWith("partner_count:")), false);
  assert.equal([...store.values.keys()].some((key) => key.startsWith("partner_site:")), false);
});
