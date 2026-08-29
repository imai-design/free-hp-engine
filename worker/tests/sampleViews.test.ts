import assert from "node:assert/strict";
import test from "node:test";
import { getSampleViews, recordSampleView } from "../src/domain/sampleViews.ts";
import { handleRequest } from "../src/index.ts";

class MemoryKv {
  values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
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

const SAMPLE_HTML = '<html><head><meta name="robots" content="noindex,nofollow"></head><body data-freehp-sample="true"></body></html>';
const SITE_HTML = "<html><body></body></html>";

test("recordSampleView: 同じslug+日付は加算、別日付は別カウント", async () => {
  const kv = new MemoryKv();
  const day1 = Date.UTC(2026, 7, 27, 3, 0, 0);
  const day2 = Date.UTC(2026, 7, 28, 3, 0, 0);
  await recordSampleView(kv, "torikichi-yakitori", day1);
  await recordSampleView(kv, "torikichi-yakitori", day1);
  await recordSampleView(kv, "torikichi-yakitori", day2);

  const result = await getSampleViews(kv, "torikichi-yakitori");
  assert.equal(result?.views, 3);
  assert.equal(result?.byDate.length, 2);
});

test("recordSampleView: storeが未設定なら何もしない（例外を投げない）", async () => {
  await assert.doesNotReject(recordSampleView(undefined, "torikichi-yakitori"));
});

test("getSampleViews: 不正slugや未計測はnull/0件", async () => {
  const kv = new MemoryKv();
  assert.equal(await getSampleViews(kv, "AB"), null);
  const result = await getSampleViews(kv, "no-such-slug-xxxx");
  assert.equal(result?.views, 0);
});

function env(sites: Map<string, string> = new Map(), views = new MemoryKv(), batchKey = "correct-key") {
  const SITES = {
    async get(key: string) {
      return sites.get(key) ?? null;
    },
  };
  return { SITES, SAMPLE_VIEWS: views, BATCH_KEY: batchKey };
}

test("GET /s/{slug}: 見本配信のたびにSAMPLE_VIEWSへ記帳する", async () => {
  const sites = new Map([["site:torikichi", SAMPLE_HTML]]);
  const views = new MemoryKv();
  const response = await handleRequest(new Request("https://example.com/s/torikichi"), env(sites, views));
  assert.equal(response.status, 200);
  await response.text();

  const result = await getSampleViews(views, "torikichi");
  assert.equal(result?.views, 1);
});

test("GET /s/{slug}: 本番サイト(kind=site)はカウントしない", async () => {
  const sites = new Map([["site:mise", SITE_HTML]]);
  const views = new MemoryKv();
  const response = await handleRequest(new Request("https://example.com/s/mise"), env(sites, views));
  assert.equal(response.status, 200);
  await response.text();

  const result = await getSampleViews(views, "mise");
  assert.equal(result?.views, 0);
});

test("GET /api/sample-views: 鍵なしは存在を隠して404", async () => {
  const response = await handleRequest(new Request("https://example.com/api/sample-views?slug=torikichi"), env());
  assert.equal(response.status, 404);
});

test("GET /api/sample-views: 鍵ありはカウントを返す", async () => {
  const views = new MemoryKv();
  await recordSampleView(views, "torikichi", Date.UTC(2026, 7, 27));
  const response = await handleRequest(
    new Request("https://example.com/api/sample-views?slug=torikichi", { headers: { "x-batch-key": "correct-key" } }),
    env(new Map(), views),
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { slug: string; views: number };
  assert.equal(body.slug, "torikichi");
  assert.equal(body.views, 1);
});

test("GET /api/sample-views: slug未指定は422", async () => {
  const response = await handleRequest(
    new Request("https://example.com/api/sample-views", { headers: { "x-batch-key": "correct-key" } }),
    env(),
  );
  assert.equal(response.status, 422);
});
