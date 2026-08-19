import assert from "node:assert/strict";
import test from "node:test";
import { qaContent, sanitizeVenueTerms, VENUE_LANGUAGE_QA_REASON } from "../src/domain/qa.ts";
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
