import assert from "node:assert/strict";
import test from "node:test";
import type { GeneratedContent } from "../src/generation/provider.ts";
import { renderSite } from "../src/domain/render.ts";
import { buildSkeletonContext } from "../src/domain/render/parts.ts";
import { selectPalette, selectSkeleton } from "../src/domain/render/select.ts";
import { SKELETONS } from "../src/domain/render/skeletons/index.ts";
import type { SkeletonKey, Temperature } from "../src/domain/render/types.ts";
import { COLOR_THEMES, INDUSTRIES, validateInput, type ColorTheme, type Industry, type SiteInput } from "../src/domain/validate.ts";

function baseInput(overrides: Partial<SiteInput> = {}): SiteInput {
  return {
    storeName: "麦の香",
    industry: "飲食店",
    catchphrase: "毎朝、店の奥の窯でパンを焼いています。",
    description: "小麦の香りがふわりと届く、住宅街の小さなパン屋です。",
    colorTheme: "あたたかい",
    phone: "03-1234-5678",
    address: "東京都武蔵野市吉祥寺本町1-2-3",
    businessHours: "8:00〜18:00（月曜定休）",
    ...overrides,
  };
}

const baseContent: GeneratedContent = {
  subheadline: "AIが書いたそえがき",
  aboutText: "毎朝、小麦から丁寧に仕込んでいます。",
  highlights: ["店内で焼き上げます", "季節のパンも並びます"],
  closingText: "お近くにお越しの際はお立ち寄りください。",
};

// ---- ① 同じ店名は毎回同じ骨格・配色・見出し型（DESIGN_SPEC.md §3-1） ----

test("同じ店名・同じ住所なら、骨格・配色・出力HTMLは何度作り直しても同じになる", () => {
  const input = baseInput();
  const first = renderSite(input, baseContent);
  const second = renderSite(baseInput(), { ...baseContent });
  assert.equal(first, second, "同じ入力から作った2枚のHTMLが一致しない");

  const skeletonA = selectSkeleton(baseInput());
  const skeletonB = selectSkeleton(baseInput());
  assert.equal(skeletonA.key, skeletonB.key);

  const paletteA = selectPalette(skeletonA, baseInput(), false);
  const paletteB = selectPalette(skeletonB, baseInput(), false);
  assert.equal(paletteA.key, paletteB.key);
});

test("店名が同じでも住所が違えば、別の顔になり得る（チェーン店対策・seedOfに住所を混ぜている）", () => {
  // 100店分ためして、店名だけ固定・住所だけ変えたときに一度も違いが出ないのは不自然、という緩い健全性チェック。
  const outcomes = new Set<string>();
  for (let i = 0; i < 50; i += 1) {
    const skeleton = selectSkeleton(baseInput({ address: `東京都武蔵野市吉祥寺本町${i}-1-1` }));
    const palette = selectPalette(skeleton, baseInput({ address: `東京都武蔵野市吉祥寺本町${i}-1-1` }), false);
    outcomes.add(`${skeleton.key}:${palette.key}`);
  }
  assert.ok(outcomes.size > 1, "住所を変えても骨格・配色の組が1種類しか出ない（住所がseedに混ざっていない疑い）");
});

// ---- ② 業種に合わない骨格が当たらない（DESIGN_SPEC.md §0） ----

const EXPECTED_SKELETONS_BY_INDUSTRY: Record<Industry, readonly SkeletonKey[]> = {
  飲食店: ["暖簾", "名刺", "方眼", "看板"],
  "美容・サロン": ["名刺", "短冊"],
  "教室・スクール": ["名刺", "短冊", "方眼"],
  "小売・物販": ["名刺", "短冊", "方眼", "看板"],
  "修理・住まいのサービス": ["名刺", "短冊", "方眼"],
  その他: ["名刺", "短冊", "方眼", "看板"],
};

test("業種に合わない骨格が当たらない（暖簾は飲食店以外に出ない・短冊は飲食店に出ない）", () => {
  const industries = Object.keys(EXPECTED_SKELETONS_BY_INDUSTRY) as Industry[];
  for (const industry of industries) {
    const seen = new Set<SkeletonKey>();
    for (let i = 0; i < 300; i += 1) {
      const input = baseInput({ industry, storeName: `検証用の店${i}号`, address: i % 3 === 0 ? undefined : `東京都渋谷区代々木${i}-1-1` });
      const skeleton = selectSkeleton(input);
      seen.add(skeleton.key);
      assert.ok(
        EXPECTED_SKELETONS_BY_INDUSTRY[industry].includes(skeleton.key),
        `${industry} の店に ${skeleton.key} が選ばれた（業種対応表から外れている）`,
      );
    }
    // 300店ためして、その業種で使えるはずの骨格が一度も出ないのはハッシュの偏り・実装漏れを疑う。
    for (const expected of EXPECTED_SKELETONS_BY_INDUSTRY[industry]) {
      assert.ok(seen.has(expected), `${industry} で骨格「${expected}」が300回中一度も選ばれなかった`);
    }
  }
});

test("暖簾は飲食店以外には絶対に割り当てない（審査指摘の直接確認）", () => {
  for (let i = 0; i < 100; i += 1) {
    for (const industry of INDUSTRIES) {
      if (industry === "飲食店") continue;
      const skeleton = selectSkeleton(baseInput({ industry, storeName: `${industry}${i}` }));
      assert.notEqual(skeleton.key, "暖簾", `${industry} に暖簾が割り当てられた`);
    }
  }
});

// ---- ③ 5骨格それぞれがレンダリングできて、WCAG用のCSS変数を持つ ----

const SKELETON_CASES: readonly { skeleton: SkeletonKey; industry: Industry }[] = [
  { skeleton: "名刺", industry: "その他" },
  { skeleton: "暖簾", industry: "飲食店" },
  { skeleton: "短冊", industry: "美容・サロン" },
  { skeleton: "方眼", industry: "飲食店" },
  { skeleton: "看板", industry: "小売・物販" },
];

const NEW_THEME_CASES = [
  {
    theme: "たのしい",
    temperature: "lively",
    palettes: { 名刺: "木苺", 暖簾: "祭青", 短冊: "リボン", 方眼: "青空インク", 看板: "ネオン菫" },
  },
  {
    theme: "しっとり",
    temperature: "moody",
    palettes: { 名刺: "夜紫", 暖簾: "宵紫", 短冊: "宵霞", 方眼: "葡萄酒インク", 看板: "黒葡萄" },
  },
] as const satisfies readonly {
  theme: ColorTheme;
  temperature: Temperature;
  palettes: Readonly<Record<SkeletonKey, string>>;
}[];

test("5骨格それぞれがレンダリングでき、--photo-aspect / --photo-max / --dye-max を必ず持つ", () => {
  for (const { skeleton, industry } of SKELETON_CASES) {
    const input = baseInput({ industry });
    const html = renderSite(input, baseContent, { skeleton });
    assert.ok(html.startsWith("<!doctype html>"), `${skeleton}: HTMLとして壊れている`);
    assert.match(html, /--photo-aspect:\s*[^;]+;/u, `${skeleton}: --photo-aspectが無い`);
    assert.match(html, /--photo-max:\s*[^;]+;/u, `${skeleton}: --photo-maxが無い`);
    assert.match(html, /--dye-max:\s*[0-9.]+rem;/u, `${skeleton}: --dye-maxが無い`);
    assert.ok(html.includes(`data-型="${skeleton}"`), `${skeleton}: data-型が一致しない`);
    assert.match(html, /class="[^"]*tagline[^"]*"/u, `${skeleton}: taglineクラスが無い`);
  }
});

test("新テーマ2つは入力検証を通り、各テーマ×5骨格で正しいdata-配色属性までレンダリングされる", () => {
  assert.deepEqual(COLOR_THEMES, ["あたたかい", "落ち着いた", "さわやか", "たのしい", "しっとり"]);

  for (const { theme, temperature, palettes } of NEW_THEME_CASES) {
    assert.equal(validateInput(baseInput({ colorTheme: theme })).colorTheme, theme, `${theme}: 入力検証を通らない`);

    for (const { skeleton, industry } of SKELETON_CASES) {
      const input = baseInput({ colorTheme: theme, industry });
      const selectedSkeleton = selectSkeleton(input, skeleton);
      const matchingPalettes = selectedSkeleton.palettes.filter((palette) => palette.temp === temperature);
      assert.equal(matchingPalettes.length, 1, `${theme} / ${skeleton}: 対応パレットが1つではない`);
      assert.equal(matchingPalettes[0].key, palettes[skeleton], `${theme} / ${skeleton}: 対応パレット名が違う`);

      const html = renderSite(input, baseContent, { skeleton });
      assert.ok(html.startsWith("<!doctype html>"), `${theme} / ${skeleton}: HTMLとして壊れている`);
      assert.ok(
        html.includes(`<body data-型="${skeleton}" data-配色="${palettes[skeleton]}">`),
        `${theme} / ${skeleton}: data-配色属性が正しくない`,
      );
    }
  }
});

test("5骨格とも、写真あり/なし・住所なし・店名40文字・店名がラテン・highlights0件・見本(sample:true)で例外を投げない", () => {
  const png24byte = (width: number, height: number): string => {
    const bytes = [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
      (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    ];
    return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
  };
  const edgeCases: readonly { label: string; overrides: Partial<SiteInput> }[] = [
    { label: "写真あり", overrides: { photo: png24byte(120, 80) } },
    { label: "写真なし", overrides: { photo: undefined } },
    { label: "住所なし（都道府県の無い住所）", overrides: { address: "武蔵野市吉祥寺本町1-2-3" } },
    { label: "店名40文字", overrides: { storeName: "あ".repeat(40) } },
    { label: "店名がラテン", overrides: { storeName: "Sunny Table" } },
  ];
  const highlightsEmpty: GeneratedContent = { ...baseContent, highlights: [] };

  for (const { skeleton, industry } of SKELETON_CASES) {
    for (const edgeCase of edgeCases) {
      const input = baseInput({ industry, ...edgeCase.overrides });
      assert.doesNotThrow(
        () => renderSite(input, highlightsEmpty, { skeleton, sample: true }),
        `${skeleton} / ${edgeCase.label} でrenderSiteが例外を投げた`,
      );
      const html = renderSite(input, highlightsEmpty, { skeleton, sample: true });
      assert.match(html, /<meta name="robots" content="noindex,nofollow">/u, `${skeleton} / ${edgeCase.label}: sample指定なのにnoindexが無い`);
      assert.ok(html.includes("見本"), `${skeleton} / ${edgeCase.label}: 見本の注記が無い`);
    }
  }
});

// ---- ④ 看板固有: 必須情報・機能・対応業種・5テーマ・写真3形状 ----

test("看板は店名・キャッチ・連絡先・メニュー・行動ボタン・フッターをすべて表示し、同じ入力から同じHTMLを返す", () => {
  const input = baseInput({
    storeName: "炭火食堂 まっすぐ",
    industry: "飲食店",
    catchphrase: "腹いっぱい、うまいものを。",
    menuText: "炭火焼き定食｜980円\n瓶ビール ¥600",
    reserveUrl: "https://example.com/reserve",
    instagram: "sumibi_massugu",
    lineOfficial: "@massugu",
  });
  const first = renderSite(input, baseContent, { skeleton: "看板" });
  const second = renderSite({ ...input }, { ...baseContent }, { skeleton: "看板" });

  assert.equal(first, second, "看板が同じ入力から異なるHTMLを返した");
  assert.ok(first.includes("炭火食堂 まっすぐ"), "店名が出ていない");
  assert.ok(first.includes("腹いっぱい、うまいものを。"), "キャッチコピーが出ていない");
  assert.match(first, /href="tel:0312345678">03-1234-5678<\/a>/u, "電話のtel:リンクが出ていない");
  assert.match(first, /href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=/u, "住所リンクが出ていない");
  assert.ok(first.includes("8:00〜18:00（月曜定休）"), "営業時間が出ていない");
  assert.ok(first.includes("炭火焼き定食"), "メニュー名が出ていない");
  assert.ok(first.includes("980円"), "メニュー価格が出ていない");
  assert.ok(first.includes("瓶ビール"), "2件目のメニュー名が出ていない");
  assert.ok(first.includes("予約する"), "予約ボタンが出ていない");
  assert.ok(first.includes("Instagram"), "Instagramボタンが出ていない");
  assert.ok(first.includes("LINE公式"), "LINE公式ボタンが出ていない");
  assert.ok(first.includes("期限はありません"), "通常ページ用フッターが出ていない");

  const sample = renderSite(input, baseContent, { skeleton: "看板", sample: true });
  assert.ok(sample.includes("紹介文はこちらで仮に書いた"), "見本用の注記が出ていない");
  assert.ok(sample.includes("90日"), "見本用フッターが出ていない");
});

test("看板の対応業種は飲食店・小売/物販・その他だけ", () => {
  const kanban = SKELETONS.find((skeleton) => skeleton.key === "看板");
  assert.ok(kanban, "看板骨格が登録されていない");
  assert.deepEqual(kanban.industries, ["飲食店", "小売・物販", "その他"]);
});

test("看板は5テーマすべてでレンダリングできる", () => {
  const cases: readonly { theme: ColorTheme; palette: string }[] = [
    { theme: "あたたかい", palette: "赤提灯" },
    { theme: "落ち着いた", palette: "夜藍" },
    { theme: "さわやか", palette: "深緑" },
    { theme: "たのしい", palette: "ネオン菫" },
    { theme: "しっとり", palette: "黒葡萄" },
  ];
  for (const { theme, palette } of cases) {
    const html = renderSite(baseInput({ colorTheme: theme }), baseContent, { skeleton: "看板" });
    assert.ok(html.includes('data-型="看板"'), `${theme}: 看板としてレンダリングされていない`);
    assert.ok(html.includes(`data-配色="${palette}"`), `${theme}: 対応する配色が選ばれていない`);
    assert.match(html, /--night:\s*#[0-9A-F]{6};/u, `${theme}: 看板の色変数が出ていない`);
  }
});

test("看板は横長16:10・正方形1:1・縦3:4の写真枠を使い分け、写真なしでも成立する", () => {
  const png24byte = (width: number, height: number): string => {
    const bytes = [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
      (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    ];
    return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
  };
  const cases = [
    { photo: png24byte(160, 100), aspect: "16 / 10", max: "100%" },
    { photo: png24byte(100, 100), aspect: "1 / 1", max: "620px" },
    { photo: png24byte(90, 120), aspect: "3 / 4", max: "520px" },
  ] as const;
  for (const item of cases) {
    const html = renderSite(baseInput({ photo: item.photo }), baseContent, { skeleton: "看板" });
    assert.ok(html.includes(`--photo-aspect: ${item.aspect};`), `${item.aspect}: 写真比率が一致しない`);
    assert.ok(html.includes(`--photo-max: ${item.max};`), `${item.aspect}: 写真の最大幅が一致しない`);
    assert.match(html, /<figure class="photo"><img/u, `${item.aspect}: 写真要素が出ていない`);
  }
  const withoutPhoto = renderSite(baseInput({ photo: undefined }), baseContent, { skeleton: "看板" });
  assert.doesNotMatch(withoutPhoto, /<figure class="photo">/u);
});

// ---- ⑤ 見出しにクリシェ（心温まる/心地よいひととき 等）が出ない ----

test("見出し(h1相当)は事実だけから組み立てられ、AIが生成する4項目に依存しない", () => {
  const otherContent: GeneratedContent = {
    subheadline: "別のそえがき",
    aboutText: "別の紹介文です。",
    highlights: ["別の大切にしていることです"],
    closingText: "別の結びです。",
  };
  for (const { skeleton, industry } of SKELETON_CASES) {
    const input = baseInput({ industry });
    const selectedSkeleton = selectSkeleton(input, skeleton);
    const palette = selectPalette(selectedSkeleton, input, false);
    const first = buildSkeletonContext(input, baseContent, selectedSkeleton, palette, undefined, false);
    const second = buildSkeletonContext(input, otherContent, selectedSkeleton, palette, undefined, false);
    assert.equal(first.headline, second.headline, `${skeleton}: AI生成項目によって見出しが変わっている`);
  }
});

test("lead(そえがき)とhighlightsのクリシェは表示前に落ちる", () => {
  const content: GeneratedContent = {
    ...baseContent,
    subheadline: "心地よいひとときをお楽しみいただけます。",
    highlights: ["アットホームな雰囲気です", "こだわりの食材を使っています", "駅から徒歩3分です"],
  };
  for (const { skeleton, industry } of SKELETON_CASES) {
    const html = renderSite(baseInput({ industry }), content, { skeleton });
    assert.ok(!html.includes("心地よいひとときをお楽しみ"), `${skeleton}: leadのクリシェが残っている`);
    assert.ok(!html.includes("アットホームな雰囲気です"), `${skeleton}: highlightsのクリシェ1が残っている`);
    assert.ok(!html.includes("こだわりの食材を使っています"), `${skeleton}: highlightsのクリシェ2が残っている`);
    // クリシェでない項目まで道連れで消えていないことも確認する
    assert.ok(html.includes("駅から徒歩3分です"), `${skeleton}: クリシェでない項目まで消えている`);
  }
});

// ---- WCAG AA 4.5:1（自分でも1配色は抜き打ちで検算する。DESIGN_SPEC.md §9-2 その10） ----

function relativeLuminance(hex: string): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const AA_MIN_CONTRAST = 4.5;

test("WCAG AA 4.5:1: 名刺の本文色(ink)と補助色(sub)は、7配色すべてでcard/paperの上で基準を満たす", () => {
  const meishi = SKELETONS.find((skeleton) => skeleton.key === "名刺");
  assert.ok(meishi, "名刺骨格が見つからない");
  assert.equal(meishi!.palettes.length, 7, "名刺は7配色のはず");
  for (const palette of meishi!.palettes) {
    const { ink, sub, card, paper, seal, ground, foot, footlink } = palette.vars;
    assert.ok(contrastRatio(ink, card) >= AA_MIN_CONTRAST, `${palette.key}: ink/card ${contrastRatio(ink, card)}`);
    assert.ok(contrastRatio(ink, paper) >= AA_MIN_CONTRAST, `${palette.key}: ink/paper ${contrastRatio(ink, paper)}`);
    assert.ok(contrastRatio(sub, card) >= AA_MIN_CONTRAST, `${palette.key}: sub/card ${contrastRatio(sub, card)}`);
    assert.ok(contrastRatio(sub, paper) >= AA_MIN_CONTRAST, `${palette.key}: sub/paper ${contrastRatio(sub, paper)}`);
    assert.ok(contrastRatio(seal, card) >= AA_MIN_CONTRAST, `${palette.key}: seal/card ${contrastRatio(seal, card)}`);
    assert.ok(contrastRatio(foot, ground) >= AA_MIN_CONTRAST, `${palette.key}: foot/ground ${contrastRatio(foot, ground)}`);
    assert.ok(contrastRatio(footlink, ground) >= AA_MIN_CONTRAST, `${palette.key}: footlink/ground ${contrastRatio(footlink, ground)}`);
  }
});

test("WCAG AA 4.5:1: 方眼の文字色は本文紙面(paper/band)の上で基準を満たす（罫線gridは装飾専用のため対象外）", () => {
  const hogan = SKELETONS.find((skeleton) => skeleton.key === "方眼");
  assert.ok(hogan, "方眼骨格が見つからない");
  for (const palette of hogan!.palettes) {
    const { ink, sub, pen, paper, band } = palette.vars;
    assert.ok(contrastRatio(ink, paper) >= AA_MIN_CONTRAST, `${palette.key}: ink/paper ${contrastRatio(ink, paper)}`);
    assert.ok(contrastRatio(ink, band) >= AA_MIN_CONTRAST, `${palette.key}: ink/band ${contrastRatio(ink, band)}`);
    assert.ok(contrastRatio(sub, paper) >= AA_MIN_CONTRAST, `${palette.key}: sub/paper ${contrastRatio(sub, paper)}`);
    assert.ok(contrastRatio(sub, band) >= AA_MIN_CONTRAST, `${palette.key}: sub/band ${contrastRatio(sub, band)}`);
    assert.ok(contrastRatio(pen, paper) >= AA_MIN_CONTRAST, `${palette.key}: pen/paper ${contrastRatio(pen, paper)}`);
    assert.ok(contrastRatio(pen, band) >= AA_MIN_CONTRAST, `${palette.key}: pen/band ${contrastRatio(pen, band)}`);
    assert.ok(contrastRatio(paper, pen) >= AA_MIN_CONTRAST, `${palette.key}: paper/pen ${contrastRatio(paper, pen)}`);
  }
});

test("WCAG AA 4.5:1: 看板の5配色は、実際に文字が乗る全8色ペアで基準を満たす", () => {
  const kanban = SKELETONS.find((skeleton) => skeleton.key === "看板");
  assert.ok(kanban, "看板骨格が見つからない");
  assert.equal(kanban.palettes.length, 5, "看板は5配色のはず");
  assert.deepEqual(new Set(kanban.palettes.map((palette) => palette.temp)), new Set(["warm", "calm", "fresh", "lively", "moody"]));

  const pairs = [
    ["ink", "night"],
    ["ink", "surface"],
    ["muted", "night"],
    ["muted", "surface"],
    ["sign-ink", "sign"],
    ["accent", "night"],
    ["accent", "surface"],
    ["accent-ink", "accent"],
  ] as const;
  for (const palette of kanban.palettes) {
    for (const [foreground, background] of pairs) {
      const ratio = contrastRatio(palette.vars[foreground], palette.vars[background]);
      assert.ok(ratio >= AA_MIN_CONTRAST, `${palette.key}: ${foreground}/${background} ${ratio.toFixed(2)}:1`);
    }
  }
});

const NEW_PALETTE_TEXT_PAIRS = [
  {
    skeleton: "名刺",
    pairs: [
      ["ink", "card"], ["ink", "paper"], ["ink", "notice"], ["sub", "card"], ["sub", "paper"],
      ["seal", "card"], ["seal", "paper"], ["card", "seal"], ["foot", "ground"], ["footlink", "ground"],
    ],
  },
  {
    skeleton: "暖簾",
    pairs: [
      ["sumi", "paper"], ["sumi", "washi"], ["kiji", "paper"], ["kiji", "washi"],
      ["ai-text", "paper"], ["ai-text", "washi"], ["beni-text", "paper"],
      ["somenuki", "ai"], ["somenuki", "ai-deep"], ["somenuki", "beni"], ["footer-ink", "ai-deep"],
    ],
  },
  {
    skeleton: "短冊",
    pairs: [
      ["ink", "paper"], ["ink", "surface"], ["sub", "paper"], ["sub", "surface"],
      ["surface", "strip"], ["strip", "paper"], ["strip", "surface"],
    ],
  },
  {
    skeleton: "方眼",
    pairs: [
      ["ink", "paper"], ["ink", "band"], ["sub", "paper"], ["sub", "band"],
      ["pen", "paper"], ["pen", "band"], ["paper", "pen"],
    ],
  },
  {
    skeleton: "看板",
    pairs: [
      ["ink", "night"], ["ink", "surface"], ["muted", "night"], ["muted", "surface"],
      ["sign-ink", "sign"], ["accent", "night"], ["accent", "surface"], ["accent-ink", "accent"],
    ],
  },
] as const satisfies readonly { skeleton: SkeletonKey; pairs: readonly (readonly [string, string])[] }[];

test("WCAG AA 4.5:1: 新2テーマ×5骨格は、実際に文字が乗る全ペアで基準を満たす", () => {
  for (const { skeleton, pairs } of NEW_PALETTE_TEXT_PAIRS) {
    const found = SKELETONS.find((candidate) => candidate.key === skeleton);
    assert.ok(found, `${skeleton}: 骨格が見つからない`);
    const newPalettes = found.palettes.filter((palette) => palette.temp === "lively" || palette.temp === "moody");
    assert.equal(newPalettes.length, 2, `${skeleton}: 新テーマのパレットが2つではない`);

    for (const palette of newPalettes) {
      for (const [foreground, background] of pairs) {
        const ratio = contrastRatio(palette.vars[foreground], palette.vars[background]);
        assert.ok(ratio >= AA_MIN_CONTRAST, `${skeleton} / ${palette.key}: ${foreground}/${background} ${ratio.toFixed(2)}:1`);
      }
    }
  }
});
