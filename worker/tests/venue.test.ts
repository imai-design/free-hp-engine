import assert from "node:assert/strict";
import test from "node:test";
import { CATEGORY_LEAK_QA_REASON, qaContent, sanitizeCategoryLeak, sanitizeVenueTerms, VENUE_LANGUAGE_QA_REASON } from "../src/domain/qa.ts";
import { footerHtml, sampleNoticeOf } from "../src/domain/render/parts.ts";
import { badgeWordFor, resolveVenueKind, venueNoun, type VenueKind } from "../src/domain/render/venue.ts";
import {
  buildSystemPrompt,
  generateContentAnthropic,
  generateContentWorkersAi,
  type GeneratedContent,
} from "../src/generation/provider.ts";
import type { Industry, SiteInput } from "../src/domain/validate.ts";

function input(industry: Industry, storeName: string): SiteInput {
  return {
    storeName,
    industry,
    catchphrase: "地域の相談に丁寧に対応します。",
    description: "相談内容を確認し、必要な手続きを案内します。",
    colorTheme: "落ち着いた",
  };
}

const safeContent: GeneratedContent = {
  subheadline: "行政書士 柴田事務所が地域の相談に対応します。",
  aboutText: "相談内容を確認し、必要な手続きを案内します。",
  highlights: ["一件ずつ内容を確認します"],
  closingText: "まずはご相談ください。",
};

test("resolveVenueKindは明示業種を優先し、「その他」だけ名称キーワードでoffice/company/clinicを判定する", () => {
  const explicitCases = [
    ["飲食店", "shop"],
    ["美容・サロン", "shop"],
    ["教室・スクール", "shop"],
    ["小売・物販", "shop"],
    ["修理・住まいのサービス", "shop"],
    ["士業・専門サービス", "office"],
    ["不動産・建設", "company"],
    ["医療・クリニック", "clinic"],
  ] as const satisfies readonly (readonly [Exclude<Industry, "その他">, VenueKind])[];
  for (const [industry, expected] of explicitCases) {
    assert.equal(resolveVenueKind(industry, "株式会社お店クリニック事務所"), expected, industry);
  }

  const keywordCases = [
    ["行政書士 柴田事務所", "office"],
    ["山田税理士・会計士オフィス", "office"],
    ["弁護士法人 法律・特許相談", "office"],
    ["社会保険労務士（社労士）佐藤", "office"],
    ["サンタマ地所 不動産", "company"],
    ["株式会社みらい建設工務店", "company"],
    ["有限会社ハウスコーポレーション", "company"],
    ["青空クリニック・医院", "clinic"],
    ["まちの歯科診療所", "clinic"],
  ] as const satisfies readonly (readonly [string, VenueKind])[];
  for (const [storeName, expected] of keywordCases) {
    assert.equal(resolveVenueKind("その他", storeName), expected, storeName);
  }
  assert.equal(resolveVenueKind("その他", "まちの仕事場"), "shop");
});

test("badgeWordFor: 非店舗（office/company/clinic）のバッジ語は名称→キャッチコピー→venueNounの順で職種語を拾う（審査カテゴリ名の機械的表示を避ける）", () => {
  assert.equal(badgeWordFor("office", "税理士法人タックス・ワン", ""), "税理士", "名称から税理士を拾えていない");
  assert.equal(badgeWordFor("office", "行政書士法人ドラゴンオフィス", ""), "行政書士", "名称から行政書士を拾えていない");
  assert.equal(badgeWordFor("company", "株式会社Reliable不動産", ""), "不動産", "名称から不動産を拾えていない");
  assert.equal(
    badgeWordFor("company", "株式会社レスト", "新宿区の不動産会社"),
    "不動産",
    "名称に無ければキャッチコピーから不動産を拾えていない",
  );
  assert.equal(
    badgeWordFor("company", "株式会社ABC", "杉並区の会社"),
    "会社",
    "名称にもキャッチコピーにも無ければvenueNoun（会社）にフォールバックしていない",
  );
  assert.equal(badgeWordFor("clinic", "青空歯科クリニック", ""), "クリニック", "語群の並び順（先に当たった語）が違う");
  assert.equal(badgeWordFor("clinic", "まちの内科", ""), "内科", "名称から内科を拾えていない");
  assert.equal(badgeWordFor("clinic", "まちの診療所", "地域のかかりつけ医院"), "医院", "キャッチコピーから医院を拾えていない");

  for (const [kind, storeName, catchphrase] of [
    ["office", "税理士法人タックス・ワン", ""],
    ["company", "株式会社Reliable不動産", ""],
    ["clinic", "青空歯科クリニック", ""],
  ] as const satisfies readonly (readonly [Exclude<VenueKind, "shop">, string, string])[]) {
    const badge = badgeWordFor(kind, storeName, catchphrase);
    assert.ok(badge.length >= 2 && badge.length <= 8, `${kind}: バッジ語の文字数が2〜8文字の範囲外 → "${badge}"`);
  }
});

test("venueNounは4種類を利用者向けの日本語名詞へ対応させる", () => {
  assert.deepEqual(
    Object.fromEntries((["shop", "office", "company", "clinic"] as const).map((kind) => [kind, venueNoun(kind)])),
    { shop: "お店", office: "事務所", company: "会社", clinic: "医院" },
  );
});

test("見本注記とフッターはVenueKindの名詞を使い、非店舗では「お店」を表示しない", () => {
  for (const kind of ["office", "company", "clinic"] as const) {
    const noun = venueNoun(kind);
    const wording = [sampleNoticeOf("map", kind), sampleNoticeOf("threads", kind), footerHtml(true, kind), footerHtml(false, kind)].join("\n");
    assert.ok(wording.includes(noun), `${kind}: ${noun}が文言に使われていない`);
    assert.doesNotMatch(wording, /お店/u, `${kind}: 店舗向け文言が残っている`);
  }
  assert.ok(sampleNoticeOf("map").includes("お店に伺って"), "既定値shopの後方互換が崩れている");
  assert.ok(footerHtml(true).includes("そのままお店のものとして"), "既定値shopの後方互換が崩れている");
});

test("SYSTEM_PROMPTはVenueKindごとの主体・特徴・closingText語彙に切り替わる", () => {
  const cases = [
    ["shop", ["小さなお店・活動", "そのお店ならでは", "来店を待つ気持ち"]],
    ["office", ["事務所の紹介サイト", "その事務所ならでは", "ご相談を待つ気持ち"]],
    ["company", ["会社の紹介サイト", "その会社ならでは", "お問い合わせを待つ気持ち"]],
    ["clinic", ["医院の紹介サイト", "その医院ならでは", "ご来院を待つ気持ち"]],
  ] as const satisfies readonly (readonly [VenueKind, readonly string[]])[];
  for (const [kind, phrases] of cases) {
    const prompt = buildSystemPrompt(kind);
    for (const phrase of phrases) assert.ok(prompt.includes(phrase), `${kind}: 「${phrase}」がない`);
    if (kind !== "shop") assert.ok(prompt.includes("来店・ご来店・お店という語は使わない"));
  }
});

test("Workers AIとAnthropicの呼び出しは入力から解決したVenueKindのプロンプトを渡す", async () => {
  let workersOptions: Record<string, unknown> | undefined;
  await generateContentWorkersAi(input("その他", "行政書士 柴田事務所"), {
    AI: {
      async run(_model, options) {
        workersOptions = options;
        return { response: safeContent };
      },
    },
  });
  const workersMessages = workersOptions?.messages as { role: string; content: string }[];
  assert.ok(workersMessages[0].content.includes("事務所の紹介サイト"));
  assert.ok(workersMessages[1].content.includes("名称と業種"));

  let anthropicBody: Record<string, unknown> | undefined;
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    anthropicBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(safeContent) }] }));
  }) as typeof fetch;
  await generateContentAnthropic(input("不動産・建設", "柴田不動産株式会社"), { ANTHROPIC_API_KEY: "test" }, fakeFetch);
  assert.ok(String(anthropicBody?.system).includes("会社の紹介サイト"));
  const anthropicMessages = anthropicBody?.messages as { role: string; content: string }[];
  assert.ok(anthropicMessages[0].content.includes("名称と業種"));
});

test("非店舗（office）のLLMプロンプトには審査カテゴリ名を渡さず、名称から拾った実際の職種語を渡す", async () => {
  let anthropicBody: Record<string, unknown> | undefined;
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    anthropicBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(safeContent) }] }));
  }) as typeof fetch;
  await generateContentAnthropic(
    input("士業・専門サービス", "山田太郎税理士事務所"),
    { ANTHROPIC_API_KEY: "test" },
    fakeFetch,
  );
  const userContent = (anthropicBody?.messages as { role: string; content: string }[])[0].content;
  assert.doesNotMatch(userContent, /士業・専門サービス/u, "審査カテゴリ名がプロンプトに残っている");
  assert.match(userContent, /"industry":"税理士"/u, "名称から拾った職種語（税理士）がプロンプトにない");

  let workersOptions: Record<string, unknown> | undefined;
  await generateContentWorkersAi(input("不動産・建設", "サンタマ地所不動産株式会社"), {
    AI: {
      async run(_model, options) {
        workersOptions = options;
        return { response: safeContent };
      },
    },
  });
  const workersUserContent = (workersOptions?.messages as { role: string; content: string }[])[1].content;
  assert.doesNotMatch(workersUserContent, /不動産・建設/u, "審査カテゴリ名がプロンプトに残っている");
  assert.match(workersUserContent, /"industry":"不動産"/u, "名称から拾った職種語（不動産）がプロンプトにない");

  // shopは従来どおり業種名をそのまま渡す（後方互換）。
  let shopBody: Record<string, unknown> | undefined;
  const shopFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    shopBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(safeContent) }] }));
  }) as typeof fetch;
  await generateContentAnthropic(input("飲食店", "柴田食堂"), { ANTHROPIC_API_KEY: "test" }, shopFetch);
  const shopUserContent = (shopBody?.messages as { role: string; content: string }[])[0].content;
  assert.match(shopUserContent, /"industry":"飲食店"/u, "shopの業種名がプロンプトから消えている");
});

test("QAは非店舗の生成4項目に店舗語があれば落とし、最終フォールバックはVenueKind別の語へ置換する", () => {
  const badContent: GeneratedContent = {
    subheadline: "行政書士 柴田事務所は地域のお店です。",
    aboutText: "初めて来店する方にも説明します。",
    highlights: ["ご来店前に内容を確認します"],
    closingText: "皆様のご来店を心よりお待ちしております。",
  };
  const officeInput = input("その他", "行政書士 柴田事務所");
  assert.deepEqual(qaContent(badContent, officeInput), { ok: false, reason: VENUE_LANGUAGE_QA_REASON });
  assert.equal(
    qaContent({ ...badContent, subheadline: "柴田食堂は地域のお店です。" }, input("飲食店", "柴田食堂")).ok,
    true,
    "shopまで不合格にしている",
  );

  const cases = [
    [officeInput, "事務所", "ご相談"],
    [input("不動産・建設", "柴田不動産"), "会社", "お問い合わせ"],
    [input("医療・クリニック", "柴田クリニック"), "医院", "ご来院"],
  ] as const satisfies readonly (readonly [SiteInput, string, string])[];
  for (const [siteInput, noun, visit] of cases) {
    const sanitized = sanitizeVenueTerms({ ...badContent, subheadline: `${siteInput.storeName}は地域のお店です。` }, siteInput);
    const combined = [sanitized.subheadline, sanitized.aboutText, ...sanitized.highlights, sanitized.closingText].join("\n");
    assert.ok(combined.includes(noun));
    assert.ok(combined.includes(visit));
    assert.doesNotMatch(combined, /ご来店|来店|お店/u);
    assert.equal(qaContent(sanitized, siteInput).ok, true);
  }
});

test("QAは審査カテゴリ名（士業・専門サービス／不動産・建設／医療・クリニック）の混入を弾き、最終フォールバックはbadge語へ機械置換する", () => {
  const officeInput = input("士業・専門サービス", "山田太郎税理士事務所");
  const officeLeak: GeneratedContent = {
    subheadline: "山田太郎税理士事務所は、士業・専門サービスとして地域の相談に対応します。",
    aboutText: "税務や相続の相談に、経験豊富なスタッフが対応します。",
    highlights: ["丁寧なヒアリングを行います"],
    closingText: "まずはご相談ください。",
  };
  assert.deepEqual(qaContent(officeLeak, officeInput), { ok: false, reason: CATEGORY_LEAK_QA_REASON });

  const companyInput = input("不動産・建設", "サンタマ地所不動産株式会社");
  const companyLeak: GeneratedContent = {
    ...officeLeak,
    subheadline: "サンタマ地所不動産株式会社は、不動産・建設として地域に貢献します。",
  };
  assert.deepEqual(qaContent(companyLeak, companyInput), { ok: false, reason: CATEGORY_LEAK_QA_REASON });

  const clinicInput = input("医療・クリニック", "青空クリニック");
  const clinicLeak: GeneratedContent = {
    ...officeLeak,
    subheadline: "青空クリニックは、医療・クリニックとして地域の健康を支えます。",
  };
  assert.deepEqual(qaContent(clinicLeak, clinicInput), { ok: false, reason: CATEGORY_LEAK_QA_REASON });

  const cases = [
    [officeInput, officeLeak, "税理士"],
    [companyInput, companyLeak, "不動産"],
    [clinicInput, clinicLeak, "クリニック"],
  ] as const satisfies readonly (readonly [SiteInput, GeneratedContent, string])[];
  for (const [siteInput, content, badgeWord] of cases) {
    const sanitized = sanitizeCategoryLeak(content, siteInput);
    const combined = [sanitized.subheadline, sanitized.aboutText, ...sanitized.highlights, sanitized.closingText].join("\n");
    assert.doesNotMatch(combined, /士業・専門サービス|不動産・建設|医療・クリニック/u, `${siteInput.storeName}: カテゴリ名が残っている`);
    assert.ok(combined.includes(badgeWord), `${siteInput.storeName}: badge語（${badgeWord}）に置換されていない`);
    assert.equal(qaContent(sanitized, siteInput).ok, true, `${siteInput.storeName}: 置換後もQAに通らない`);
  }

  // shopは業種名がそのまま出てもよく、この検出対象の3語自体が出ることも無い（後方互換の確認）。
  const shopOk = qaContent(
    { ...safeContent, subheadline: "柴田食堂は飲食店として地域に愛されています。" },
    input("飲食店", "柴田食堂"),
  );
  assert.equal(shopOk.ok, true);
});
