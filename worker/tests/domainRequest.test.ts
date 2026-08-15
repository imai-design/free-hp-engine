import assert from "node:assert/strict";
import test from "node:test";
import { checkDomainAvailability, type FetchImpl } from "../src/domain/domainAvailability.ts";
import { DOMAIN_PRICES_YEN, quoteDomains } from "../src/domain/domainPricing.ts";
import { ValidationError } from "../src/domain/validate.ts";
import { validateDomainRequest } from "../src/domain/validateDomainRequest.ts";
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

const validInput = {
  storeName: "喫茶かえる",
  siteUrl: "https://free-hp-engine.example.workers.dev/s/kissa-kaeru",
  domains: ["kissa-kaeru.com", "kissa-kaeru.jp"],
  contactName: "山田 太郎",
  email: "taro@example.com",
  phone: "03-1234-5678",
  method: "self",
  note: "第1希望を優先してください。",
  agree: true,
} as const;

const NOW = Date.UTC(2026, 7, 16, 3, 4, 5);
const availableFetch: FetchImpl = async () => new Response(null, { status: 404 });

function postRequest(input: unknown, ip = "198.51.100.20"): Request {
  return new Request("https://example.com/api/domain-request", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "CF-Connecting-IP": ip,
      origin: "https://freehp.jp",
    },
    body: JSON.stringify(input),
  });
}

function env(store = new MemoryKv(), batchKey?: string) {
  return { SITES: store, BATCH_KEY: batchKey };
}

test("validate: .com/.net/.jp と各項目の境界値を受け付ける", () => {
  const result = validateDomainRequest({
    ...validInput,
    storeName: "店".repeat(60),
    domains: [`${"a".repeat(63)}.net`, "sample.jp"],
    contactName: "名".repeat(40),
    email: `${"a".repeat(104)}@example.com`,
    phone: "0".repeat(20),
    note: "要".repeat(300),
  });
  assert.equal(result.storeName.length, 60);
  assert.deepEqual(result.domains, [`${"a".repeat(63)}.net`, "sample.jp"]);
  assert.equal(result.note?.length, 300);
});

test("validate: 許可外TLDを拒否する", () => {
  assert.throws(() => validateDomainRequest({ ...validInput, domains: ["example.org"] }), ValidationError);
});

test("validate: 全角文字と日本語ドメインを拒否する", () => {
  assert.throws(() => validateDomainRequest({ ...validInput, domains: ["ｅｘａｍｐｌｅ.com"] }), ValidationError);
  assert.throws(() => validateDomainRequest({ ...validInput, domains: ["例え.jp"] }), ValidationError);
  assert.throws(() => validateDomainRequest({ ...validInput, domains: ["xn--r8jz45g.jp"] }), ValidationError);
});

test("validate: agree=falseを拒否する", () => {
  assert.throws(() => validateDomainRequest({ ...validInput, agree: false }), ValidationError);
});

test("validate: 希望ドメイン3件を拒否する", () => {
  assert.throws(() => validateDomainRequest({
    ...validInput,
    domains: ["one.com", "two.net", "three.jp"],
  }), ValidationError);
});

test("availability: RDAPの404をavailableにする", async () => {
  let requestedUrl = "";
  const status = await checkDomainAvailability("example.com", async (url) => {
    requestedUrl = url;
    return new Response(null, { status: 404 });
  });
  assert.equal(status, "available");
  assert.equal(requestedUrl, "https://rdap.verisign.com/com/v1/domain/example.com");
});

test("availability: RDAPの200をtakenにする", async () => {
  assert.equal(await checkDomainAvailability("example.net", async () => new Response(null, { status: 200 })), "taken");
});

test("availability: RDAPの例外をunknownにする", async () => {
  assert.equal(await checkDomainAvailability("example.jp", async () => {
    throw new Error("network failed");
  }), "unknown");
});

test("pricing: .com/.netは1800円、.jpは3300円", () => {
  assert.deepEqual(DOMAIN_PRICES_YEN, { com: 1_800, net: 1_800, jp: 3_300 });
  assert.deepEqual(quoteDomains(["one.com", "two.net", "three.jp"]), {
    "one.com": 1_800,
    "two.net": 1_800,
    "three.jp": 3_300,
  });
});

test("POST /api/domain-request: 正常系をTTLなしでKVへ保存し受付内容を返す", async () => {
  const store = new MemoryKv();
  const response = await handleRequest(postRequest(validInput), env(store), {
    fetch: availableFetch,
    now: () => NOW,
  });

  assert.equal(response.status, 200);
  const result = await response.json() as {
    id: string;
    availability: Record<string, string>;
    quote: Record<string, number>;
    method: string;
    nextSteps: string[];
  };
  assert.match(result.id, /^20260816-[0-9a-f]{8}$/u);
  assert.deepEqual(result.availability, { "kissa-kaeru.com": "available", "kissa-kaeru.jp": "available" });
  assert.deepEqual(result.quote, { "kissa-kaeru.com": 1_800, "kissa-kaeru.jp": 3_300 });
  assert.equal(result.method, "self");
  assert.equal(result.nextSteps.length, 3);

  const key = `domreq:${result.id}`;
  const stored = JSON.parse(await store.get(key) as string) as Record<string, unknown>;
  assert.equal(stored.id, result.id);
  assert.equal(stored.at, "2026-08-16T03:04:05.000Z");
  assert.equal(stored.status, "new");
  assert.equal(Object.hasOwn(stored, "ip"), false);
  assert.equal(store.ttls.get(key), undefined);
});

test("POST /api/domain-request: ValidationErrorを422で返す", async () => {
  const response = await handleRequest(postRequest({ ...validInput, domains: ["invalid.org"] }), env(), {
    fetch: availableFetch,
    now: () => NOW,
  });
  assert.equal(response.status, 422);
  assert.equal(typeof (await response.json() as { error: unknown }).error, "string");
});

test("GET /api/domain-requests: 鍵なしは存在を隠して404", async () => {
  const response = await handleRequest(new Request("https://example.com/api/domain-requests"), env());
  assert.equal(response.status, 404);
});

test("GET /api/domain-requests: 鍵ありはsince以降をat昇順で返す", async () => {
  const store = new MemoryKv();
  await store.put("domreq:20260815-00000001", JSON.stringify({ id: "old", at: "2026-08-15T01:00:00.000Z", status: "new" }));
  await store.put("domreq:20260816-00000002", JSON.stringify({ id: "later", at: "2026-08-16T09:00:00.000Z", status: "new" }));
  await store.put("domreq:20260816-00000001", JSON.stringify({ id: "earlier", at: "2026-08-16T03:00:00.000Z", status: "new" }));
  await store.put("domreq:broken", "not json");

  const response = await handleRequest(new Request(
    "https://example.com/api/domain-requests?since=2026-08-16T00%3A00%3A00.000Z",
    { headers: { "x-batch-key": "correct-key" } },
  ), env(store, "correct-key"));

  assert.equal(response.status, 200);
  const result = await response.json() as { items: Array<{ id: string }> };
  assert.deepEqual(result.items.map(({ id }) => id), ["earlier", "later"]);
});

test("POST /api/domain-request: content-lengthが大きすぎるリクエストは413", async () => {
  const request = new Request("https://example.com/api/domain-request", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "20001",
      "CF-Connecting-IP": "198.51.100.30",
      origin: "https://freehp.jp",
    },
    body: JSON.stringify(validInput),
  });
  const response = await handleRequest(request, env(), { fetch: availableFetch, now: () => NOW });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "request too large" });
});

test("POST /api/domain-request: 既存レート制限を流用し同一IPの6回目は429", async () => {
  const store = new MemoryKv();
  const context = { fetch: availableFetch, now: () => NOW };
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await handleRequest(postRequest(validInput), env(store), context)).status, 200);
  }
  const response = await handleRequest(postRequest(validInput), env(store), context);
  assert.equal(response.status, 429);
  assert.ok(response.headers.get("retry-after"));
});
