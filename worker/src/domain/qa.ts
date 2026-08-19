import type { GeneratedContent } from "../generation/provider.ts";
import type { SiteInput } from "./validate.ts";
import { resolveVenueKind, venueNoun, type VenueKind } from "./render/venue.ts";

export interface QaResult {
  ok: boolean;
  reason?: string;
}

const PLACEHOLDER_PATTERN = /\{\{|\}\}|\[insert|\[ここ|ここに.{0,8}(入|書)|lorem ipsum|undefined|null/iu;
const PROMPT_LEAK_PATTERN = /system prompt|ignore (all|previous)|api key|script\s*>/iu;
const SHOP_ONLY_TERM_PATTERN = /ご来店|来店|お店/u;
export const VENUE_LANGUAGE_QA_REASON = "shop-only wording was used for a non-shop venue";

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
