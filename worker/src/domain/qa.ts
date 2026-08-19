import type { GeneratedContent } from "../generation/provider.ts";
import type { SiteInput } from "./validate.ts";
import { badgeWordFor, resolveVenueKind, venueNoun, type VenueKind } from "./render/venue.ts";

export interface QaResult {
  ok: boolean;
  reason?: string;
}

const PLACEHOLDER_PATTERN = /\{\{|\}\}|\[insert|\[ここ|ここに.{0,8}(入|書)|lorem ipsum|undefined|null/iu;
const PROMPT_LEAK_PATTERN = /system prompt|ignore (all|previous)|api key|script\s*>/iu;
const SHOP_ONLY_TERM_PATTERN = /ご来店|来店|お店/u;
export const VENUE_LANGUAGE_QA_REASON = "shop-only wording was used for a non-shop venue";

// 審査カテゴリ名（INDUSTRIESの表示名）がLLM生成文にそのまま混入する不具合対策（2026-08-19実物）。
// provider.tsのプロンプトでは非店舗（office/company/clinic）にbadgeWordForを渡すよう直したが、
// LLMが指示を無視してカテゴリ名を書いてしまう場合に備え、QA側でも検出・機械置換する。
const CATEGORY_LEAK_WORDS = ["士業・専門サービス", "不動産・建設", "医療・クリニック"] as const;
const CATEGORY_LEAK_PATTERN = /士業・専門サービス|不動産・建設|医療・クリニック/u;
export const CATEGORY_LEAK_QA_REASON = "industry category label leaked into generated content";

const CATEGORY_LEAK_KIND: Readonly<Record<(typeof CATEGORY_LEAK_WORDS)[number], Exclude<VenueKind, "shop">>> = {
  "士業・専門サービス": "office",
  "不動産・建設": "company",
  "医療・クリニック": "clinic",
};

const VISIT_REPLACEMENT: Readonly<Record<Exclude<VenueKind, "shop">, string>> = {
  office: "ご相談",
  company: "お問い合わせ",
  clinic: "ご来院",
};

/** QAリトライでも直らなかった非店舗向け文言を、最後に安全な語へ寄せる。 */
export function sanitizeVenueTerms(content: GeneratedContent, input: SiteInput): GeneratedContent {
  const venueKind = resolveVenueKind(input.industry, input.storeName);
  if (venueKind === "shop") return content;
  const visit = VISIT_REPLACEMENT[venueKind];
  const noun = venueNoun(venueKind);
  // 文脈解析をしない意図的な簡略化で、誤った店舗語を公開しないことを優先する。
  const sanitize = (value: string): string => value
    .replace(/ご来店|来店/gu, visit)
    .replace(/お店/gu, noun);
  return {
    subheadline: sanitize(content.subheadline),
    aboutText: sanitize(content.aboutText),
    highlights: content.highlights.map(sanitize),
    closingText: sanitize(content.closingText),
  };
}

/** QAリトライでも直らなかった審査カテゴリ名の混入を、最後にbadgeWordFor（実際の職種語）へ機械置換する。 */
export function sanitizeCategoryLeak(content: GeneratedContent, input: SiteInput): GeneratedContent {
  // 文脈解析をしない意図的な簡略化で、混入したカテゴリ名を安全な語へ機械的に寄せることを優先する。
  const sanitize = (value: string): string =>
    CATEGORY_LEAK_WORDS.reduce((acc, word) => {
      if (!acc.includes(word)) return acc;
      const replacement = badgeWordFor(CATEGORY_LEAK_KIND[word], input.storeName, input.catchphrase);
      return acc.split(word).join(replacement);
    }, value);
  return {
    subheadline: sanitize(content.subheadline),
    aboutText: sanitize(content.aboutText),
    highlights: content.highlights.map(sanitize),
    closingText: sanitize(content.closingText),
  };
}

export function qaContent(content: GeneratedContent, input: SiteInput): QaResult {
  const required = [content.subheadline, content.aboutText, content.closingText];
  if (required.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    return { ok: false, reason: "required generated field is empty" };
  }
  // 下限を見ていなかったので、空配列がそのまま通って「大切にしていること」が中身ゼロの箱として出荷されていた。
  if (
    !Array.isArray(content.highlights) ||
    content.highlights.length < 1 ||
    content.highlights.length > 3 ||
    content.highlights.some((value) => typeof value !== "string" || !value.trim())
  ) {
    return { ok: false, reason: "highlights has an invalid shape" };
  }
  const combined = [...required, ...content.highlights].join("\n");
  if (PLACEHOLDER_PATTERN.test(combined)) return { ok: false, reason: "placeholder text remained" };
  if (PROMPT_LEAK_PATTERN.test(combined)) return { ok: false, reason: "prompt or unsafe text remained" };
  if (CATEGORY_LEAK_PATTERN.test(combined)) return { ok: false, reason: CATEGORY_LEAK_QA_REASON };
  const venueKind = resolveVenueKind(input.industry, input.storeName);
  if (venueKind !== "shop" && SHOP_ONLY_TERM_PATTERN.test(combined)) {
    return { ok: false, reason: VENUE_LANGUAGE_QA_REASON };
  }
  if (![input.storeName, input.industry, input.catchphrase].some((needle) => combined.includes(needle))) {
    return { ok: false, reason: "generated content is not related to the submitted business" };
  }
  if (combined.length > 6000) return { ok: false, reason: "generated content is too long" };
  return { ok: true };
}
