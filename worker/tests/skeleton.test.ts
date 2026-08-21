import assert from "node:assert/strict";
import test from "node:test";
import type { GeneratedContent } from "../src/generation/provider.ts";
import { renderSite } from "../src/domain/render.ts";
import { buildSkeletonContext, dyedTextOf, nameMaxRemOf, resolveHeadlineWord, shouldDropHeadlineWord } from "../src/domain/render/parts.ts";
import { selectPalette, selectSkeleton } from "../src/domain/render/select.ts";
import { KANBAN, SKELETONS, TANZAKU } from "../src/domain/render/skeletons/index.ts";
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
  "士業・専門サービス": ["名刺", "短冊", "方眼", "看板"],
  "不動産・建設": ["名刺", "短冊", "方眼", "看板"],
  "医療・クリニック": ["名刺", "短冊", "方眼", "看板"],
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

test("5骨格の節見出しは店舗向けを維持し、office/company/clinicではVenueKind別の3見出しになる", () => {
  const venueCases = [
    { industry: "士業・専門サービス", headings: ["業務内容", "主なご相談", "ご相談の前に"] },
    { industry: "不動産・建設", headings: ["事業内容", "取り扱い", "お問い合わせの前に"] },
    { industry: "医療・クリニック", headings: ["診療内容", "主な診療", "ご来院の前に"] },
  ] as const satisfies readonly { industry: Industry; headings: readonly string[] }[];

  for (const skeleton of SKELETONS) {
    const shopHtml = renderSite(baseInput({ industry: "飲食店" }), baseContent, { skeleton: skeleton.key });
    for (const heading of Object.values(skeleton.headings)) {
      assert.ok(shopHtml.includes(`<h2>${heading}</h2>`), `${skeleton.key}: 店舗向け見出し「${heading}」が変わった`);
    }
    for (const { industry, headings } of venueCases) {
      const html = renderSite(baseInput({ industry, storeName: `${industry}の見本` }), baseContent, { skeleton: skeleton.key });
      for (const heading of headings) {
        assert.ok(html.includes(`<h2>${heading}</h2>`), `${skeleton.key} / ${industry}: 「${heading}」が出ていない`);
      }
    }
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

test("見本の断り書きはsampleSourceで文言が変わる（5骨格すべて・threadsは地図由来の文言を含まない）", () => {
  for (const { skeleton, industry } of SKELETON_CASES) {
    const input = baseInput({ industry });
    const mapHtml = renderSite(input, baseContent, { skeleton, sample: true });
    const threadsHtml = renderSite(input, baseContent, { skeleton, sample: true, sampleSource: "threads" });
    assert.ok(mapHtml.includes("地図サービスの公開情報"), `${skeleton}: 既定(map)の断り書きが出ていない`);
    assert.ok(threadsHtml.includes("Threadsでのご投稿を拝見して"), `${skeleton}: threadsの断り書きが出ていない`);
    assert.ok(!threadsHtml.includes("地図サービスの公開情報"), `${skeleton}: threadsなのに地図由来の文言が残っている`);
  }
});

test("5骨格のmap/threads見本は最上部に非公式・未承認・削除窓口の帯を出し、通常サイトには出さない", () => {
  const expected = "これは AIホームページ製作所（freehp.jp）が提案用に作った非公式の見本です。麦の香様の公式サイトではなく、承諾も得ていません。掲載を望まれない場合は info@freehp.jp までご連絡ください（すぐに非公開にします）。";

  for (const { skeleton, industry } of SKELETON_CASES) {
    const input = baseInput({ industry });
    for (const sampleSource of ["map", "threads"] as const) {
      const html = renderSite(input, baseContent, { skeleton, sample: true, sampleSource });
      assert.ok(html.includes(`<aside class="sample-disclaimer" aria-label="見本について">${expected}</aside>`), `${skeleton}/${sampleSource}: 上部の帯文言が違う`);
      assert.ok(html.indexOf('class="sample-disclaimer"') > html.indexOf("<body"), `${skeleton}/${sampleSource}: 帯がbody内にない`);
    }
    const normalHtml = renderSite(input, baseContent, { skeleton });
    assert.ok(!normalHtml.includes('class="sample-disclaimer"'), `${skeleton}: 通常サイトに帯が出た`);
  }

  const kanban = renderSite(baseInput(), baseContent, { skeleton: "看板", sample: true, sampleSource: "map" });
  assert.ok(kanban.indexOf('class="sample-disclaimer"') < kanban.indexOf("<header"), "帯が看板ヘッダーより後ろにある");
});

// ---- 匿名見本 sampleSource:"anonymous"（2026-08-21追加：社名を出さない仮名見本用） ----

test("sampleSource:anonymousは上部の帯・本文の断り書き・フッターの3箇所すべてが架空見本向けの文言になり、旧文言（承諾・地図サービス・14日）を含まない（5骨格すべて）", () => {
  for (const { skeleton, industry } of SKELETON_CASES) {
    const input = baseInput({ industry, storeName: "◯◯建設（見本）" });
    const html = renderSite(input, baseContent, { skeleton, sample: true, sampleSource: "anonymous" });

    // 上部の帯
    assert.ok(
      html.includes("これは AIホームページ製作所（freehp.jp）が業種のイメージとして作った架空の見本です。実在の会社・お店のものではありません。"),
      `${skeleton}: anonymousの上部帯文言が出ていない`,
    );
    // 本文の断り書き
    assert.ok(
      html.includes("このページは架空の見本です。実際のホームページは、お話をうかがってから、会社の言葉と写真でお作りします。"),
      `${skeleton}: anonymousの本文断り書きが出ていない`,
    );
    // フッター
    assert.ok(
      html.includes("この見本は、AIホームページ製作所（RYOSEIWORLD）が作りました。ご連絡先："),
      `${skeleton}: anonymousのフッターが出ていない`,
    );

    assert.ok(!html.includes("承諾"), `${skeleton}: anonymousなのに「承諾」が残っている`);
    assert.ok(!html.includes("地図サービス"), `${skeleton}: anonymousなのに「地図サービス」が残っている`);
    assert.ok(!html.includes("14日"), `${skeleton}: anonymousなのに「14日」が残っている`);
    assert.ok(!html.includes("掲載を望まれない"), `${skeleton}: anonymousなのに「掲載を望まれない」が残っている`);
    assert.match(html, /<meta name="robots" content="noindex,nofollow">/u, `${skeleton}: anonymousなのにnoindexが無い`);
  }
});

test("見本レンダーは入力由来の外部URL画像をHTMLへ混ぜず、data URI写真だけを描画する", () => {
  const external = renderSite(
    baseInput({ photo: "https://example.com/unapproved-photo.jpg" }),
    baseContent,
    { skeleton: "看板", sample: true, photoUrl: "https://example.com/unapproved-photo.jpg" },
  );
  assert.doesNotMatch(external, /<img\s[^>]*src="https?:\/\//u);
  assert.ok(!external.includes("og:image"));

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
  const dataUri = png24byte(120, 80);
  const allowed = renderSite(baseInput({ photo: dataUri }), baseContent, { skeleton: "看板", sample: true });
  assert.match(allowed, /<img\s[^>]*src="data:image\/png;base64,/u);
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
  assert.ok(sample.includes("14日"), "map見本用フッターの14日期限が出ていない");
});

test("看板の対応業種は飲食店・小売/物販・非店舗3業種・その他", () => {
  const kanban = SKELETONS.find((skeleton) => skeleton.key === "看板");
  assert.ok(kanban, "看板骨格が登録されていない");
  assert.deepEqual(kanban.industries, [
    "飲食店",
    "小売・物販",
    "士業・専門サービス",
    "不動産・建設",
    "医療・クリニック",
    "その他",
  ]);
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

// ---- ④' 看板固有: 店名の文字数連動サイズが単調減少する（Issue #4） ----

test("nameMaxRemOf: 店名の文字数が増えるほど上限remは単調に下がる（3/5/6/12文字で確認・6文字以上の非単調バグの直接再現）", () => {
  const rem3chars = nameMaxRemOf("麦の香"); // 3文字
  const rem5chars = nameMaxRemOf("あいうえお"); // 5文字
  const rem6chars = nameMaxRemOf("あいうえおか"); // 6文字（旧実装のバグ：3.0remに跳ね上がっていた）
  const rem12chars = nameMaxRemOf("あいうえおかきくけこさし"); // 12文字

  assert.ok(rem3chars > rem5chars, `3文字(${rem3chars}) が 5文字(${rem5chars}) 以下になっている`);
  assert.ok(rem5chars > rem6chars, `5文字(${rem5chars}) が 6文字(${rem6chars}) 以下になっている（Issue #4 の非単調バグ）`);
  assert.ok(rem6chars > rem12chars, `6文字(${rem6chars}) が 12文字(${rem12chars}) 以下になっている`);
  assert.equal(rem6chars, 1.7, "6文字の上限remが想定値からずれている");
  assert.equal(rem12chars, 1.6, "12文字の上限remがCSS側clamp下限(1.6rem)と一致しない");
});

test("看板の :root は --name-max を持ち、店名が長いほど値が小さくなる（実HTML経由の確認）", () => {
  const shortName = renderSite(baseInput({ storeName: "炭" }), baseContent, { skeleton: "看板" });
  const midName = renderSite(baseInput({ storeName: "炭火食堂 まっすぐ" }), baseContent, { skeleton: "看板" });
  const longName = renderSite(
    baseInput({ storeName: "とても長い店名のパン工房こむぎのおうち" }),
    baseContent,
    { skeleton: "看板" },
  );
  const nameMaxOf = (html: string): number => {
    const match = html.match(/--name-max:\s*([0-9.]+)rem;/u);
    assert.ok(match, "--name-max が出ていない");
    return Number(match![1]);
  };
  const shortRem = nameMaxOf(shortName);
  const midRem = nameMaxOf(midName);
  const longRem = nameMaxOf(longName);
  assert.ok(shortRem > midRem, `店名1文字(${shortRem}) が 店名9文字(${midRem}) 以下になっている`);
  assert.ok(midRem > longRem, `店名9文字(${midRem}) が 店名19文字(${longRem}) 以下になっている`);
  assert.ok(shortName.includes(".kanban__name{") && shortName.includes("var(--name-max)"), "kanban__name が --name-max を参照していない");
});

test("--dye-max（短冊・暖簾）は今回の変更で挙動が変わらない：6文字以上でも従来どおり1文字染め=3.0remのまま", () => {
  // dyedTextOf 自体は今回変更していない。看板専用の nameMaxRemOf を新設しただけであることを確認する。
  const short = dyedTextOf("あいうえお"); // 5文字：そのまま5文字染め
  const long = dyedTextOf("あいうえおか"); // 6文字：頭文字1文字に切り詰め（従来どおり）
  assert.ok(short, "5文字の染め抜きがnullになった");
  assert.equal(short!.text, "あいうえお");
  assert.equal(short!.maxRem, 1.8, "5文字の--dye-max相当値が変わった");
  assert.ok(long, "6文字の染め抜きがnullになった");
  assert.equal(long!.text, "あ", "6文字以上を1文字に切り詰める従来の挙動が変わった");
  assert.equal(long!.maxRem, 3.0, "6文字以上の--dye-max相当値（頭文字1文字扱い）が変わった");

  for (const { skeleton, industry } of [
    { skeleton: "短冊" as const, industry: "美容・サロン" as const },
    { skeleton: "暖簾" as const, industry: "飲食店" as const },
  ]) {
    const html = renderSite(baseInput({ industry, storeName: "あいうえおか" }), baseContent, { skeleton });
    assert.match(html, /--dye-max:\s*3rem;/u, `${skeleton}: 6文字店名の--dye-maxが従来値(3rem)から変わった`);
  }
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

// ---- ⑥ 見出しに業種ラベル（審査カテゴリ名）がそのまま入らない（2026-08-19指摘の再発防止） ----
//
// 実例: https://free-hp-engine.ryoseiworld.workers.dev/s/site-0n6h0n0m4c で
// 見出しが「小売・物販のあなたの果樹園（見本）です。」となり、審査カテゴリの札が
// 地の文にそのまま入って機械的だった。kanban__meta 等のバッジ表示（ctx.word）は
// 業種ラベルのままでよいが、見出し文（ctx.headline）にだけは出てはいけない。

test("resolveHeadlineWord: 業種ラベルは見出し用に自然な言い方へ言い換わる（生の審査カテゴリ名は返さない）", () => {
  const EXPECTED_HEADLINE_WORD: Record<Industry, string | null> = {
    飲食店: "お店",
    "美容・サロン": "サロン",
    "教室・スクール": "教室",
    "小売・物販": "お店",
    "修理・住まいのサービス": "暮らしの相談先",
    "士業・専門サービス": "事務所",
    "不動産・建設": "会社",
    "医療・クリニック": "医院",
    その他: null,
  };
  for (const industry of INDUSTRIES) {
    assert.equal(
      resolveHeadlineWord(null, industry),
      EXPECTED_HEADLINE_WORD[industry],
      `${industry}: 見出し用の言い換えが期待値と違う`,
    );
    // 生の業種ラベル自体（Industry文字列そのもの）を見出しにそのまま返してはいけない
    // （「美容・サロン」「その他」はもともと言い換え済み/nullなので対象外）。
    if (industry !== "美容・サロン" && industry !== "その他") {
      assert.notEqual(
        resolveHeadlineWord(null, industry),
        industry,
        `${industry}: 見出し用の言い換えが業種ラベルそのままになっている`,
      );
    }
  }
});

test("見出し(h1相当)に業種ラベルがそのまま入らない（5骨格×対応業種を総当たり）", () => {
  // 言い換え前の生の業種ラベル。ページ内の他要素（kanban__meta のバッジ等）には出てよいが、
  // 見出し文にだけは出てはいけない。
  const RAW_INDUSTRY_LABEL: Record<Industry, string | null> = {
    飲食店: "飲食店",
    "美容・サロン": null, // 元から「サロン」に短縮済みで、業種名と見出し語が一致しないため対象外
    "教室・スクール": "教室・スクール",
    "小売・物販": "小売・物販",
    "修理・住まいのサービス": "修理・住まいのサービス",
    "士業・専門サービス": "士業・専門サービス",
    "不動産・建設": "不動産・建設",
    "医療・クリニック": "医療・クリニック",
    その他: null,
  };
  for (const skeleton of SKELETONS) {
    for (const industry of skeleton.industries) {
      const rawLabel = RAW_INDUSTRY_LABEL[industry];
      if (!rawLabel) continue;
      for (let i = 0; i < 20; i += 1) {
        const input = baseInput({
          industry,
          storeName: `見本の店${i}号`,
          address: i % 2 === 0 ? undefined : `東京都渋谷区代々木${i}-1-1`,
        });
        const palette = selectPalette(skeleton, input, false);
        const ctx = buildSkeletonContext(input, baseContent, skeleton, palette, undefined, false);
        assert.ok(
          !ctx.headline.includes(rawLabel),
          `${skeleton.key} / ${industry}: 見出しに業種ラベル「${rawLabel}」がそのまま出た → "${ctx.headline}"`,
        );
      }
    }
  }
});

test("看板: 見本の仮店名（あなたの◯◯（見本）」でも、見出しが「業種ラベル＋店名」の機械的な形にならない（実例site-0n6h0n0m4c相当の再現）", () => {
  const input = baseInput({
    industry: "小売・物販",
    storeName: "あなたの果樹園（見本）",
    address: undefined, // areaを外し、word単独パターンも踏ませる
  });
  const palette = selectPalette(KANBAN, input, false);
  const ctx = buildSkeletonContext(input, baseContent, KANBAN, palette, undefined, false);
  assert.ok(!ctx.headline.includes("小売・物販"), `見出しに「小売・物販」が直入れされた → "${ctx.headline}"`);
  // 言い換え後の「お店」も、見本の仮店名では「お店の◯◯です。」の形にしない（2026-08-19追加指摘）。
  assert.ok(!ctx.headline.startsWith("お店の"), `見出しが「お店の」から始まる機械的な形のまま → "${ctx.headline}"`);
  assert.ok(!ctx.headline.startsWith("小売・物販の"), `見出しが「小売・物販の」から始まる機械的な形のまま → "${ctx.headline}"`);
});

test("shouldDropHeadlineWord: 「お店」・店名との重複・見本の仮店名（あなたの〜）はword使用型を落とす", () => {
  assert.equal(shouldDropHeadlineWord(null, "麦の香"), false, "wordが無ければ落とす理由が無い");
  assert.equal(shouldDropHeadlineWord("お店", "麦の香"), true, "「お店」は一般名詞すぎるので常に落とす");
  assert.equal(shouldDropHeadlineWord("珈琲", "麦の香珈琲"), true, "wordが店名にも含まれるなら落とす（重複回避）");
  assert.equal(shouldDropHeadlineWord("サロン", "あなたの果樹園（見本）"), true, "店名が「あなたの」で始まる見本名なら落とす");
  assert.equal(shouldDropHeadlineWord("サロン", "麦の香"), false, "重複も見本名も無ければ落とさない");
});

test("店名に見出し語と同じ名詞が含まれるとき（例: 店名が「◯◯珈琲」でジャンル語も「珈琲」）、見出しはword使用型を避け店名主役の型になる", () => {
  // area.full = "東京都武蔵野市"（parseAreaのAREA_PATTERNは区市町村の1文字目にも
  // マッチしうるため、「〜区」を含む住所は区で打ち切られる。「市」止まりの町名なら安定する）。
  const AREA_FULL = "東京都武蔵野市";
  for (const skeleton of SKELETONS) {
    if (!skeleton.industries.includes("飲食店")) continue;
    for (let i = 0; i < 10; i += 1) {
      const input = baseInput({
        industry: "飲食店",
        storeName: `麦の香珈琲${i}`,
        address: `${AREA_FULL}吉祥寺本町${i}-1-1`,
        catchphrase: `${AREA_FULL}の珈琲`, // parseGenre で「珈琲」を拾わせる
      });
      const palette = selectPalette(skeleton, input, false);
      const ctx = buildSkeletonContext(input, baseContent, skeleton, palette, undefined, false);
      assert.ok(
        !ctx.headline.includes("珈琲の"),
        `${skeleton.key}: 見出しに「珈琲の」（店名と重複するジャンル語直入れ）が出た → "${ctx.headline}"`,
      );
    }
  }
});

test("看板: 「◯◯、はじめます。」は実在の店名（老舗にも出うる）では選ばれず、見本の仮店名（あなたの〜）でだけ出る（2026-08-19指摘: サンタマ地所の見本で老舗にも開店の言葉が出ていた不具合）", () => {
  // 実在の老舗を想定した店名で、area・wordの有無を変えつつ多数のseedを試し、
  // 一度も「はじめます」が出ないことを確認する。
  for (let i = 0; i < 30; i += 1) {
    const input = baseInput({
      industry: "小売・物販",
      storeName: "有限会社サンタマ地所",
      address: i % 3 === 0 ? undefined : `東京都杉並区阿佐谷南${i}-1-1`,
      catchphrase: i % 3 === 1 ? "" : "地域に根ざした不動産のご相談",
    });
    const palette = selectPalette(KANBAN, input, false);
    const ctx = buildSkeletonContext(input, baseContent, KANBAN, palette, undefined, false);
    assert.ok(
      !ctx.headline.includes("はじめます"),
      `実在店名なのに見出しが開店の言葉になった(i=${i}) → "${ctx.headline}"`,
    );
  }

  // 見本の仮店名（「あなたの」で始まる）では、area・wordが両方無いときに「はじめます」も候補に入り得る
  // （必ず選ばれるとは限らないので、複数seedを試して一度でも出ることだけを確認する）。
  let sawKaiten = false;
  for (let i = 0; i < 30; i += 1) {
    const input = baseInput({
      industry: "小売・物販",
      storeName: "あなたの果樹園（見本）",
      address: `東京都渋谷区代々木${i}-1-1`,
    });
    const palette = selectPalette(KANBAN, input, false);
    const ctx = buildSkeletonContext(input, baseContent, KANBAN, palette, undefined, false);
    if (ctx.headline.includes("はじめます")) sawKaiten = true;
  }
  assert.ok(sawKaiten, "見本の仮店名（あなたの〜）では「はじめます」型が候補から完全に消えている（落としすぎ）");
});

// ---- ⑦ VenueKindがshop以外（office/company/clinic）のとき、見出しに業種語を使わない
//     （実例: https://free-hp-engine.ryoseiworld.workers.dev/ の士業見本でh1が
//      「事務所、行政書士法人ドラゴンオフィス。」「事務所、税理士法人タックス・ワン。」に
//      なっていた不具合の修正。名称に「事務所」を含まない法人名だと接頭語として付いてしまっていた） ----

test("office/company/clinicでは見出し(h1相当)に業種語が接頭で付かず、名称主体になる", () => {
  const NON_SHOP_CASES = [
    { industry: "士業・専門サービス", storeName: "税理士法人タックス・ワン", droppedWord: "事務所" },
    { industry: "士業・専門サービス", storeName: "行政書士法人ドラゴンオフィス", droppedWord: "事務所" },
    { industry: "不動産・建設", storeName: "株式会社レスト", droppedWord: "会社" },
    { industry: "医療・クリニック", storeName: "医療法人あおぞら", droppedWord: "医院" },
  ] as const satisfies readonly { industry: Industry; storeName: string; droppedWord: string }[];

  for (const skeleton of SKELETONS) {
    for (const { industry, storeName, droppedWord } of NON_SHOP_CASES) {
      if (!skeleton.industries.includes(industry)) continue;
      for (let i = 0; i < 20; i += 1) {
        const input = baseInput({
          industry,
          storeName,
          address: i % 2 === 0 ? undefined : `東京都新宿区西新宿${i}-1-1`,
        });
        const palette = selectPalette(skeleton, input, false);
        const ctx = buildSkeletonContext(input, baseContent, skeleton, palette, undefined, false);
        assert.ok(
          !ctx.headline.includes(`${droppedWord}、`),
          `${skeleton.key}/${industry}/${storeName}(i=${i}): 見出しに「${droppedWord}、」が付いた → "${ctx.headline}"`,
        );
        assert.ok(
          ctx.headline.includes(storeName),
          `${skeleton.key}/${industry}/${storeName}(i=${i}): 見出しに店名が含まれない → "${ctx.headline}"`,
        );
      }
    }
  }
});

test("店名に「事務所」を含む場合（例: 乾行政書士事務所）は、見出しが店名だけの型になる（従来どおり）", () => {
  for (const skeleton of SKELETONS) {
    if (!skeleton.industries.includes("士業・専門サービス")) continue;
    for (let i = 0; i < 10; i += 1) {
      const input = baseInput({
        industry: "士業・専門サービス",
        storeName: "乾行政書士事務所",
        address: i % 2 === 0 ? undefined : `東京都新宿区西新宿${i}-1-1`,
      });
      const palette = selectPalette(skeleton, input, false);
      const ctx = buildSkeletonContext(input, baseContent, skeleton, palette, undefined, false);
      assert.ok(!ctx.headline.includes("事務所、"), `${skeleton.key}(i=${i}): 見出しに「事務所、」が付いた → "${ctx.headline}"`);
      assert.ok(ctx.headline.includes("乾行政書士事務所"), `${skeleton.key}(i=${i}): 見出しに店名が含まれない → "${ctx.headline}"`);
    }
  }
});

// ---- ⑧ office/company/clinicの業種バッジ（class="industry"）は審査カテゴリ名でなく名称由来の職種語 ----

test("業種バッジ(ctx.word)はoffice/company/clinicで名称由来の職種語になり、審査カテゴリ名のままにならない", () => {
  const officeInput = baseInput({ industry: "士業・専門サービス", storeName: "税理士法人タックス・ワン" });
  const officeCtx = buildSkeletonContext(officeInput, baseContent, TANZAKU, selectPalette(TANZAKU, officeInput, false), undefined, false);
  assert.equal(officeCtx.word, "税理士", "officeのバッジ語が名称由来の職種語になっていない");

  const companyInput = baseInput({ industry: "不動産・建設", storeName: "株式会社Reliable不動産" });
  const companyCtx = buildSkeletonContext(companyInput, baseContent, TANZAKU, selectPalette(TANZAKU, companyInput, false), undefined, false);
  assert.equal(companyCtx.word, "不動産", "companyのバッジ語が名称由来の職種語になっていない");

  const html = renderSite(officeInput, baseContent, { skeleton: "短冊" });
  assert.ok(html.includes('<p class="kuni industry">税理士</p>'), "短冊のバッジ要素に「税理士」が出ていない");
  assert.ok(!html.includes('士業・専門サービス'), "審査カテゴリ名がそのままHTMLに出ている");
});

test("shop業種（飲食店等）のバッジ語・見出し語は既存仕様のまま変わらない（word=null化・badgeWordForはoffice/company/clinic限定）", () => {
  const cafeInput = baseInput({
    industry: "飲食店",
    storeName: "麦の香珈琲",
    catchphrase: "東京都武蔵野市のカフェ", // parseGenreでジャンル語「カフェ」を拾わせる（住所は既定のbaseInputのまま）
  });
  const cafeCtx = buildSkeletonContext(cafeInput, baseContent, TANZAKU, selectPalette(TANZAKU, cafeInput, false), undefined, false);
  assert.equal(cafeCtx.word, "カフェ", "shopのバッジ語はジャンル語優先の従来仕様のまま");

  const noGenreInput = baseInput({ industry: "飲食店", storeName: "麦の香" });
  const noGenreCtx = buildSkeletonContext(noGenreInput, baseContent, TANZAKU, selectPalette(TANZAKU, noGenreInput, false), undefined, false);
  assert.equal(noGenreCtx.word, "飲食店", "shopのバッジ語のフォールバック（業種ラベル）が従来仕様のまま");
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
