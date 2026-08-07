import assert from "node:assert/strict";
import test from "node:test";
import type { GeneratedContent } from "../src/generation/provider.ts";
import { renderSite } from "../src/domain/render.ts";
import { buildSkeletonContext } from "../src/domain/render/parts.ts";
import { selectPalette, selectSkeleton } from "../src/domain/render/select.ts";
import { SKELETONS } from "../src/domain/render/skeletons/index.ts";
import type { SkeletonKey } from "../src/domain/render/types.ts";
import type { Industry, SiteInput } from "../src/domain/validate.ts";

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
  飲食店: ["暖簾", "名刺", "方眼"],
  "美容・サロン": ["名刺", "短冊"],
  その他: ["名刺", "短冊", "方眼"],
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

test("暖簾は美容・サロンとその他には絶対に割り当てない（審査指摘の直接確認）", () => {
  for (let i = 0; i < 100; i += 1) {
    const beauty = selectSkeleton(baseInput({ industry: "美容・サロン", storeName: `サロン${i}` }));
    const other = selectSkeleton(baseInput({ industry: "その他", storeName: `お店${i}` }));
    assert.notEqual(beauty.key, "暖簾");
    assert.notEqual(other.key, "暖簾");
  }
});

// ---- ③ 4骨格それぞれがレンダリングできて、WCAG用のCSS変数を持つ ----

const SKELETON_CASES: readonly { skeleton: SkeletonKey; industry: Industry }[] = [
  { skeleton: "名刺", industry: "その他" },
  { skeleton: "暖簾", industry: "飲食店" },
  { skeleton: "短冊", industry: "美容・サロン" },
  { skeleton: "方眼", industry: "飲食店" },
];

test("4骨格それぞれがレンダリングでき、--photo-aspect / --photo-max / --dye-max を必ず持つ", () => {
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

test("4骨格とも、写真あり/なし・住所なし・店名40文字・店名がラテン・highlights0件・見本(sample:true)で例外を投げない", () => {
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

// ---- ④ 見出しにクリシェ（心温まる/心地よいひととき 等）が出ない ----

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

test("WCAG AA 4.5:1: 名刺の本文色(ink)と補助色(sub)は、5配色すべてでcard/paperの上で基準を満たす", () => {
  const meishi = SKELETONS.find((skeleton) => skeleton.key === "名刺");
  assert.ok(meishi, "名刺骨格が見つからない");
  assert.equal(meishi!.palettes.length, 5, "名刺は5配色のはず");
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

test("WCAG AA 4.5:1: 方眼の見出し色(pen)は本文紙面(paper/band)の上で基準を満たす（罫線grid/paperは装飾専用のため対象外）", () => {
  const hogan = SKELETONS.find((skeleton) => skeleton.key === "方眼");
  assert.ok(hogan, "方眼骨格が見つからない");
  for (const palette of hogan!.palettes) {
    const { ink, sub, pen, paper, band } = palette.vars;
    assert.ok(contrastRatio(ink, paper) >= AA_MIN_CONTRAST, `${palette.key}: ink/paper ${contrastRatio(ink, paper)}`);
    assert.ok(contrastRatio(sub, paper) >= AA_MIN_CONTRAST, `${palette.key}: sub/paper ${contrastRatio(sub, paper)}`);
    assert.ok(contrastRatio(pen, paper) >= AA_MIN_CONTRAST, `${palette.key}: pen/paper ${contrastRatio(pen, paper)}`);
    assert.ok(contrastRatio(pen, band) >= AA_MIN_CONTRAST, `${palette.key}: pen/band ${contrastRatio(pen, band)}`);
  }
});
