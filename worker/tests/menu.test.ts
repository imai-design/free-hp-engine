import assert from "node:assert/strict";
import test from "node:test";
import { renderSite } from "../src/domain/render.ts";
import { buildMenuItems } from "../src/domain/render/parts.ts";
import type { SkeletonKey } from "../src/domain/render/types.ts";
import { validateInput, ValidationError, type Industry, type SiteInput } from "../src/domain/validate.ts";
import type { GeneratedContent } from "../src/generation/provider.ts";

function baseRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    storeName: "喫茶かえる",
    industry: "飲食店",
    catchphrase: "三代つづく、町の定食屋",
    description: "季節の食材を使ったごはんを、ゆっくり楽しめる小さな喫茶店です。",
    colorTheme: "あたたかい",
    ...overrides,
  };
}

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

const CONTENT: GeneratedContent = {
  subheadline: "そえがき",
  aboutText: "店の紹介",
  highlights: ["大切にしている一品"],
  closingText: "ご来店をお待ちしています",
};

const SKELETON_CASES: readonly { skeleton: SkeletonKey; industry: Industry; heading: string }[] = [
  { skeleton: "名刺", industry: "その他", heading: "しな書き" },
  { skeleton: "暖簾", industry: "飲食店", heading: "お品書き" },
  { skeleton: "短冊", industry: "美容・サロン", heading: "menu" },
  { skeleton: "方眼", industry: "飲食店", heading: "料金表" },
];

test("validate: menuTextは任意で、CRLFをLFへ正規化する", () => {
  assert.equal(validateInput(baseRaw()).menuText, undefined);
  assert.equal(validateInput(baseRaw({ menuText: "  \n  " })).menuText, undefined);
  assert.equal(
    validateInput(baseRaw({ menuText: "珈琲｜500円\r\n抹茶ラテ ¥600" })).menuText,
    "珈琲｜500円\n抹茶ラテ ¥600",
  );
});

test("validate: menuTextは500文字まで受け付け、501文字を拒否する", () => {
  assert.equal(validateInput(baseRaw({ menuText: "あ".repeat(500) })).menuText?.length, 500);
  assert.throws(() => validateInput(baseRaw({ menuText: "あ".repeat(501) })), ValidationError);
});

test("validate: menuTextは8行まで受け付け、9行を拒否する", () => {
  const eightLines = Array.from({ length: 8 }, (_, index) => `品${index + 1} ${index + 1}00円`).join("\n");
  const nineLines = `${eightLines}\n品9 900円`;
  assert.equal(validateInput(baseRaw({ menuText: eightLines })).menuText, eightLines);
  assert.throws(() => validateInput(baseRaw({ menuText: nineLines })), ValidationError);
});

test("parse: 縦線・空白区切りの許可価格を{name, price}へ分ける", () => {
  const menuItems = buildMenuItems(baseInput({
    menuText: [
      "珈琲｜800円",
      "抹茶ラテ ¥900",
      "厚切りトースト 700",
    ].join("\n"),
  }));
  assert.deepEqual(menuItems, [
    { name: "珈琲", price: "800円" },
    { name: "抹茶ラテ", price: "¥900" },
    { name: "厚切りトースト", price: "700" },
  ]);
});

test("parse: 価格として読めない行は内容を捨てず、行全体を品名として残す", () => {
  const menuItems = buildMenuItems(baseInput({
    menuText: [
      "季節のケーキ｜時価",
      "ランチ 1,200円",
      "おすすめだけの日",
    ].join("\n"),
  }));
  assert.deepEqual(menuItems, [
    { name: "季節のケーキ｜時価", price: null },
    { name: "ランチ 1,200円", price: null },
    { name: "おすすめだけの日", price: null },
  ]);
});

test("render: 4骨格で固有見出しのメニュー節を、大切にしていること相当の節の直後に出す", () => {
  for (const { skeleton, industry, heading } of SKELETON_CASES) {
    const html = renderSite(baseInput({ industry, menuText: "珈琲｜800円\n本日のおすすめ" }), CONTENT, { skeleton });
    assert.ok(html.includes(`<h2>${heading}</h2>`), `${skeleton}: 見出し「${heading}」が無い`);
    assert.match(html, /<span class="menu__name">珈琲<\/span><span class="menu__price">800円<\/span>/u, `${skeleton}: 価格つきの品が無い`);
    assert.match(html, /<span class="menu__name">本日のおすすめ<\/span>/u, `${skeleton}: 品名だけの行が無い`);

    const highlightsAt = html.indexOf("大切にしている一品");
    const menuAt = html.indexOf(`<h2>${heading}</h2>`);
    const closingAt = html.indexOf("ご来店をお待ちしています");
    assert.ok(highlightsAt >= 0 && highlightsAt < menuAt, `${skeleton}: メニューが大切にしていることより前にある`);
    assert.ok(menuAt < closingAt, `${skeleton}: メニューが結びの節より後にある`);
  }
});

test("render: menuTextが空なら4骨格ともメニュー節ごと出さない", () => {
  for (const { skeleton, industry, heading } of SKELETON_CASES) {
    const html = renderSite(baseInput({ industry }), CONTENT, { skeleton });
    assert.ok(!html.includes('class="menu__list"'), `${skeleton}: 空なのにメニュー一覧が出ている`);
    assert.ok(!html.includes(`<h2>${heading}</h2>`), `${skeleton}: 空なのに見出し「${heading}」が出ている`);
  }
});

test("XSS: 品名の<script>と引用符はエスケープされ、4骨格でタグや属性にならない", () => {
  const input = validateInput(baseRaw({ menuText: '危険<script>alert(1)</script>"品｜800円' }));
  const escapedName = "危険&lt;script&gt;alert(1)&lt;/script&gt;&quot;品";

  assert.deepEqual(buildMenuItems(input), [{ name: escapedName, price: "800円" }]);
  for (const { skeleton, industry } of SKELETON_CASES) {
    const html = renderSite({ ...input, industry }, CONTENT, { skeleton });
    assert.ok(!html.includes("<script>alert(1)</script>"), `${skeleton}: scriptタグが残っている`);
    assert.ok(html.includes(`<span class="menu__name">${escapedName}</span>`), `${skeleton}: 品名が安全に表示されていない`);
  }
});
