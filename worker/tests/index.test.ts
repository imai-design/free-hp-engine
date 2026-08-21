import assert from "node:assert/strict";
import test from "node:test";
import { escapeHtml, renderSite } from "../src/domain/render.ts";
import { photoShapeOf, readImageSize } from "../src/domain/imageSize.ts";
import { handleRequest } from "../src/index.ts";

class MemoryKv {
  values = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}

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

function env(kv = new MemoryKv(), apiKey?: string) {
  return { SITES: kv, ANTHROPIC_API_KEY: apiKey, PUBLIC_BASE_URL: "https://free-hp-engine.example.workers.dev" };
}

function request(body: unknown, ip = "198.51.100.10", origin = "https://freehp.jp") {
  return new Request("https://free-hp-engine.example.workers.dev/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json", origin, "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
}

const stubProvider = async () => generated;

test("正常系: 構造化コンテンツを固定テンプレートで保存しURLを返す", async () => {
  const kv = new MemoryKv();
  const response = await handleRequest(request(validInput), env(kv), { generate: stubProvider });
  assert.equal(response.status, 200);
  const result = await response.json() as { url: string; slug: string };
  assert.match(result.url, /^https:\/\/free-hp-engine\.example\.workers\.dev\/s\//);
  assert.equal((await kv.get(`site:${result.slug}`))?.includes("喫茶かえる"), true);
});

test("HEAD /s/{slug}: GETと同じ200・HTMLヘッダーで空ボディを返す", async () => {
  const kv = new MemoryKv();
  await kv.put("site:head-test", "<!doctype html><title>HEAD test</title>");
  const url = "https://free-hp-engine.example.workers.dev/s/head-test";
  const getResponse = await handleRequest(new Request(url), env(kv));
  const headResponse = await handleRequest(new Request(url, { method: "HEAD" }), env(kv));

  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get("content-type"), "text/html; charset=utf-8");
  assert.deepEqual(Object.fromEntries(headResponse.headers), Object.fromEntries(getResponse.headers));
  assert.equal(await headResponse.text(), "");

  const missingUrl = "https://free-hp-engine.example.workers.dev/s/missing-site";
  const missingGet = await handleRequest(new Request(missingUrl), env(kv));
  const missingHead = await handleRequest(new Request(missingUrl, { method: "HEAD" }), env(kv));
  assert.equal(missingHead.status, 404);
  assert.equal(missingHead.status, missingGet.status);
  assert.deepEqual(Object.fromEntries(missingHead.headers), Object.fromEntries(missingGet.headers));
  assert.equal(await missingHead.text(), "");
});

test("見本ページのGET/HEADだけX-Robots-TagとReferrer-Policyを返す", async () => {
  const store = new MemoryKv();
  const testEnv = { ...env(store), BATCH_KEY: "correct-key" };
  const sampleCreated = await handleRequest(
    new Request("https://example.com/api/sample", {
      method: "POST",
      headers: { "x-batch-key": "correct-key" },
      body: JSON.stringify(validInput),
    }),
    testEnv,
    { generate: stubProvider },
  );
  const normalCreated = await handleRequest(request({ ...validInput, storeName: "通常サイト" }), testEnv, { generate: stubProvider });
  const { url: sampleUrl } = await sampleCreated.json() as { url: string };
  const { url: normalUrl } = await normalCreated.json() as { url: string };

  for (const method of ["GET", "HEAD"]) {
    const sample = await handleRequest(new Request(sampleUrl, { method }), testEnv);
    assert.equal(sample.headers.get("x-robots-tag"), "noindex, nofollow, noarchive", `${method}: 見本のX-Robots-Tagが違う`);
    assert.equal(sample.headers.get("referrer-policy"), "no-referrer", `${method}: 見本のReferrer-Policyが違う`);

    const normal = await handleRequest(new Request(normalUrl, { method }), testEnv);
    assert.equal(normal.headers.get("x-robots-tag"), null, `${method}: 通常サイトにX-Robots-Tagが付いた`);
    assert.equal(normal.headers.get("referrer-policy"), null, `${method}: 通常サイトにReferrer-Policyが付いた`);
  }
});

test("GET / と HEAD /: freehp.jpへ302転送する", async () => {
  const url = "https://free-hp-engine.example.workers.dev/";
  const getResponse = await handleRequest(new Request(url), env());
  const headResponse = await handleRequest(new Request(url, { method: "HEAD" }), env());

  assert.equal(getResponse.status, 302);
  assert.equal(getResponse.headers.get("location"), "https://freehp.jp/");
  assert.equal(headResponse.status, 302);
  assert.equal(headResponse.headers.get("location"), "https://freehp.jp/");
  assert.equal(await headResponse.text(), "");
});

test("新規生成HTML: OGP・公開URL・HTMLエスケープ済みの値を含む", async () => {
  const kv = new MemoryKv();
  const description = `安心 & 丁寧な <お店> "です"。${"長い説明文".repeat(30)}`;
  const input = {
    ...validInput,
    storeName: '喫茶 "かえる" & 仲間 <本店>',
    description,
  };
  const response = await handleRequest(request(input), env(kv), { generate: stubProvider });

  assert.equal(response.status, 200);
  const result = await response.json() as { url: string; slug: string };
  const html = await kv.get(`site:${result.slug}`) as string;
  const escapedDescription = escapeHtml(Array.from(description).slice(0, 120).join(""));
  assert.ok(html.includes('<meta property="og:title" content="喫茶 &quot;かえる&quot; &amp; 仲間 &lt;本店&gt;">'));
  assert.ok(html.includes(`<meta name="description" content="${escapedDescription}">`));
  assert.ok(html.includes(`<meta property="og:description" content="${escapedDescription}">`));
  assert.ok(html.includes(`<meta property="og:url" content="${result.url}">`));
  assert.ok(html.includes('<meta name="twitter:card" content="summary">'));
});

test("生成HTML: 申込ページのフッターは「期限はありません」と連絡導線を含む", async () => {
  const kv = new MemoryKv();
  const response = await handleRequest(request(validInput), env(kv), { generate: stubProvider });
  assert.equal(response.status, 200);
  const result = await response.json() as { slug: string };
  const html = await kv.get(`site:${result.slug}`) as string;
  // お客さんが自分で作ったページは消さない（KVにTTLを付けない実装と文言を一致させる）
  assert.ok(html.includes("期限はありません"));
  assert.ok(!html.includes("90日"));
  assert.ok(html.includes('<a href="mailto:info@freehp.jp">info@freehp.jp</a>'));
  assert.ok(html.includes('<a href="https://freehp.jp/">freehp.jp</a>'));
});

test("validate失敗: 必須項目欠落は400", async () => {
  const { storeName: _removed, ...missing } = validInput;
  const response = await handleRequest(request(missing), env(), { generate: stubProvider });
  assert.equal(response.status, 400);
});

test("validate失敗: 文字数超過は400", async () => {
  const response = await handleRequest(request({ ...validInput, description: "あ".repeat(401) }), env(), { generate: stubProvider });
  assert.equal(response.status, 400);
});

test("validate失敗: enum外の業種は400", async () => {
  const response = await handleRequest(request({ ...validInput, industry: "不正な業種" }), env(), { generate: stubProvider });
  assert.equal(response.status, 400);
});

test("QA失敗時は422でKVに公開しない", async () => {
  const kv = new MemoryKv();
  const response = await handleRequest(request(validInput), env(kv), { generate: async () => ({ ...generated, subheadline: "ここに見出しを入れる" }) });
  assert.equal(response.status, 422);
  assert.equal([...kv.values.keys()].some((key) => key.startsWith("site:")), false);
});

test("レート制限: 同一IPの6回目は429", async () => {
  const kv = new MemoryKv();
  const options = { generate: stubProvider, now: () => 1_700_000_000_000 };
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await handleRequest(request(validInput), env(kv), options)).status, 200);
  }
  assert.equal((await handleRequest(request(validInput), env(kv), options)).status, 429);
});

test("APIキー未設定は外部通信せず503", async () => {
  const response = await handleRequest(request(validInput), env(new MemoryKv(), undefined), {});
  assert.equal(response.status, 503);
});

test("XSS入力は最終HTMLでエスケープされ、タグとして解釈されない", async () => {
  const kv = new MemoryKv();
  const attack = '<img src=x onerror="alert(1)">';
  const input = { ...validInput, storeName: attack };
  const response = await handleRequest(request(input), env(kv), {
    generate: async () => ({ ...generated, subheadline: `飲食店 ${attack}` }),
  });
  assert.equal(response.status, 200);
  const result = await response.json() as { slug: string };
  const html = await kv.get(`site:${result.slug}`) as string;
  assert.match(html, /&lt;img/);
  assert.equal(html.includes("<img"), false);
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes('onerror="alert(1)"'), false);
});

test("CORSは許可OriginだけにAccess-Control-Allow-Originを返す", async () => {
  const customDomain = await handleRequest(new Request("https://free-hp-engine.example.workers.dev/api/generate", { method: "OPTIONS", headers: { origin: "https://freehp.jp" } }), env());
  assert.equal(customDomain.headers.get("access-control-allow-origin"), "https://freehp.jp");
  const legacyDomain = await handleRequest(new Request("https://free-hp-engine.example.workers.dev/api/generate", { method: "OPTIONS", headers: { origin: "https://imai-design.github.io" } }), env());
  assert.equal(legacyDomain.headers.get("access-control-allow-origin"), "https://imai-design.github.io");
  const other = await handleRequest(new Request("https://free-hp-engine.example.workers.dev/api/generate", { method: "OPTIONS", headers: { origin: "https://evil.example" } }), env());
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  const rejected = await handleRequest(request(validInput, "198.51.100.20", "https://evil.example"), env(), { generate: stubProvider });
  assert.equal(rejected.status, 403);
});

// --- 連絡先の実用導線（2026-08-04追加） ---
// スマホで見た人がその場で「電話する」「道を調べる」までできるかを担保する。
// 住所欄に営業時間を混ぜて書かれると地図リンクが作れないため、営業時間は独立項目にしてある。

async function renderHtml(input: unknown): Promise<string> {
  const kv = new MemoryKv();
  const response = await handleRequest(request(input), env(kv), { generate: stubProvider });
  assert.equal(response.status, 200);
  const result = await response.json() as { slug: string };
  return await kv.get(`site:${result.slug}`) as string;
}

test("電話番号はtel:リンクになり、タップで発信できる", async () => {
  const html = await renderHtml(validInput);
  assert.ok(html.includes('<a href="tel:0312345678">03-1234-5678</a>'), html.slice(html.indexOf("contact")));
});

test("電話番号に注記が混ざっていても、番号部分だけをtel:に載せる", async () => {
  const html = await renderHtml({ ...validInput, phone: "03-1234-5678（受付は18時まで）" });
  assert.ok(html.includes('href="tel:0312345678"'));
  assert.ok(html.includes("受付は18時まで"));
});

test("電話番号として読めない文字列はtel:リンクにせず、そのまま表示する", async () => {
  const html = await renderHtml({ ...validInput, phone: "お問い合わせはSNSのDMまで" });
  assert.ok(!html.includes("tel:"));
  assert.ok(html.includes("お問い合わせはSNSのDMまで"));
});

test("住所は地図検索リンクになり、URLエンコードされる", async () => {
  const html = await renderHtml(validInput);
  const expected = `https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent("東京都渋谷区道玄坂1-2-3")}`;
  assert.ok(html.includes(expected), html.slice(html.indexOf("contact")));
  assert.ok(html.includes('rel="noopener noreferrer"'));
});

test("営業時間は入力どおりに表示され、AIの生成文には混ざらない", async () => {
  const html = await renderHtml(validInput);
  assert.ok(html.includes("11:00〜18:00（水曜定休）"));
  // ラベル文言（営業/商い/あいている時間/時間）は骨格ごとに変わる（DESIGN_SPEC.md §7）。
  // fixtureの店名（喫茶かえる）から選ばれる骨格に依存しないよう、ラベル語彙をまとめて許容する。
  assert.match(html, /<span class="(k|fuda)">(営業|商い|あいている時間|時間)<\/span>/u);
});

test("連絡先が未入力なら、その行自体を出さない", async () => {
  const html = await renderHtml({ ...validInput, phone: undefined, address: undefined, businessHours: undefined });
  // 骨格によって行のクラス名が変わる（.row/.k または .gyo/.fuda）ので、両方の語彙が出ないことを確認する。
  assert.ok(!html.includes('class="contact"'));
  assert.ok(!html.includes('<span class="k">'));
  assert.ok(!html.includes('<span class="fuda">'));
  assert.ok(!/class="gyo/u.test(html));
});

test("住所に引用符やタグが含まれてもリンク属性が壊れない", async () => {
  const html = await renderHtml({ ...validInput, address: '東京都"渋谷"区 <script>alert(1)</script>' });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes('query=東京都"渋谷"'));
  // href属性はエンコード済みの1本のURLとして閉じている
  assert.ok(/href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=[^"]+"/u.test(html));
});

test("ファビコンが埋め込まれ、タブに何も出ない状態にならない", async () => {
  const html = await renderHtml(validInput);
  assert.ok(html.includes('<link rel="icon" href="data:image/svg+xml,'));
  // 店名の頭文字（喫）がエンコードされて入っている
  assert.ok(html.includes(encodeURIComponent("喫")));
});

test("店名に記号が含まれてもファビコンのhref属性が壊れない", async () => {
  const html = await renderHtml({ ...validInput, storeName: '"><script>alert(1)</script>' });
  const match = html.match(/<link rel="icon" href="([^"]*)">/u);
  assert.ok(match, "iconのlinkタグが1本の属性として閉じていること");
  assert.ok(!match[1].includes('"'));
  assert.ok(!match[1].includes("<"));
  assert.equal(html.includes("<script>alert(1)</script>"), false);
});

// --- お店の写真（2026-08-04追加） ---
// 外部ストレージを足さずdata URIでHTMLに埋め込む。SVGは中にスクリプトを書けるため受け付けない。

/** 実際のマジックナンバーを持つ最小の画像を作る（検証が形式だけで通らないことを確かめるため）。 */
function dataUri(mime: string, bytes: number[]): string {
  const binary = String.fromCharCode(...bytes);
  return `data:image/${mime};base64,${btoa(binary)}`;
}
const realJpeg = dataUri("jpeg", [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const realPng = dataUri("png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

test("写真を送るとヒーローの下に画像が出る（配信URLを参照する）", async () => {
  const html = await renderHtml({ ...validInput, photo: realJpeg });
  assert.ok(html.includes('<figure class="photo">'));
  assert.match(html, /<img src="[^"]+\/s\/[a-z0-9-]+\/photo"/u);
  assert.ok(html.includes('alt="喫茶かえるの写真"'));
});

test("写真なしのときはfigureごと出さない", async () => {
  const html = await renderHtml(validInput);
  assert.equal(html.includes('class="photo"'), false);
});

test("PNGも受け付ける", async () => {
  const html = await renderHtml({ ...validInput, photo: realPng });
  assert.match(html, /<img src="[^"]+\/s\/[a-z0-9-]+\/photo"/u);
});

test("SVGは受け付けない（中にスクリプトを書けるため）", async () => {
  const svg = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')}`;
  const response = await handleRequest(request({ ...validInput, photo: svg }), env(), { generate: stubProvider });
  assert.equal(response.status, 400);
});

test("JPEGと名乗っていても中身が画像でなければ弾く", async () => {
  const fake = `data:image/jpeg;base64,${btoa("this is not an image at all")}`;
  const response = await handleRequest(request({ ...validInput, photo: fake }), env(), { generate: stubProvider });
  assert.equal(response.status, 400);
  const payload = await response.json() as { error: string };
  assert.match(payload.error, /画像として読み取れませんでした/u);
});

test("data URIの形をしていない文字列は弾く", async () => {
  const response = await handleRequest(request({ ...validInput, photo: "https://example.com/photo.jpg" }), env(), { generate: stubProvider });
  assert.equal(response.status, 400);
});

test("base64部分にHTMLの特殊文字を混ぜても通らない", async () => {
  const injected = 'data:image/jpeg;base64,AAAA"><script>alert(1)</script>';
  const response = await handleRequest(request({ ...validInput, photo: injected }), env(), { generate: stubProvider });
  assert.equal(response.status, 400);
});

test("上限を超える大きさの写真は弾く", async () => {
  const huge = `data:image/jpeg;base64,${"A".repeat(2_000_001)}`;
  const response = await handleRequest(request({ ...validInput, photo: huge }), env(), { generate: stubProvider });
  assert.equal(response.status, 400);
  const payload = await response.json() as { error: string };
  assert.match(payload.error, /大きすぎます/u);
});

// ---- 写真の寸法から枠の形を決める（2026-08-04追加）----
// 実画像をPillowで作ってbase64にしたもの。外部ファイルに依存させないためテスト内に埋め込む。
const JPEG_120x80 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCABQAHgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwBtFFFeeeqFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAf/9k=";
const PNG_64x96 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABgCAIAAAAip+O/AAAAsUlEQVR4nNXOQREAIAzAsFINiEAT/oUgYg+uUZC1z6VM4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iTO34GpB9c5AVbIhIsyAAAAAElFTkSuQmCC";
const WEBP_200x150 = "UklGRogAAABXRUJQVlA4IHwAAABwCgCdASrIAJYAPxGIwVosKSckIEgBgCIJaW7hdfHH8APEDqCGqo/eDhBkENMuak122iItrhBkEL42IJxS2avQ1Jrts1Y6qk121JHMQTilqRQ6qk12nbB1VJrtMAD9Nb1f/waBP/SOQmhKNEzYhcVqOQIfHIEPjkAgAAAA";
const WEBP_LOSSLESS_90x30 = "UklGRiQAAABXRUJQVlA4TBcAAAAvWUAHAAdQ88JXuv8BICH8Xy9G9D81AwA=";

test("JPEGの寸法を読める", () => {
  assert.deepEqual(readImageSize(`data:image/jpeg;base64,${JPEG_120x80}`), { width: 120, height: 80 });
});

test("PNGの寸法を読める", () => {
  assert.deepEqual(readImageSize(`data:image/png;base64,${PNG_64x96}`), { width: 64, height: 96 });
});

test("WebP（非可逆）の寸法を読める", () => {
  assert.deepEqual(readImageSize(`data:image/webp;base64,${WEBP_200x150}`), { width: 200, height: 150 });
});

test("WebP（可逆）の寸法を読める", () => {
  assert.deepEqual(readImageSize(`data:image/webp;base64,${WEBP_LOSSLESS_90x30}`), { width: 90, height: 30 });
});

test("読めない写真データはnullを返す（例外を投げない）", () => {
  assert.equal(readImageSize(""), null);
  assert.equal(readImageSize("https://example.com/a.jpg"), null);
  assert.equal(readImageSize(`data:image/gif;base64,${PNG_64x96}`), null);
  assert.equal(readImageSize(`data:image/jpeg;base64,${btoa("not an image")}`), null);
  assert.equal(readImageSize(`data:image/png;base64,${WEBP_200x150}`), null);
});

test("写真の形は縦横比で3種類に分かれ、読めない場合は横長として扱う", () => {
  assert.equal(photoShapeOf({ width: 1400, height: 1050 }), "landscape");
  assert.equal(photoShapeOf({ width: 1200, height: 1200 }), "square");
  assert.equal(photoShapeOf({ width: 1050, height: 1400 }), "portrait");
  assert.equal(photoShapeOf(null), "landscape");
});

const renderWithPhoto = (photo?: string) =>
  renderSite(
    { ...validInput, photo } as never,
    { subheadline: "そえ書き", aboutText: "本文", highlights: ["ひとつ"], closingText: "むすび" },
  );

test("縦写真の枠は3/4、正方形は1/1、横長は16/10になる", () => {
  assert.match(renderWithPhoto(`data:image/png;base64,${PNG_64x96}`), /--photo-aspect: 3 \/ 4/u);
  assert.match(renderWithPhoto(`data:image/webp;base64,${WEBP_LOSSLESS_90x30}`), /--photo-aspect: 16 \/ 10/u);
  assert.match(renderWithPhoto(`data:image/jpeg;base64,${JPEG_120x80}`), /--photo-aspect: 16 \/ 10/u);
  const square = renderSite(
    { ...validInput, photo: `data:image/webp;base64,${WEBP_200x150}` } as never,
    { subheadline: "そえ書き", aboutText: "本文", highlights: ["ひとつ"], closingText: "むすび" },
  );
  // 200x150 は比率1.33なので横長。
  assert.match(square, /--photo-aspect: 16 \/ 10/u);
});

test("実際に正方形の寸法を持つ写真は枠が1/1になる", () => {
  // PNGはIHDRの幅・高さだけで寸法が決まるため、シグネチャ8byte+チャンク長4byte+"IHDR"4byte+幅4byte+高さ4byteの
  // 最小24byteだけを組み立てれば十分（readPngSizeはCRCや画素データまでは見ない）。
  const squarePng = dataUri("png", [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x64, // width = 100
    0x00, 0x00, 0x00, 0x64, // height = 100
  ]);
  assert.equal(readImageSize(squarePng)?.width, 100);
  assert.equal(readImageSize(squarePng)?.height, 100);
  assert.match(renderWithPhoto(squarePng), /--photo-aspect: 1 \/ 1/u);
});

test("寸法が読めない壊れた写真データは例外を投げず16/10にフォールバックする", () => {
  // realPngはPNGのシグネチャ（マジックナンバー）は本物だが24byte未満でIHDRの寸法まで届かない。
  assert.equal(readImageSize(realPng), null);
  assert.doesNotThrow(() => renderWithPhoto(realPng));
  assert.match(renderWithPhoto(realPng), /--photo-aspect: 16 \/ 10/u);
});

test("写真がなくても写真用のCSS変数は壊れない", () => {
  const html = renderWithPhoto(undefined);
  assert.match(html, /--photo-aspect: 16 \/ 10/u);
  assert.ok(!html.includes('<figure class="photo">'));
});

// ---- 生成HPの作り（2026-08-04追加）----

test("業種が「その他」のときはページに業種を印字しない", () => {
  const html = renderSite(
    { ...validInput, industry: "その他" } as never,
    { subheadline: "そえ書き", aboutText: "本文", highlights: ["ひとつ"], closingText: "むすび" },
  );
  assert.ok(!html.includes('class="industry"'));
});

test("業種が「その他」以外ならページに印字する", () => {
  const html = renderWithPhoto(undefined);
  // 骨格ごとに見た目クラスが併記される（例 class="mokusatsu industry"）ので、
  // industryクラスがどこかに付いた要素の直下に業種語が出ていればよい（DESIGN_SPEC.md §9-1）。
  assert.match(html, /class="[^"]*industry"[^>]*>飲食店</u);
});

test("店主が書いたキャッチコピーがページに出る", () => {
  const html = renderWithPhoto(undefined);
  assert.match(html, /class="tagline">三代つづく、町の定食屋</u);
});

test("highlightsが空なら、骨格ごとの見出し語も含めて節ごと出さない", () => {
  // 骨格を固定しないと、fixtureの店名（喫茶かえる）から選ばれる骨格に依存してしまう（DESIGN_SPEC.md §9-1）。
  const HIGHLIGHT_HEADING: Record<"名刺" | "暖簾" | "短冊" | "方眼", string> = {
    名刺: "うちの流儀",
    暖簾: "うちの決めごと",
    短冊: "ふだんのこと",
    方眼: "きめていること",
  };
  for (const [skeleton, heading] of Object.entries(HIGHLIGHT_HEADING) as [keyof typeof HIGHLIGHT_HEADING, string][]) {
    const html = renderSite(
      { ...validInput, industry: skeleton === "短冊" ? "美容・サロン" : "飲食店" } as never,
      { subheadline: "そえ書き", aboutText: "本文", highlights: [], closingText: "むすび" },
      { skeleton },
    );
    assert.ok(!html.includes(heading), `${skeleton}: highlightsが空なのに見出し「${heading}」が残っている`);
    assert.ok(!html.includes("<ul></ul>"), `${skeleton}: 空のulが残っている`);
    assert.ok(!html.includes("<li>"), `${skeleton}: highlightsの項目が残っている`);
  }
});

test("フッターのメールがお店への問い合わせ先だと誤解されない文言になっている", () => {
  const html = renderWithPhoto(undefined);
  assert.match(html, /このお店へのお問い合わせ窓口ではありません/u);
});

// ---- 写真を画像URLとして配信し、共有カードに出す（2026-08-04追加）----

test("写真つきで生成すると、ページ本体もog:imageも画像URLを参照する", async () => {
  const store = new MemoryKv();
  const testEnv = { ...env(), SITES: store };
  const photo = `data:image/png;base64,${PNG_64x96}`;
  const response = await handleRequest(request({ ...validInput, photo }), testEnv, { generate: stubProvider });
  assert.equal(response.status, 200);
  const { slug } = await response.json() as { slug: string };
  const html = store.values.get(`site:${slug}`) as string;
  assert.match(html, /<meta property="og:image" content="[^"]+\/s\/[a-z0-9-]+\/photo">/u);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/u);
  // HTMLにdata URIを埋め込まなくなったぶん、共有時に取得するHTMLが軽くなる
  assert.ok(!html.includes("data:image/png;base64,"));
  assert.match(html, /<img src="[^"]+\/s\/[a-z0-9-]+\/photo"/u);
  assert.equal(store.values.get(`photo:${slug}`), photo);
});

test("写真なしのときはog:imageを出さず、カードはsummaryのまま", async () => {
  const store = new MemoryKv();
  const response = await handleRequest(request(validInput), { ...env(), SITES: store }, { generate: stubProvider });
  const { slug } = await response.json() as { slug: string };
  const html = store.values.get(`site:${slug}`) as string;
  assert.ok(!html.includes("og:image"));
  assert.match(html, /<meta name="twitter:card" content="summary">/u);
});

test("/s/{slug}/photo が画像を返す", async () => {
  const store = new MemoryKv();
  const testEnv = { ...env(), SITES: store };
  const photo = `data:image/png;base64,${PNG_64x96}`;
  const created = await handleRequest(request({ ...validInput, photo }), testEnv, { generate: stubProvider });
  const { slug } = await created.json() as { slug: string };
  const response = await handleRequest(new Request(`https://example.com/s/${slug}/photo`), testEnv, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  const bytes = new Uint8Array(await response.arrayBuffer());
  // PNGのシグネチャで始まっていれば、base64から正しくバイナリへ戻せている
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
});

test("存在しない写真URLは404を返す", async () => {
  const response = await handleRequest(new Request("https://example.com/s/nosuchsite/photo"), env(), {});
  assert.equal(response.status, 404);
});

// ---- 営業用の見本生成（2026-08-05追加）----

test("合鍵が無ければ見本の経路は開かない", async () => {
  const noKey = await handleRequest(
    new Request("https://example.com/api/sample", { method: "POST", body: JSON.stringify(validInput) }),
    env(), { generate: stubProvider });
  assert.equal(noKey.status, 404);
});

test("合鍵が違えば401", async () => {
  const response = await handleRequest(
    new Request("https://example.com/api/sample", { method: "POST", headers: { "x-batch-key": "wrong" }, body: JSON.stringify(validInput) }),
    { ...env(), BATCH_KEY: "correct-key" }, { generate: stubProvider });
  assert.equal(response.status, 401);
});

test("見本はnoindexと「仮の文章」の断りつきで作られ、回数制限を受けない", async () => {
  const store = new MemoryKv();
  const testEnv = { ...env(), SITES: store, BATCH_KEY: "correct-key" };
  const make = () => handleRequest(
    new Request("https://example.com/api/sample", { method: "POST", headers: { "x-batch-key": "correct-key" }, body: JSON.stringify(validInput) }),
    testEnv, { generate: stubProvider });
  let last: Response | undefined;
  // 申込フォームの上限は1時間5回。見本はそれを超えても通ること
  for (let i = 0; i < 7; i += 1) {
    last = await make();
    assert.equal(last.status, 200);
  }
  const { slug } = await last!.json() as { slug: string };
  const html = store.values.get(`site:${slug}`) as string;
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/u);
});

test("見本APIは外部URL画像を拒否し、HTMLも画像も保存しない", async () => {
  const store = new MemoryKv();
  const response = await handleRequest(
    new Request("https://example.com/api/sample", {
      method: "POST",
      headers: { "x-batch-key": "correct-key" },
      body: JSON.stringify({ ...validInput, photo: "https://example.com/unapproved-photo.jpg" }),
    }),
    { ...env(store), BATCH_KEY: "correct-key" },
    { generate: stubProvider },
  );

  assert.equal(response.status, 400);
  assert.equal([...store.values.keys()].some((key) => key.startsWith("site:") || key.startsWith("photo:")), false);
});

// ---- 見本の断り書き文言の出し分け（2026-08-18追加：sampleSource） ----

test("sampleSourceを省略すると従来どおり「地図サービスの公開情報」の断り書きになる（後方互換）", async () => {
  const store = new MemoryKv();
  const response = await handleRequest(
    new Request("https://example.com/api/sample", { method: "POST", headers: { "x-batch-key": "correct-key" }, body: JSON.stringify(validInput) }),
    { ...env(), SITES: store, BATCH_KEY: "correct-key" }, { generate: stubProvider });
  const { slug } = await response.json() as { slug: string };
  const html = store.values.get(`site:${slug}`) as string;
  assert.ok(html.includes("地図サービスの公開情報"), "map版の断り書きが出ていない");
  assert.ok(!html.includes("Threadsでのご投稿"), "指定していないのにThreads版の文言が混ざっている");
});

test("sampleSource:threadsを指定すると「Threadsでのご投稿」の断り書きになり、地図由来の文言は出ない", async () => {
  const store = new MemoryKv();
  const response = await handleRequest(
    new Request("https://example.com/api/sample", {
      method: "POST", headers: { "x-batch-key": "correct-key" },
      body: JSON.stringify({ ...validInput, sampleSource: "threads" }),
    }),
    { ...env(), SITES: store, BATCH_KEY: "correct-key" }, { generate: stubProvider });
  assert.equal(response.status, 200);
  const { slug } = await response.json() as { slug: string };
  const html = store.values.get(`site:${slug}`) as string;
  assert.ok(html.includes("Threadsでのご投稿を拝見して"), "threads版の断り書きが出ていない");
  assert.ok(html.includes("90日で自動的に消えます"), "threads版の90日の記述が出ていない");
  assert.ok(!html.includes("地図サービスの公開情報"), "地図由来の文言が残っている");
});

test("sampleSource:anonymousを指定すると架空見本向けの断り書きになり、地図・Threads由来の文言も承諾・14日の言及も出ない", async () => {
  const store = new MemoryKv();
  const response = await handleRequest(
    new Request("https://example.com/api/sample", {
      method: "POST", headers: { "x-batch-key": "correct-key" },
      body: JSON.stringify({ ...validInput, storeName: "◯◯建設（見本）", sampleSource: "anonymous" }),
    }),
    { ...env(), SITES: store, BATCH_KEY: "correct-key" }, { generate: stubProvider });
  assert.equal(response.status, 200);
  const { slug } = await response.json() as { slug: string };
  const html = store.values.get(`site:${slug}`) as string;
  assert.ok(html.includes("業種のイメージとして作った架空の見本"), "anonymous版の上部帯が出ていない");
  assert.ok(html.includes("このページは架空の見本です。実際のホームページは、お話をうかがってから"), "anonymous版の本文断り書きが出ていない");
  assert.ok(html.includes("この見本は、AIホームページ製作所（RYOSEIWORLD）が作りました。ご連絡先："), "anonymous版のフッターが出ていない");
  assert.ok(!html.includes("承諾"), "承諾の文言が残っている");
  assert.ok(!html.includes("地図サービス"), "地図サービスの文言が残っている");
  assert.ok(!html.includes("Threadsでのご投稿"), "Threadsの文言が混ざっている");
  assert.ok(!html.includes("14日"), "14日の文言が残っている");
});

test("その他の『行政書士 柴田事務所』は再生成後も店舗語が残れば機械置換し、事務所向けHTMLだけを公開する", async () => {
  const store = new MemoryKv();
  let generationCalls = 0;
  const response = await handleRequest(
    new Request("https://example.com/api/sample", {
      method: "POST",
      headers: { "x-batch-key": "correct-key" },
      body: JSON.stringify({
        ...validInput,
        storeName: "行政書士 柴田事務所",
        industry: "その他",
        skeleton: "短冊",
      }),
    }),
    { ...env(), SITES: store, BATCH_KEY: "correct-key" },
    {
      generate: async () => {
        generationCalls += 1;
        return {
          subheadline: "行政書士 柴田事務所は、地域のお店として相談に対応します。",
          aboutText: "初めて来店する方にも、手続きを順に説明します。",
          highlights: ["ご来店前に相談内容を確認します"],
          closingText: "皆様のご来店を心よりお待ちしております。",
        };
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(generationCalls, 2, "店舗語のQA不合格後に再生成していない");
  const { slug } = await response.json() as { slug: string };
  const html = store.values.get(`site:${slug}`) as string;
  assert.doesNotMatch(html, /お店|ご来店|来店|ここでしていること|ふだんのこと|お越しになる方へ/u);
  assert.ok(html.includes("事務所"));
  assert.ok(html.includes("業務内容"));
  assert.ok(html.includes("主なご相談"));
  assert.ok(html.includes("ご相談の前に"));
});

test("不正なsampleSourceは400を返す", async () => {
  const response = await handleRequest(
    new Request("https://example.com/api/sample", {
      method: "POST", headers: { "x-batch-key": "correct-key" },
      body: JSON.stringify({ ...validInput, sampleSource: "unknown" }),
    }),
    { ...env(), BATCH_KEY: "correct-key" }, { generate: stubProvider });
  assert.equal(response.status, 400);
});

test("skeletonを指定すると見本の骨格を固定でき、業種に無関係な値なら400を返す", async () => {
  const store = new MemoryKv();
  const testEnv = { ...env(), SITES: store, BATCH_KEY: "correct-key" };
  const ok = await handleRequest(
    new Request("https://example.com/api/sample", {
      method: "POST", headers: { "x-batch-key": "correct-key" },
      body: JSON.stringify({ ...validInput, skeleton: "看板" }),
    }),
    testEnv, { generate: stubProvider });
  assert.equal(ok.status, 200);
  const { slug } = await ok.json() as { slug: string };
  const html = store.values.get(`site:${slug}`) as string;
  assert.ok(html.includes('data-型="看板"'), "指定した骨格(看板)で作られていない");

  const bad = await handleRequest(
    new Request("https://example.com/api/sample", {
      method: "POST", headers: { "x-batch-key": "correct-key" },
      body: JSON.stringify({ ...validInput, skeleton: "存在しない骨格" }),
    }),
    testEnv, { generate: stubProvider });
  assert.equal(bad.status, 400);
});

test("申込フォーム経由のページにはnoindexを付けない", async () => {
  const store = new MemoryKv();
  const response = await handleRequest(request(validInput), { ...env(), SITES: store }, { generate: stubProvider });
  const { slug } = await response.json() as { slug: string };
  assert.ok(!(store.values.get(`site:${slug}`) as string).includes("noindex"));
});

test("POST /api/sample/unpublishは合鍵で見本だけを即時削除し、通常サイトは403で残す", async () => {
  const store = new MemoryKv();
  const testEnv = { ...env(store), BATCH_KEY: "correct-key" };
  const sampleCreated = await handleRequest(
    new Request("https://example.com/api/sample", {
      method: "POST",
      headers: { "x-batch-key": "correct-key" },
      body: JSON.stringify(validInput),
    }),
    testEnv,
    { generate: stubProvider },
  );
  const normalCreated = await handleRequest(request({ ...validInput, storeName: "残す通常サイト" }), testEnv, { generate: stubProvider });
  const { slug: sampleSlug } = await sampleCreated.json() as { slug: string };
  const { slug: normalSlug } = await normalCreated.json() as { slug: string };
  await store.put(`photo:${sampleSlug}`, "sample photo");
  await store.put(`partner_site:${sampleSlug}`, "sample partner record");

  const callUnpublish = (slug: string, key: string) => handleRequest(
    new Request("https://example.com/api/sample/unpublish", {
      method: "POST",
      headers: { "content-type": "application/json", "x-batch-key": key },
      body: JSON.stringify({ slug }),
    }),
    testEnv,
  );

  const unauthorized = await callUnpublish(sampleSlug, "wrong-key");
  assert.equal(unauthorized.status, 401);
  assert.ok(await store.get(`site:${sampleSlug}`), "認証失敗で見本が消えた");

  const normal = await callUnpublish(normalSlug, "correct-key");
  assert.equal(normal.status, 403);
  assert.ok(await store.get(`site:${normalSlug}`), "通常サイトが削除された");

  const sample = await callUnpublish(sampleSlug, "correct-key");
  assert.equal(sample.status, 200);
  assert.deepEqual(await sample.json(), { ok: true });
  assert.equal(await store.get(`site:${sampleSlug}`), null);
  assert.equal(await store.get(`photo:${sampleSlug}`), null);
  assert.equal(await store.get(`partner_site:${sampleSlug}`), null);
});

// ---- Googleアカウントでの登録制（2026-08-05追加）----

import { consumeDailyQuota, tokyoDateKey, UserQuotaError } from "../src/domain/userQuota.ts";
import { bearerToken } from "../src/domain/googleAuth.ts";

test("GOOGLE_CLIENT_IDが未設定なら、これまでどおりログイン不要で作れる", async () => {
  const response = await handleRequest(request(validInput), env(), { generate: stubProvider });
  assert.equal(response.status, 200);
});

test("GOOGLE_CLIENT_IDを設定するとログインが要る", async () => {
  const response = await handleRequest(request(validInput), { ...env(), GOOGLE_CLIENT_ID: "test-client" }, { generate: stubProvider });
  assert.equal(response.status, 401);
  const payload = await response.json() as { needsLogin: boolean; error: string };
  assert.equal(payload.needsLogin, true);
  assert.match(payload.error, /Googleでログイン/u);
});

test("Authorizationヘッダからトークンだけを取り出す", () => {
  assert.equal(bearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(bearerToken("bearer  abc.def.ghi  "), "abc.def.ghi");
  assert.equal(bearerToken("Basic abc"), "");
  assert.equal(bearerToken(null), "");
});

test("1人あたりの上限に達すると断る", async () => {
  const store = new MemoryKv();
  const now = Date.UTC(2026, 7, 5, 3, 0, 0);
  for (let i = 0; i < 3; i += 1) {
    const result = await consumeDailyQuota(store, "user-1", now);
    assert.equal(result.used, i + 1);
  }
  await assert.rejects(() => consumeDailyQuota(store, "user-1", now), UserQuotaError);
  // 別の人は影響を受けない
  assert.equal((await consumeDailyQuota(store, "user-2", now)).used, 1);
});

test("日付の区切りは日本時間の午前0時", () => {
  // 日本時間 2026-08-06 00:30 = UTC 2026-08-05 15:30
  assert.equal(tokyoDateKey(Date.UTC(2026, 7, 5, 15, 30)), "2026-08-06");
  // 日本時間 2026-08-05 23:30 = UTC 2026-08-05 14:30
  assert.equal(tokyoDateKey(Date.UTC(2026, 7, 5, 14, 30)), "2026-08-05");
});

test("日をまたぐと上限が戻る", async () => {
  const store = new MemoryKv();
  const day1 = Date.UTC(2026, 7, 5, 3, 0, 0);
  const day2 = Date.UTC(2026, 7, 6, 3, 0, 0);
  for (let i = 0; i < 3; i += 1) await consumeDailyQuota(store, "user-1", day1);
  await assert.rejects(() => consumeDailyQuota(store, "user-1", day1), UserQuotaError);
  assert.equal((await consumeDailyQuota(store, "user-1", day2)).used, 1);
});

test("枠が戻る時刻は「今朝」と誤解されない言い方で返す", async () => {
  const { nextAiQuotaReset } = await import("../src/domain/userQuota.ts");
  // UTC 2026-08-05 07:47 = 日本時間 16:47。次のUTC 0時は 2026-08-06 00:00 = 日本時間 8/6 9:00
  const r = nextAiQuotaReset(Date.UTC(2026, 7, 5, 7, 47));
  assert.equal(r.label, "8月6日の朝9時ごろ");
  assert.equal(r.hoursLeft, 17);
});

test("preflightがauthorizationヘッダを許可する（ログイン付きfetchの前提）", async () => {
  const response = await handleRequest(
    new Request("https://example.com/api/generate", { method: "OPTIONS", headers: { origin: "https://freehp.jp" } }),
    env(), {});
  assert.equal(response.status, 204);
  const allowed = (response.headers.get("access-control-allow-headers") || "").toLowerCase();
  assert.ok(allowed.includes("authorization"), `authorizationが許可されていない: ${allowed}`);
});

test("申込ページはTTLなし／map見本は14日／threads見本は90日（文言と実装の一致）", async () => {
  const kv = new MemoryKv();
  const ttls: Record<string, number | undefined> = {};
  const spy = {
    ...kv,
    get: (k: string) => kv.get(k),
    put: (k: string, v: string, o?: { expirationTtl?: number }) => {
      ttls[k] = o?.expirationTtl;
      return kv.put(k, v);
    },
  } as unknown as MemoryKv;

  const a = await handleRequest(request(validInput), env(spy), { generate: stubProvider });
  const { slug: mine } = await a.json() as { slug: string };
  assert.equal(ttls[`site:${mine}`], undefined, "申込ページに期限が付いている");

  const b = await handleRequest(
    new Request("https://example.com/api/sample", {
      method: "POST", headers: { "x-batch-key": "correct-key" }, body: JSON.stringify(validInput),
    }),
    { ...env(spy), BATCH_KEY: "correct-key" }, { generate: stubProvider });
  const { slug: mapSample } = await b.json() as { slug: string };
  assert.equal(ttls[`site:${mapSample}`], 60 * 60 * 24 * 14, "map見本の14日期限が違う");
  const mapHtml = await kv.get(`site:${mapSample}`) as string;
  assert.ok(mapHtml.includes("14日たつと"));
  assert.ok(!mapHtml.includes("90日たつと"));
  assert.ok(mapHtml.includes("期限なしで公開します"));

  const c = await handleRequest(
    new Request("https://example.com/api/sample", {
      method: "POST",
      headers: { "x-batch-key": "correct-key" },
      body: JSON.stringify({ ...validInput, storeName: "Threads見本", sampleSource: "threads" }),
    }),
    { ...env(spy), BATCH_KEY: "correct-key" },
    { generate: stubProvider },
  );
  const { slug: threadsSample } = await c.json() as { slug: string };
  assert.equal(ttls[`site:${threadsSample}`], 60 * 60 * 24 * 90, "threads見本の90日期限が違う");
  const threadsHtml = await kv.get(`site:${threadsSample}`) as string;
  assert.ok(threadsHtml.includes("90日たつと"));
  assert.ok(!threadsHtml.includes("14日たつと"));

  const d = await handleRequest(
    new Request("https://example.com/api/sample", {
      method: "POST",
      headers: { "x-batch-key": "correct-key" },
      body: JSON.stringify({ ...validInput, storeName: "◯◯建設（見本）", sampleSource: "anonymous" }),
    }),
    { ...env(spy), BATCH_KEY: "correct-key" },
    { generate: stubProvider },
  );
  const { slug: anonymousSample } = await d.json() as { slug: string };
  // KVの実TTLはmapと同じ14日のまま（撮影後すぐunpublishする運用なので値自体に意味は薄い）だが、
  // 文言側は「14日」を出さない（anonymousは会社の承諾・掲載可否の話が存在しないため）。
  assert.equal(ttls[`site:${anonymousSample}`], 60 * 60 * 24 * 14, "anonymous見本の実TTLが14日になっていない");
  const anonymousHtml = await kv.get(`site:${anonymousSample}`) as string;
  assert.ok(!anonymousHtml.includes("14日"), "anonymous見本の文言に14日が出ている");
});
