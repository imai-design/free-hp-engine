import type { GeneratedContent } from "../../generation/provider.ts";
import { readImageSize, type ImageSize, type PhotoShape } from "../imageSize.ts";
import type { Industry, SampleSource, SiteInput } from "../validate.ts";
import { pickIndex, seedOf } from "./hash.ts";
import { buildHeadline } from "./headline.ts";
import { resolveVenueKind, venueNoun, type VenueKind } from "./venue.ts";
import type {
  ActionLink,
  Area,
  ContactRow,
  HeadlineParts,
  MenuItem,
  Palette,
  PhotoInfo,
  Skeleton,
  SkeletonContext,
} from "./types.ts";

// ---- HTMLエスケープ（唯一の実装。骨格側からは呼ばない） ----

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] as string);
}

// ---- 住所から地域を取る（実住所16件で検証済み） ----

const AREA_PATTERN = /(北海道|東京都|(?:京都|大阪)府|.{2,3}県)\s*([^\s0-9０-９]{1,10}?[市区町村])/u;
const COUNTY_PREFIX = /^.{1,4}郡/u;
const CITY_MAX_LENGTH = 8;

export function parseArea(address: string | undefined): Area | null {
  if (!address) return null;
  const match = address.match(AREA_PATTERN);
  if (!match) return null;
  // 「北海道虻田郡倶知安町」→「倶知安町」。郡を残すと札に入らない。
  const city = match[2].replace(COUNTY_PREFIX, "");
  if (!city || city.length > CITY_MAX_LENGTH) return null;
  return { pref: match[1], city, full: `${match[1]}${city}` };
}

// ---- キャッチコピーの正体判定 → ジャンル語 ----
//
// 見本バッチの catchphrase は地図データから機械的に組んだ「{都道府県}{市区町村}の{ジャンル}」であって、
// 店主が書いた1行ではない。地域名で始まるときだけ後半をジャンル語として取り出し、
// 取り出せた場合はキャッチコピー欄として表示しない（h1に吸収されるため）。

const GENRE_MAX_LENGTH = 8;
const GENRE_STOP_PATTERN = /[。、．，!！?？\s]/u;

export function parseGenre(catchphrase: string, area: Area | null): string | null {
  if (!area || !catchphrase.startsWith(area.full)) return null;
  const rest = catchphrase.slice(area.full.length).replace(/^の/u, "").trim();
  if (!rest || rest.length > GENRE_MAX_LENGTH || GENRE_STOP_PATTERN.test(rest)) return null;
  return rest;
}

/** ジャンル語が取れた＝機械が組んだ文なので、店主の言葉としては出さない。 */
export const isOwnerVoice = (catchphrase: string, area: Area | null): boolean =>
  parseGenre(catchphrase, area) === null;

// ---- 業種語 ----
//
// kanban__meta 等の「小売・物販／東京都渋谷区」のようなラベル行では、審査カテゴリの名前を
// そのまま出す（バッジ表示なので機械的でもよい・むしろ業種を明示する役目）。

const INDUSTRY_WORDS: Record<Industry, string | null> = {
  飲食店: "飲食店",
  "美容・サロン": "サロン", // 「・」は木札・縦組み・小さい札で割れて壊れて見える
  "教室・スクール": "教室・スクール",
  "小売・物販": "小売・物販",
  "修理・住まいのサービス": "修理・住まいのサービス",
  "士業・専門サービス": "士業・専門サービス",
  "不動産・建設": "不動産・建設",
  "医療・クリニック": "医療・クリニック",
  その他: null, // 店が自分のページで「その他」と名乗ることになるので出さない
};

/** ジャンル語（カフェ）を最優先、無ければ業種語。どちらも無ければ null。 */
export const resolveWord = (genre: string | null, industry: Industry): string | null =>
  genre ?? INDUSTRY_WORDS[industry];

// ---- 見出し（h1相当）専用の業種語 ----
//
// HEADLINES は自然文（「◯◯の△△です。」）に組み込むため、上の INDUSTRY_WORDS
// をそのまま使うと「小売・物販のあなたの果樹園（見本）です。」のように審査カテゴリの
// 札が地の文に直入れされて機械的になる（2026-08-19指摘、実例：
// https://free-hp-engine.ryoseiworld.workers.dev/s/site-0n6h0n0m4c ）。
// 見出しにだけ、文として自然に置ける言い方に言い換えたものを渡す。
const HEADLINE_INDUSTRY_WORDS: Record<Industry, string | null> = {
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

/** 見出し文用のジャンル語（カフェ）を最優先、無ければ見出し用に言い換えた業種語。どちらも無ければ null。 */
export const resolveHeadlineWord = (genre: string | null, industry: Industry): string | null =>
  genre ?? HEADLINE_INDUSTRY_WORDS[industry];

// ---- 見出し語と店名の重複回避（2026-08-19追加指摘）----
//
// resolveHeadlineWord で「お店」等に言い換えても、次の2パターンはまだ機械的になる。
//  1. word が「お店」: 「お店の◯◯です。」は一般名詞すぎてキャッチコピーとして不自然。
//  2. word（またはジャンル語）が店名にも現れる: 「珈琲の○○珈琲です。」のように名詞が重複する。
//     店名が見本の仮店名「あなたの◯◯（見本）」で始まるときも同様に、
//     「お店のあなたの果樹園（見本）です。」のような不自然な文になる。
// このいずれかに当たる場合は word を落とし、HEADLINES を店名だけで組む型
//（「その名は、◯◯。」「◯◯、はじめます。」等）に譲る。

const GENERIC_HEADLINE_WORD = "お店";
/** 見本ページの仮店名の接頭辞（例:「あなたの果樹園（見本）」）。他の骨格の見出しパターン選択でも使うためexport。 */
export const SAMPLE_STORE_NAME_PREFIX = "あなたの";

/** word を見出しで使わず、店名主役の型に譲るべきかどうか。 */
export function shouldDropHeadlineWord(word: string | null, storeName: string): boolean {
  if (!word) return false;
  if (word === GENERIC_HEADLINE_WORD) return true;
  if (storeName.includes(word)) return true;
  return storeName.startsWith(SAMPLE_STORE_NAME_PREFIX);
}

// ---- クリシェ除去 ----
//
// 2026-08-05に生成済みページから採取した、全店で繰り返された言い回し。
// 該当する文は表示しない。空欄になっても、骨格側は lead が "" でも成立するように作ってある。
// 新しい常套句が見つかったらここに足す（唯一のメンテ箇所）。

const CLICHE_PATTERN =
  /心温まる|ひとときを|癒[しや]の空間|くつろぎのひととき|こだわりの|隠れ家|アットホーム|至福の|特別な時間|おもてなしの心|笑顔でお迎え|ゆったりとした時間|[あ温](たた|っ)かい雰囲気/u;

export const hasCliche = (value: string): boolean => CLICHE_PATTERN.test(value);

// ---- 染め抜き文字・頭文字 ----

const CJK_PATTERN = /[ぁ-ゟ゠-ヿ一-鿿]/u;
const LATIN_PATTERN = /[A-Za-z0-9]/u;
/** 文字数ごとの最大フォントサイズ(rem)。長い屋号でも枠から出さないための表。 */
const DYE_MAX_REM = [0, 3.0, 2.9, 2.5, 2.1, 1.8] as const;
/** dyedTextOf が null（絵文字・記号始まりの屋号）のときに --dye-max に使う既定値。 */
const DEFAULT_DYE_MAX_REM = 1.6;

/**
 * 暖簾の染め抜き・短冊の縦組みに使う文字を決める。
 * 5文字以内ならそのまま、超えるなら一文字染めにする（途中で切ると壊れて見えるため）。
 * 絵文字・記号で始まる屋号は null（帯だけを出す）。
 */
export function dyedTextOf(storeName: string): { text: string; maxRem: number } | null {
  const compact = storeName.replace(/[\s　]/gu, "");
  const head = Array.from(compact)[0];
  if (!head) return null;
  if (CJK_PATTERN.test(head)) {
    const length = Array.from(compact).length;
    const value = length <= 5 ? compact : head;
    return { text: value, maxRem: DYE_MAX_REM[Array.from(value).length] ?? DEFAULT_DYE_MAX_REM };
  }
  if (LATIN_PATTERN.test(head)) return { text: head.toUpperCase(), maxRem: 3.0 };
  return null;
}

/** 角印・空押し・ファビコンに使う頭1文字。絵文字・記号なら null（印を出さない）。 */
export function initialOf(storeName: string): string | null {
  const head = Array.from(storeName.trim())[0];
  if (!head) return null;
  return CJK_PATTERN.test(head) || LATIN_PATTERN.test(head) ? head.toUpperCase() : null;
}

// ---- 看板：店名を1文字に切り詰めず丸ごと表示するときの上限フォントサイズ ----
//
// Issue #4: 看板(kanban.ts)は店名フル表示の上限に --dye-max（dyedTextOf由来）を流用していたが、
// dyedTextOf は暖簾の染め抜き・短冊の縦組み向けに「5文字を超えたら頭文字1文字にする」設計のため、
// 6文字以上の屋号は一律「1文字」とみなされ maxRem=DYE_MAX_REM[1]=3.0rem になっていた。
// 結果、5文字の屋号(1.8rem)より6文字以上の屋号(3.0rem)の方が上限が大きくなる非単調が発生していた。
// ここでは看板専用に、切り詰めない店名の文字数から単調減少（増加しない）で上限を決める。
// 1〜5文字は DYE_MAX_REM（短冊・暖簾と共通の表）をそのまま使い、既存の看板の見た目を変えない。
// 6文字以降は5文字の値(1.8rem)を起点に緩やかに絞り込み、CSS側のclamp下限＝
// DEFAULT_DYE_MAX_REM(1.6rem)で頭打ちにする（それより長い屋号は横幅とword-breakの折返しに任せる）。
const NAME_MAX_REM_TAIL: Readonly<Record<number, number>> = {
  6: 1.7,
  7: 1.7,
  8: 1.65,
  9: 1.65,
  10: 1.65,
};

/**
 * 看板の .kanban__name に使う最大フォントサイズ(rem)を、表示する店名全体の文字数から決める。
 * dyedTextOf と違い、6文字以上でも1文字に切り詰めない（看板は店名をフル表示するため）。
 */
export function nameMaxRemOf(storeName: string): number {
  const compact = storeName.replace(/[\s　]/gu, "");
  const length = Array.from(compact).length;
  if (length <= 0) return DEFAULT_DYE_MAX_REM;
  if (length <= 5) return DYE_MAX_REM[length] ?? DEFAULT_DYE_MAX_REM;
  return NAME_MAX_REM_TAIL[length] ?? DEFAULT_DYE_MAX_REM;
}

// ---- 連絡先（電話tel:リンク・住所の地図リンク・営業時間）----
//
// 骨格が変わっても値の作り方（tel:に載せられる形への正規化・地図検索URL）は変えない。
// ラベル文言だけを骨格ごとに変える。

/**
 * tel:リンクに載せられる形（先頭の+と数字のみ）に正規化する。作れない場合はnull。
 * 「03-1234-5678（受付は18時まで）」のように注記が混ざっていても、
 * 電話番号らしい並びだけを取り出してから数字化する。
 */
function toDialableNumber(value: string): string | null {
  const match = value.match(/\+?[0-9][0-9\-()‐-―\s]{7,20}/u);
  if (!match) return null;
  const digits = match[0].replace(/[^0-9]/gu, "");
  // 国内の固定・携帯（10-11桁）から国際表記（最大15桁）までを許容する。
  if (digits.length < 9 || digits.length > 15) return null;
  return `${match[0].trim().startsWith("+") ? "+" : ""}${digits}`;
}

function mapSearchUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

/** 連絡先を kind + エスケープ済みHTML の配列にする。ラベルは骨格側で付ける。 */
export function buildContactRows(input: SiteInput): ContactRow[] {
  const rows: ContactRow[] = [];
  if (input.phone) {
    const dialable = toDialableNumber(input.phone);
    const valueHtml = dialable
      ? `<a href="tel:${escapeHtml(dialable)}">${escapeHtml(input.phone)}</a>`
      : escapeHtml(input.phone);
    rows.push({ kind: "phone", valueHtml });
  }
  if (input.address) {
    const href = escapeHtml(mapSearchUrl(input.address));
    rows.push({
      kind: "address",
      valueHtml: `<a href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(input.address)}</a>`,
    });
  }
  if (input.businessHours) {
    rows.push({ kind: "hours", valueHtml: escapeHtml(input.businessHours) });
  }
  return rows;
}

/** 連絡先の行を `<p class="{rowClass}"><span class="{keyClass}">label</span><span class="v">value</span></p>` で並べる共通の組み方。 */
export function renderContactRows(
  rows: readonly ContactRow[],
  labels: Skeleton["contactLabels"],
  rowClass: string,
  keyClass: string,
): string {
  return rows
    .map((row) => `<p class="${rowClass}"><span class="${keyClass}">${labels[row.kind]}</span><span class="v">${row.valueHtml}</span></p>`)
    .join("");
}

// ---- 行動ボタン（予約・Instagram・LINE公式）----
//
// 3つとも href を組み立てるので、ここで一度だけ escapeHtml する（骨格側では呼ばない）。
// instagram・LINE公式は、ユーザーが入れた完全なURLをそのまま出さず、正規化した値からこちらで組み立てる。
// 予約が最優先で目立つよう、常に先頭に置く（骨格側は先頭要素を強調する見た目にする）。

const INSTAGRAM_BASE_URL = "https://www.instagram.com/";
const LINE_FRIEND_BASE_URL = "https://line.me/R/ti/p/";

/** 「@ID」なら line.me の追加URLを組み立てる。lin.eeの短縮URLならそのまま使う。 */
function lineHrefOf(lineOfficial: string): string {
  return lineOfficial.startsWith("@") ? `${LINE_FRIEND_BASE_URL}${encodeURIComponent(lineOfficial)}` : lineOfficial;
}

export function buildActions(input: SiteInput): ActionLink[] {
  const actions: ActionLink[] = [];
  if (input.reserveUrl) {
    actions.push({ kind: "reserve", label: "予約する", href: escapeHtml(input.reserveUrl) });
  }
  if (input.instagram) {
    actions.push({ kind: "instagram", label: "Instagram", href: escapeHtml(`${INSTAGRAM_BASE_URL}${input.instagram}/`) });
  }
  if (input.lineOfficial) {
    actions.push({ kind: "line", label: "LINE公式", href: escapeHtml(lineHrefOf(input.lineOfficial)) });
  }
  return actions;
}

// ---- メニュー・料金 ----

// 価格として認めるのは「数字」「数字+円」「¥+数字」だけ。記号や説明文は価格欄へ入れない。
const MENU_PRICE_PATTERN = /^(?:[0-9]+(?:円)?|¥[0-9]+)$/u;

/**
 * 1行を「品名｜価格」または「品名 価格」として読む。
 * 読めない行は一部を捨てず、その行全体を品名として残す。
 */
function parseMenuLine(line: string): { name: string; price: string | null } {
  const value = line.trim();
  const separatorAt = value.indexOf("｜");
  if (separatorAt >= 0) {
    const name = value.slice(0, separatorAt).trim();
    const price = value.slice(separatorAt + 1).trim();
    if (name && MENU_PRICE_PATTERN.test(price)) return { name, price };
    return { name: value, price: null };
  }

  const spaced = /^(.*?)\s+(\S+)$/u.exec(value);
  if (spaced) {
    const name = spaced[1].trim();
    const price = spaced[2];
    if (name && MENU_PRICE_PATTERN.test(price)) return { name, price };
  }
  return { name: value, price: null };
}

/** menuText を品目へ分け、骨格へ渡す前に全文字列を一度だけエスケープする。 */
export function buildMenuItems(input: SiteInput): MenuItem[] {
  if (!input.menuText) return [];
  return input.menuText
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseMenuLine(line))
    .map((item) => ({
      name: escapeHtml(item.name),
      price: item.price ? escapeHtml(item.price) : null,
    }));
}

/** 4骨格で共通の品目マークアップ。見出しと外側の節は骨格ごとに組み立てる。 */
export function renderMenuItems(items: readonly MenuItem[]): string {
  return items
    .map((item) => `<li class="menu__item"><span class="menu__name">${item.name}</span>${item.price ? `<span class="menu__price">${item.price}</span>` : ""}</li>`)
    .join("");
}

/** 行動ボタンを並べる共通の組み方。空なら列ごと出さない。 */
export function renderActionLinks(actions: readonly ActionLink[], listClass: string, itemClass: string): string {
  if (!actions.length) return "";
  const links = actions
    .map((action) => `<a class="${itemClass} ${itemClass}--${action.kind}" href="${action.href}" target="_blank" rel="noopener noreferrer">${action.label}</a>`)
    .join("");
  return `<div class="${listClass}">${links}</div>`;
}

// ---- 写真枠 ----
//
// 写真の形（横長・正方形・縦長）で枠の比率と最大幅を変える。寸法が読めなければ従来どおり横長。

const PHOTO_FRAME: Record<PhotoShape, { aspect: string; maxWidth: string }> = {
  landscape: { aspect: "16 / 10", maxWidth: "100%" },
  square: { aspect: "1 / 1", maxWidth: "620px" },
  portrait: { aspect: "3 / 4", maxWidth: "520px" },
};

/** height/width がこの値以上なら縦長として扱う境界。 */
const PORTRAIT_RATIO_THRESHOLD = 1.15;
/** height/width がこの値以上（かつ縦長未満）なら正方形として扱う境界。これ未満は横長。 */
const SQUARE_RATIO_MIN = 0.87;

function photoShapeFor(size: ImageSize | null): PhotoShape {
  if (!size) return "landscape";
  const ratio = size.height / size.width;
  if (ratio >= PORTRAIT_RATIO_THRESHOLD) return "portrait";
  if (ratio >= SQUARE_RATIO_MIN) return "square";
  return "landscape";
}

/** 写真が無くても :root の --photo-aspect / --photo-max は必ず出す（既存テスト5件が見ている）。 */
export function resolvePhotoFrame(input: SiteInput): { aspect: string; maxWidth: string } {
  return PHOTO_FRAME[photoShapeFor(readImageSize(input.photo ?? ""))];
}

/** 写真が無ければ null。photoUrl があればそれを、無ければdata URIそのものを参照する。 */
export function buildPhotoInfo(input: SiteInput, photoUrl: string | undefined): PhotoInfo | null {
  if (!input.photo) return null;
  const frame = resolvePhotoFrame(input);
  const src = photoUrl ?? input.photo;
  return {
    srcHtml: escapeHtml(src),
    altHtml: escapeHtml(`${input.storeName}の写真`),
    aspect: frame.aspect,
    maxWidth: frame.maxWidth,
  };
}

// ---- 共通の定型文（骨格をまたいでも一字一句変えない） ----

/** フッター文言は一字も変えない（既存テスト1件）。 */
/**
 * ページ下部の署名。見本（sample）と、お客さんが自分で作ったページで内容を変える。
 * 見本は「連絡がなければ90日で消える」、申込ページは「期限なし」＝実装（KVのTTL有無）と一致させる。
 */
export function footerHtml(isSample: boolean, venueKind: VenueKind = "shop"): string {
  const contact = 'info@freehp.jp';
  const mail = `<a href="mailto:${contact}">${contact}</a>（<a href="https://freehp.jp/">freehp.jp</a>）`;
  const noun = venueNoun(venueKind);
  return isSample
    ? `このページは、AIホームページ製作所（RYOSEIWORLD）が作った<strong>見本</strong>です。ご連絡がないまま90日たつと、自動的に非公開になります。気に入っていただけたら、そのまま${noun}のものとしてお渡しし、期限なしで公開します。<br>ご連絡先（この${noun}へのお問い合わせ窓口ではありません）：${mail}`
    : `このホームページは、AIホームページ製作所（RYOSEIWORLD）で作りました。<strong>期限はありません。</strong>ずっと公開したままにできます。<br>直したいところ・独自ドメインのご相談（この${noun}へのお問い合わせ窓口ではありません）：${mail}`;
}

/**
 * 見本ページだけに出す「紹介文は仮のもの」の断り書き。sampleSourceで文言を変える
 * （2026-08-18追加：Threads自動営業から作った見本に「地図サービスの公開情報」と書くと事実と異なるため）。
 */
const SAMPLE_NOTICE_BY_SOURCE: Readonly<Record<SampleSource, (noun: string) => string>> = {
  map: (noun) => `このページは、地図サービスの公開情報だけを使って作った<strong>見本</strong>です。紹介文はこちらで仮に書いたもので、${noun}に伺って書いたものではありません。ご連絡いただければ、${noun}の言葉に書き直してお渡しします。`,
  threads: () =>
    "このページは、Threadsでのご投稿を拝見して、こちらで仮に作った<strong>見本</strong>です。名前や内容は仮のもので、ご連絡いただければ本物に作り直してお渡しします。ご連絡がなければ90日で自動的に消えます。",
};

export function sampleNoticeOf(source: SampleSource, venueKind: VenueKind = "shop"): string {
  return SAMPLE_NOTICE_BY_SOURCE[source](venueNoun(venueKind));
}

// ---- SkeletonContext の組み立て ----

function buildHeadlineParts(input: SiteInput, area: Area | null, word: string | null): HeadlineParts {
  return { store: input.storeName, area: area?.city, word: word ?? undefined };
}

/**
 * 骨格に渡す材料一式を組み立てる。ここでまとめて1回だけエスケープする
 * （骨格側は escapeHtml を呼ばない・input / content を直接読まない設計にしてあるため）。
 */
export function buildSkeletonContext(
  input: SiteInput,
  content: GeneratedContent,
  skeleton: Skeleton,
  palette: Palette,
  photoUrl: string | undefined,
  isSample: boolean,
  sampleSource: SampleSource = "map",
): SkeletonContext {
  const venueKind = resolveVenueKind(input.industry, input.storeName);
  const area = parseArea(input.address);
  const genre = parseGenre(input.catchphrase, area);
  const word = resolveWord(genre, input.industry);
  const headlineWordRaw = resolveHeadlineWord(genre, input.industry);
  const headlineWord = shouldDropHeadlineWord(headlineWordRaw, input.storeName) ? null : headlineWordRaw;
  const seed = seedOf(input);
  const rawHeadline = buildHeadline(skeleton.headlines, buildHeadlineParts(input, area, headlineWord), seed);
  const lead = hasCliche(content.subheadline) ? "" : content.subheadline;
  const highlights = content.highlights.filter((item) => item.trim().length > 0 && !hasCliche(item));
  const tagline = isOwnerVoice(input.catchphrase, area) ? input.catchphrase : "";
  const dyed = dyedTextOf(input.storeName);
  const initial = initialOf(input.storeName);

  return {
    venueKind,
    headline: escapeHtml(rawHeadline),
    lead: escapeHtml(lead),
    tagline: escapeHtml(tagline),
    about: escapeHtml(content.aboutText),
    highlights: highlights.map((item) => escapeHtml(item)),
    menuItems: buildMenuItems(input),
    closing: escapeHtml(content.closingText),
    storeName: escapeHtml(input.storeName),
    dyedText: dyed ? escapeHtml(dyed.text) : null,
    dyedMaxRem: dyed?.maxRem ?? DEFAULT_DYE_MAX_REM,
    nameMaxRem: nameMaxRemOf(input.storeName),
    initial: initial ? escapeHtml(initial) : null,
    areaFull: area ? escapeHtml(area.full) : "",
    word: word ? escapeHtml(word) : "",
    contactRows: buildContactRows(input),
    actions: buildActions(input),
    photo: buildPhotoInfo(input, photoUrl),
    isSample,
    sampleNoticeHtml: isSample ? sampleNoticeOf(sampleSource, venueKind) : "",
    palette,
  };
}

// pickIndex はテスト側から直接店の見出し型を再現したいときのために再エクスポートする。
export { pickIndex, seedOf };
