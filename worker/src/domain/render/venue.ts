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
