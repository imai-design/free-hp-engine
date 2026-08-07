import assert from "node:assert/strict";
import test from "node:test";
import type { GeneratedContent } from "../src/generation/provider.ts";
import { renderSite } from "../src/domain/render.ts";
import type { SkeletonKey } from "../src/domain/render/types.ts";
import { validateInput, ValidationError, type Industry, type SiteInput } from "../src/domain/validate.ts";

// 予約URL・Instagram・LINE公式（2026-08-07追加）。
// 美容・サロン業の第一情報である「予約」を載せられない、という穴を塞ぐための3項目。

function baseRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    storeName: "麦の香",
    industry: "飲食店",
    catchphrase: "毎朝、店の奥の窯でパンを焼いています。",
    description: "小麦の香りがふわりと届く、住宅街の小さなパン屋です。",
    colorTheme: "あたたかい",
    ...overrides,
  };
}

// ---- validate.ts: 正常系（3種） ----

test("validate: reserveUrlはhttpsのURLをそのまま受け付ける", () => {
  const input = validateInput(baseRaw({ reserveUrl: "https://example.com/reserve" }));
  assert.equal(input.reserveUrl, "https://example.com/reserve");
});

test("validate: instagramは「@user」「user」「instagram.com URL」のどれからでもユーザー名だけに正規化される", () => {
  assert.equal(validateInput(baseRaw({ instagram: "@sample_shop" })).instagram, "sample_shop");
  assert.equal(validateInput(baseRaw({ instagram: "sample.shop2" })).instagram, "sample.shop2");
  assert.equal(
    validateInput(baseRaw({ instagram: "https://www.instagram.com/sample_shop/" })).instagram,
    "sample_shop",
  );
});

test("validate: lineOfficialは「@ID」とlin.eeの短縮URLを受け付ける", () => {
  assert.equal(validateInput(baseRaw({ lineOfficial: "@sample-line" })).lineOfficial, "@sample-line");
  assert.equal(
    validateInput(baseRaw({ lineOfficial: "https://lin.ee/AbCd12" })).lineOfficial,
    "https://lin.ee/AbCd12",
  );
});

test("validate: 3つとも未入力なら省略され、エラーにならない", () => {
  const input = validateInput(baseRaw());
  assert.equal(input.reserveUrl, undefined);
  assert.equal(input.instagram, undefined);
  assert.equal(input.lineOfficial, undefined);
});

// ---- validate.ts: 不正系 ----

test("validate: reserveUrlはjavascript:スキームを拒否する", () => {
  assert.throws(() => validateInput(baseRaw({ reserveUrl: "javascript:alert(1)" })), ValidationError);
});

test("validate: reserveUrlはhttp://（非https）を拒否する", () => {
  assert.throws(() => validateInput(baseRaw({ reserveUrl: "http://example.com/reserve" })), ValidationError);
});

test("validate: instagramに記号が混ざっていると拒否する", () => {
  assert.throws(() => validateInput(baseRaw({ instagram: "sample*shop" })), ValidationError);
  assert.throws(() => validateInput(baseRaw({ instagram: "javascript:alert(1)" })), ValidationError);
});

test("validate: 変なlin.ee（余分なパス・クエリ・別ドメインへのなりすまし）は拒否する", () => {
  assert.throws(() => validateInput(baseRaw({ lineOfficial: "https://lin.ee/abc/xyz" })), ValidationError);
  assert.throws(() => validateInput(baseRaw({ lineOfficial: "https://lin.ee/abc?x=1" })), ValidationError);
  assert.throws(() => validateInput(baseRaw({ lineOfficial: "https://lin.ee.evil.com/abc" })), ValidationError);
  assert.throws(() => validateInput(baseRaw({ lineOfficial: "http://lin.ee/abc" })), ValidationError);
});

test("validate: reserveUrlは300字を超えると拒否する", () => {
  const huge = `https://example.com/${"a".repeat(300)}`;
  assert.throws(() => validateInput(baseRaw({ reserveUrl: huge })), ValidationError);
});

// ---- render: 骨格への表示 ----

function baseInput(overrides: Partial<SiteInput> = {}): SiteInput {
  return {
    storeName: "喫茶かえる",
    industry: "飲食店",
    catchphrase: "三代つづく、町の定食屋",
    description: "季節の食材を使ったごはんを、ゆっくり楽しめる小さな喫茶店です。",
    colorTheme: "あたたかい",
    ...overrides,
  };
}

const baseContent: GeneratedContent = {
  subheadline: "そえがき",
  aboutText: "本文",
  highlights: ["ひとつめ"],
  closingText: "むすび",
};

const SKELETON_CASES: readonly { skeleton: SkeletonKey; industry: Industry }[] = [
  { skeleton: "名刺", industry: "その他" },
  { skeleton: "暖簾", industry: "飲食店" },
  { skeleton: "短冊", industry: "美容・サロン" },
  { skeleton: "方眼", industry: "飲食店" },
];

test("render: 予約・Instagram・LINEをすべて入れると、4骨格すべてでボタンが出る", () => {
  for (const { skeleton, industry } of SKELETON_CASES) {
    const input = baseInput({
      industry,
      reserveUrl: "https://example.com/yoyaku",
      instagram: "sample_shop",
      lineOfficial: "@sample_id",
    });
    const html = renderSite(input, baseContent, { skeleton });
    assert.match(html, /class="action action--reserve"/u, `${skeleton}: 予約ボタンが無い`);
    assert.match(html, /class="action action--instagram"/u, `${skeleton}: Instagramボタンが無い`);
    assert.match(html, /class="action action--line"/u, `${skeleton}: LINEボタンが無い`);
    // 予約ボタンが先頭（最優先で目立つ位置）に来ている。
    // indexOfの対象は<a>タグの実際のclass属性文字列にする（<style>内の".action--reserve{"と
    // 取り違えて誤って一致してしまわないようにするため）。
    const reserveAt = html.indexOf('class="action action--reserve"');
    const instagramAt = html.indexOf('class="action action--instagram"');
    const lineAt = html.indexOf('class="action action--line"');
    assert.ok(reserveAt >= 0 && instagramAt >= 0 && lineAt >= 0, `${skeleton}: ボタンのclass属性が見つからない`);
    assert.ok(reserveAt < instagramAt && instagramAt < lineAt, `${skeleton}: 予約が先頭に来ていない`);
    // タップ領域44px以上
    assert.match(html, /\.action\{[^}]*min-height:44px/u, `${skeleton}: タップ領域が44px以上でない`);
  }
});

test("render: 3つとも未入力なら、行動ボタンの列ごと出ない", () => {
  for (const { skeleton, industry } of SKELETON_CASES) {
    const html = renderSite(baseInput({ industry }), baseContent, { skeleton });
    assert.ok(!html.includes('class="actions"'), `${skeleton}: 入力が無いのにactions列が出ている`);
    // ".action--reserve{...}" というCSS定義自体は骨格の静的CSSとして常に出るので、
    // <a>タグとしての出力（class属性）だけを見る。
    assert.ok(!html.includes('class="action action--reserve"'), `${skeleton}: 予約ボタンが出ている`);
    assert.ok(!html.includes('class="action action--instagram"'), `${skeleton}: Instagramボタンが出ている`);
    assert.ok(!html.includes('class="action action--line"'), `${skeleton}: LINEボタンが出ている`);
  }
});

test("render: 予約だけ入れたときは、予約ボタンだけが出る", () => {
  const html = renderSite(baseInput({ reserveUrl: "https://example.com/yoyaku" }), baseContent, { skeleton: "名刺" });
  assert.match(html, /class="action action--reserve"/u);
  assert.ok(!html.includes("action--instagram"));
  assert.ok(!html.includes("action--line"));
});

test("render: 予約URLのhrefは入力どおりだが、Instagram・LINEのhrefはこちらで組み立てたURLになる", () => {
  const html = renderSite(
    baseInput({
      reserveUrl: "https://example.com/yoyaku",
      instagram: "sample_shop",
      lineOfficial: "@sample_id",
    }),
    baseContent,
    { skeleton: "名刺" },
  );
  assert.match(html, /<a class="action action--reserve" href="https:\/\/example\.com\/yoyaku"/u);
  // Instagramのユーザー名しか渡していないのに、instagram.comのURLが組み立てられている
  assert.match(html, /<a class="action action--instagram" href="https:\/\/www\.instagram\.com\/sample_shop\/"/u);
  // 「@ID」がそのまま出るのではなく、line.meの追加URLに組み立てられている（@は%40にエンコード）
  assert.match(html, /<a class="action action--line" href="https:\/\/line\.me\/R\/ti\/p\/%40sample_id"/u);
  assert.ok(!html.includes('href="@sample_id"'));
});

test("render: lin.eeの短縮URLはそのままLINEボタンのhrefになる", () => {
  const html = renderSite(baseInput({ lineOfficial: "https://lin.ee/AbCd12" }), baseContent, { skeleton: "名刺" });
  assert.match(html, /<a class="action action--line" href="https:\/\/lin\.ee\/AbCd12"/u);
});

test("render: 行動ボタンは新しいタブで開き、noopener/noreferrerを付ける", () => {
  const html = renderSite(baseInput({ reserveUrl: "https://example.com/yoyaku" }), baseContent, { skeleton: "名刺" });
  assert.match(html, /<a class="action action--reserve"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/u);
});

// ---- render: XSS対策（render層自身の多重防御を確認する。validate.tsの正規表現はすでにこれらを拒否するため、
// ここでは validateInput を経由せず SiteInput を直接組み立てて render/parts.ts の escapeHtml が
// 独立して効いていることを確かめる） ----

test("render: reserveUrlにHTML特殊文字が混ざっていても、属性が壊れずタグとして解釈されない", () => {
  const html = renderSite(
    baseInput({ reserveUrl: 'https://example.com/"><script>alert(1)</script>' } as never),
    baseContent,
    { skeleton: "名刺" },
  );
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.equal(html.includes('"><script>'), false);
  assert.match(html, /href="https:\/\/example\.com\/&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/u);
});

test("render: instagramにHTML特殊文字が混ざっていても無害化される", () => {
  const html = renderSite(
    baseInput({ instagram: '"><script>alert(1)</script>' } as never),
    baseContent,
    { skeleton: "名刺" },
  );
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.equal(html.includes('"><script>'), false);
});

test("render: lineOfficialにHTML特殊文字が混ざっていても無害化される", () => {
  const html = renderSite(
    baseInput({ lineOfficial: '@"><script>alert(1)</script>' } as never),
    baseContent,
    { skeleton: "名刺" },
  );
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.equal(html.includes('"><script>'), false);
});
