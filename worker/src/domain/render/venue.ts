import type { Industry } from "../validate.ts";

export type VenueKind = "shop" | "office" | "company" | "clinic";

const VENUE_KIND_BY_INDUSTRY: Readonly<Record<Exclude<Industry, "その他">, VenueKind>> = {
  飲食店: "shop",
  "美容・サロン": "shop",
  "教室・スクール": "shop",
  "小売・物販": "shop",
  "修理・住まいのサービス": "shop",
  "士業・専門サービス": "office",
  "不動産・建設": "company",
  "医療・クリニック": "clinic",
};

const OFFICE_NAME_PATTERN = /事務所|税理士|行政書士|司法書士|弁護士|社労士|会計士|法律|特許/u;
const COMPANY_NAME_PATTERN = /不動産|地所|建設|工務店|ハウス|株式会社|有限会社|合同会社|コーポレーション/u;
const CLINIC_NAME_PATTERN = /クリニック|医院|歯科|診療所/u;

/** 「その他」だけは名称から実態を補い、明示された業種は常にそちらを優先する。 */
export function resolveVenueKind(industry: Industry, storeName: string): VenueKind {
  if (industry !== "その他") return VENUE_KIND_BY_INDUSTRY[industry];
  if (OFFICE_NAME_PATTERN.test(storeName)) return "office";
  if (COMPANY_NAME_PATTERN.test(storeName)) return "company";
  if (CLINIC_NAME_PATTERN.test(storeName)) return "clinic";
  return "shop";
}

const VENUE_NOUNS: Readonly<Record<VenueKind, string>> = {
  shop: "お店",
  office: "事務所",
  company: "会社",
  clinic: "医院",
};

export function venueNoun(kind: VenueKind): string {
  return VENUE_NOUNS[kind];
}

export interface VenueHeadings {
  readonly about: string;
  readonly highlights: string;
  readonly closing: string;
}

const NON_SHOP_HEADINGS: Readonly<Record<Exclude<VenueKind, "shop">, VenueHeadings>> = {
  office: { about: "業務内容", highlights: "主なご相談", closing: "ご相談の前に" },
  company: { about: "事業内容", highlights: "取り扱い", closing: "お問い合わせの前に" },
  clinic: { about: "診療内容", highlights: "主な診療", closing: "ご来院の前に" },
};

/** 店舗向けの既存見出しはそのまま残し、非店舗だけ共通の見出しへ差し替える。 */
export function headingsForVenue(kind: VenueKind, shopHeadings: VenueHeadings): VenueHeadings {
  return kind === "shop" ? shopHeadings : NON_SHOP_HEADINGS[kind];
}

// ---- 非店舗（office/company/clinic）のバッジ語 ----
//
// 業種バッジ（class="industry"）が審査カテゴリ名（例:「士業・専門サービス」）そのままだと
// 機械的になる（2026-08-19指摘）。名称・キャッチコピーから実際の職種語を拾い、それも
// 無ければ venueNoun（事務所/会社/医院）にする。判定順は先に当たった語を採用する。
const OFFICE_BADGE_WORDS = [
  "行政書士",
  "税理士",
  "社会保険労務士",
  "社労士",
  "司法書士",
  "弁護士",
  "公認会計士",
  "弁理士",
  "土地家屋調査士",
] as const;
const COMPANY_BADGE_WORDS = ["不動産", "工務店", "リフォーム", "建設", "建築", "ハウス"] as const;
const CLINIC_BADGE_WORDS = ["クリニック", "歯科", "内科", "皮膚科", "整形外科", "医院"] as const;

const BADGE_WORDS_BY_KIND: Readonly<Record<Exclude<VenueKind, "shop">, readonly string[]>> = {
  office: OFFICE_BADGE_WORDS,
  company: COMPANY_BADGE_WORDS,
  clinic: CLINIC_BADGE_WORDS,
};

function findBadgeWord(words: readonly string[], text: string): string | null {
  return words.find((word) => text.includes(word)) ?? null;
}

/** 名称→キャッチコピー→venueNoun の順で、非店舗のバッジ語（2〜8文字）を決める。 */
export function badgeWordFor(kind: Exclude<VenueKind, "shop">, storeName: string, catchphrase: string): string {
  const words = BADGE_WORDS_BY_KIND[kind];
  return findBadgeWord(words, storeName) ?? findBadgeWord(words, catchphrase) ?? venueNoun(kind);
}
