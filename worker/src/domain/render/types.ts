import type { Industry, SampleSource } from "../validate.ts";
import type { VenueKind } from "./venue.ts";

export type { SampleSource };

export type SkeletonKey = "名刺" | "暖簾" | "短冊" | "方眼" | "看板";
export type Temperature = "warm" | "calm" | "fresh" | "lively" | "moody";

export interface Palette {
  /** デバッグ用の名前。<body data-配色> に出す */
  readonly key: string;
  /** input.colorTheme（あたたかい/落ち着いた/さわやか/たのしい/しっとり）との対応 */
  readonly temp: Temperature;
  /** CSSカスタムプロパティ。キーは "--" を含まない */
  readonly vars: Readonly<Record<string, string>>;
  /** ファビコンの地色 */
  readonly mark: string;
}

export interface Area {
  readonly pref: string; // 東京都
  readonly city: string; // 武蔵野市
  readonly full: string; // 東京都武蔵野市
}

export interface HeadlineParts {
  readonly store: string;
  /** 市区町村だけ。取れなければ undefined */
  readonly area?: string;
  /** ジャンル語（カフェ）→無ければ業種表示語。「その他」で機械文でなければ undefined */
  readonly word?: string;
}

/** 使えない部品があるときは null を返す。呼び出し側が候補から除外する */
export type HeadlinePattern = (parts: HeadlineParts) => string | null;

export interface ContactRow {
  readonly kind: "phone" | "address" | "hours";
  /** <a href="tel:..."> 等を含む、エスケープ済みHTML */
  readonly valueHtml: string;
}

export interface PhotoInfo {
  readonly srcHtml: string; // エスケープ済みのsrc
  readonly altHtml: string;
  readonly aspect: string; // "16 / 10"
  readonly maxWidth: string; // "100%"
}

export type ActionKind = "reserve" | "instagram" | "line";

/**
 * 予約・Instagram・LINE公式の行動ボタン。
 * href は render/parts.ts でこちらが組み立てた上でエスケープ済み。骨格側は input を直接読まない。
 */
export interface ActionLink {
  readonly kind: ActionKind;
  readonly label: string;
  readonly href: string;
}

/** menuText を1行ずつ解釈した品目。文字列はどちらもエスケープ済み。 */
export interface MenuItem {
  readonly name: string;
  readonly price: string | null;
}

/**
 * 骨格に渡す材料。文字列はすべてHTMLエスケープ済み。
 * 骨格側で escapeHtml を呼んではいけない（二重エスケープになる）。
 * 骨格側から input / content を直接読んでもいけない（生の値が漏れる）。
 */
export interface SkeletonContext {
  readonly venueKind: VenueKind;
  readonly headline: string;
  readonly lead: string; // クリシェ除去後。落ちたら ""
  readonly tagline: string; // 店主自筆と判定できたときだけ。機械文なら ""
  readonly about: string;
  readonly highlights: readonly string[]; // クリシェ除去後。空なら節ごと出さない
  /** 入力が無いときは空配列。name / price は parts.ts でエスケープ済み。 */
  readonly menuItems: readonly MenuItem[];
  readonly closing: string;
  readonly storeName: string;
  readonly dyedText: string | null; // 暖簾の染め抜き・短冊の縦組みに使う文字
  readonly dyedMaxRem: number; // 上の文字数から決めた最大フォントサイズ
  readonly nameMaxRem: number; // 看板が店名をまるごと（切り詰めず）表示するときの最大フォントサイズ（Issue #4）
  readonly initial: string | null; // 印・空押しに使う頭1文字（絵文字等ならnull）
  readonly areaFull: string; // 東京都武蔵野市。無ければ ""
  readonly word: string; // カフェ / 飲食店 / サロン / 教室・スクール等。無ければ ""
  readonly contactRows: readonly ContactRow[];
  /** 予約・Instagram・LINE公式。1つも無ければ空配列（骨格側は空なら列ごと出さない）。 */
  readonly actions: readonly ActionLink[];
  readonly photo: PhotoInfo | null;
  readonly isSample: boolean;
  /** 見本ページ下部の断り書き（sampleNoticeOf由来）。isSampleがfalseなら ""。 */
  readonly sampleNoticeHtml: string;
  readonly palette: Palette;
}

export interface Skeleton {
  readonly key: SkeletonKey;
  readonly industries: readonly Industry[];
  readonly palettes: readonly Palette[];
  readonly headings: { readonly about: string; readonly highlights: string; readonly closing: string };
  readonly contactLabels: { readonly phone: string; readonly address: string; readonly hours: string };
  readonly headlines: readonly HeadlinePattern[];
  /** パレット非依存の静的CSS。色は var(--x) 経由でしか触らない */
  readonly css: string;
  readonly body: (ctx: SkeletonContext) => string;
}
