検証が済んだので、仕様をまとめます。以下がそのまま実装仕様です。

---

# 無料ホームページくん 骨格システム 実装仕様

対象: `worker/src/domain/render.ts`
前提: `renderSite(input, content, options)` の外形は変えない（`index.ts` は無改修）。CSPも現行のまま。

---

## 0. 結論（採否）

| 型 | 採否 | 業種 | 配色数 | 理由 |
|---|---|---|---|---|
| **名刺** | 採用 | 全業種 | 5 | 唯一の全業種型。材料が最も薄い店の本命。フォールバックも兼ねる |
| **暖簾** | 採用 | 飲食店のみ | 3 | 審査どおり和風固定なので飲食店以外へは割り当てない |
| **短冊** | 採用（垂線の修正版） | 飲食店以外 | 5 | 美容・サロンが名刺1本では全店同じ顔になるため必要。審査の修正3点を全て反映して別物に組み直す |
| **方眼** | 採用（減量版） | 美容・サロン以外 | 3 | 手描きは見出し下線1箇所のみ、蛍光ペン・囲みは削除、方眼は帯だけ。美容・サロンには当てない |
| 垂線（原案） | 不採用 | — | — | 17px見出し・82svhの空白は「作りかけ」に見える。骨組みだけ短冊へ移植 |
| 袖看板 | 不採用 | — | — | 採点データなし |

**組み合わせ数（＝顔の種類）**

- 飲食店: 暖簾3 + 名刺5 + 方眼3 = **11通りの骨格×配色** ×見出し型5 = 55
- 美容・サロン: 名刺5 + 短冊5 = **10通り** ×5 = 50
- 教室・スクール / 小売・物販 / 修理・住まいのサービス: 名刺5 + 方眼3 + 短冊5 = **各13通り** ×5 = 65
- その他: 名刺5 + 方眼3 + 短冊5 = **13通り** ×5 = 65

同じ町の2軒が「骨格も配色も同じ」になる確率は 1/10〜1/13。ただし見出し本文には必ず店名か地域が入るので、**文字列としての一致は起きない**（現状の「心温まるひととき」問題は骨格に関係なく消える）。

---

## 1. ファイル構成

現行 `render.ts` は203行だが、骨格4種を足すと確実に800行を超える。最初に割る。

```
src/domain/render.ts                     入口。<head>・CSP・共通殻の組み立てのみ（150行以下）
src/domain/render/types.ts               Skeleton / Palette / SkeletonContext の型
src/domain/render/hash.ts                安定ハッシュ（骨格・配色・見出し型の抽選）
src/domain/render/parts.ts               住所パース・ジャンル抽出・クリシェ除去・連絡先・写真枠
src/domain/render/headline.ts            見出しビルダー
src/domain/render/select.ts              骨格と配色の決定
src/domain/render/skeletons/index.ts     SKELETONS 配列
src/domain/render/skeletons/meishi.ts
src/domain/render/skeletons/noren.ts
src/domain/render/skeletons/tanzaku.ts
src/domain/render/skeletons/hogan.ts
```

---

## 2. 型定義（そのまま貼れる）

```ts
// src/domain/render/types.ts
import type { GeneratedContent } from "../../generation/provider.ts";
import type { Industry, SiteInput } from "../validate.ts";
import type { RenderSiteOptions } from "../render.ts";

export type SkeletonKey = "名刺" | "暖簾" | "短冊" | "方眼";
export type Temperature = "warm" | "calm" | "fresh";

export interface Palette {
  /** デバッグ用の名前。<body data-配色> に出す */
  readonly key: string;
  /** input.colorTheme（あたたかい/落ち着いた/さわやか）との対応 */
  readonly temp: Temperature;
  /** CSSカスタムプロパティ。キーは "--" を含まない */
  readonly vars: Readonly<Record<string, string>>;
  /** ファビコンの地色 */
  readonly mark: string;
}

export interface Area {
  readonly pref: string;   // 東京都
  readonly city: string;   // 武蔵野市
  readonly full: string;   // 東京都武蔵野市
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
  readonly srcHtml: string;   // エスケープ済みのsrc
  readonly altHtml: string;
  readonly aspect: string;    // "16 / 10"
  readonly maxWidth: string;  // "100%"
}

/**
 * 骨格に渡す材料。文字列はすべてHTMLエスケープ済み。
 * 骨格側で escapeHtml を呼んではいけない（二重エスケープになる）。
 * 骨格側から input / content を直接読んでもいけない（生の値が漏れる）。
 */
export interface SkeletonContext {
  readonly headline: string;
  readonly lead: string;        // クリシェ除去後。落ちたら ""
  readonly tagline: string;     // 店主自筆と判定できたときだけ。機械文なら ""
  readonly about: string;
  readonly highlights: readonly string[];  // クリシェ除去後。空なら節ごと出さない
  readonly closing: string;
  readonly storeName: string;
  readonly dyedText: string | null;   // 暖簾の染め抜き・短冊の縦組みに使う文字
  readonly dyedMaxRem: number;        // 上の文字数から決めた最大フォントサイズ
  readonly initial: string | null;    // 印・空押しに使う頭1文字（絵文字等ならnull）
  readonly areaFull: string;          // 東京都武蔵野市。無ければ ""
  readonly word: string;              // カフェ / 飲食店 / サロン / 教室・スクール等。無ければ ""
  readonly contactRows: readonly ContactRow[];
  readonly photo: PhotoInfo | null;
  readonly isSample: boolean;
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
```

---

## 3. 共通ヘルパ（実コード）

### 3-1. 安定ハッシュ `hash.ts`

**罠を1つ潰してある。** 1本のFNV値を `h % 4`, `(h>>>8) % 3`, `(h>>>16) % 5` のように切り分けて使うと軸どうしが相関する（実店名20件で試したところ、骨格・配色・見出しが3組まるごと一致した）。軸ごとに別ソルトを混ぜ、murmur3のfinalizerを通してから剰余を取る。1万件で分布を確認済み（骨格 mod3 = 3368/3361/3271、骨格0のときの配色分布 799/853/821/895）。

```ts
// src/domain/render/hash.ts
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    let code = character.codePointAt(0) as number;
    while (code > 0) {
      hash = Math.imul(hash ^ (code & 0xff), 0x01000193) >>> 0;
      code >>>= 8;
    }
  }
  return hash >>> 0;
}

/** murmur3のfinalizer。FNV-1aは上位ビットが偏るので、剰余の前に必ず通す。 */
function finalize(value: number): number {
  let hash = (value ^ (value >>> 16)) >>> 0;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * 同じ店名なら毎回同じ番号を返す（作り直しても見た目が変わらない）。
 * 軸ごとにソルトを変えるのは、骨格と配色が連動して「骨格が同じ店は配色も同じ」になるのを防ぐため。
 */
export function pickIndex(seed: string, axis: string, length: number): number {
  if (length <= 1) return 0;
  return finalize(fnv1a32(`${axis}:${seed}`)) % length;
}
```

### 3-2. 住所から地域を取る `parts.ts`

実住所16件で検証済み（〒付き・ビル名付き・政令市・郡付き・都道府県なし・英字・空文字）。

```ts
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
```

実測結果（抜粋）:

| 入力 | 結果 |
|---|---|
| `〒180-0003 東京都武蔵野市吉祥寺南町1-2-3` | 東京都 / 武蔵野市 |
| `神奈川県横浜市中区山下町123` | 神奈川県 / 横浜市 |
| `北海道虻田郡倶知安町字山田204` | 北海道 / 倶知安町 |
| `埼玉県さいたま市大宮区桜木町1-1` | 埼玉県 / さいたま市 |
| `大阪市中央区難波1-1-1`（都道府県なし） | **取れない**（→ 地域を使わない見出し型に落ちる） |
| `Tokyo, Shibuya-ku 1-2-3` | **取れない** |

取れないときは地域を一切書かない。無い事実を作らない既存方針と同じ。

### 3-3. キャッチコピーの正体判定 → ジャンル語

**これが現状の三重複（tagline「東京都武蔵野市のカフェ」／h1「武蔵野市のカフェで心温まるひとときを」／lead「あたたかい雰囲気でリラックスできるカフェ」）を消す鍵。**

見本バッチの `catchphrase` は地図データから機械的に組んだ `{都道府県}{市区町村}の{ジャンル}` であって、店主が書いた1行ではない。住所から取れた地域名で始まるときだけ後半をジャンル語として取り出し、**取り出せた場合はキャッチコピー欄として表示しない**（h1に吸収されるため）。

```ts
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
```

実測（ジャンル抽出＝機械文、null＝自筆扱い）:

| catchphrase | 判定 |
|---|---|
| `東京都武蔵野市のカフェ` | ジャンル=カフェ（機械文 → tagline非表示） |
| `東京都渋谷区の美容室` | ジャンル=美容室（機械文） |
| `落ち着いた雰囲気の中で、あなたに合うかたちを。` | 自筆 → taglineとして表示 |
| `三代つづく、町の定食屋` | 自筆 → 表示（既存テストの固定値） |
| `東京都武蔵野市のカフェ。ゆっくりどうぞ` | 自筆（句点で除外） |

### 3-4. 業種語

```ts
const INDUSTRY_WORDS: Record<Industry, string | null> = {
  "飲食店": "飲食店",
  "美容・サロン": "サロン",   // 「・」は木札・縦組み・小さい札で割れて壊れて見える
  "教室・スクール": "教室・スクール",
  "小売・物販": "小売・物販",
  "修理・住まいのサービス": "修理・住まいのサービス",
  "その他": null,             // 店が自分のページで「その他」と名乗ることになるので出さない
};

/** ジャンル語（カフェ）を最優先、無ければ業種語。どちらも無ければ null。 */
export const resolveWord = (genre: string | null, industry: Industry): string | null =>
  genre ?? INDUSTRY_WORDS[industry];
```

### 3-5. クリシェ除去

現物172店から採取した言い回し。**書き直さずに丸ごと落とす**（書き直すと入力にない事実を作ることになるため、消すことしかできない）。

```ts
/**
 * 2026-08-05に生成済みページから採取した、全店で繰り返された言い回し。
 * 該当する文は表示しない。空欄になっても、骨格側は lead が "" でも成立するように作ってある。
 * 新しい常套句が見つかったらここに足す（唯一のメンテ箇所）。
 */
const CLICHE_PATTERN =
  /心温まる|ひとときを|癒[しや]の空間|くつろぎのひととき|こだわりの|隠れ家|アットホーム|至福の|特別な時間|おもてなしの心|笑顔でお迎え|ゆったりとした時間|[あ温](たた|っ)かい雰囲気/u;

export const hasCliche = (value: string): boolean => CLICHE_PATTERN.test(value);
```

適用先は2箇所だけ。

- `lead`（= `content.subheadline`）: 該当したら **空文字にする**
- `highlights`: 該当した項目だけ落とす。全滅したら節ごと出さない（現行の判断を踏襲）

`aboutText` / `closingText` には適用しない（本文が丸ごと消えると壊れて見えるため）。代わりに `SYSTEM_PROMPT` 側で禁止する（§6-2）。

### 3-6. 染め抜き文字・頭文字

```ts
const CJK_PATTERN = /[\u3041-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/u;
const LATIN_PATTERN = /[A-Za-z0-9]/u;
/** 文字数ごとの最大フォントサイズ(rem)。長い屋号でも枠から出さないための表。 */
const DYE_MAX_REM = [0, 3.0, 2.9, 2.5, 2.1, 1.8] as const;

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
    const text = length <= 5 ? compact : head;
    return { text, maxRem: DYE_MAX_REM[Array.from(text).length] ?? 1.6 };
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
```

`initialOf` は既存 `faviconDataUri` からも使う。現行は `Array.from(...)[0] ?? "・"` で絵文字がそのまま270pxの空押しに出る危険がある。

---

## 4. 見出しビルダー

```ts
// src/domain/render/headline.ts
export function buildHeadline(
  patterns: readonly HeadlinePattern[],
  parts: HeadlineParts,
  seed: string,
): string {
  const usable = patterns
    .map((pattern) => pattern(parts))
    .filter((line): line is string => line !== null && line.length > 0);
  // 各骨格のパターン表は「店名だけで書ける型」を必ず1つ含める決まりなので、通常ここは空にならない。
  if (usable.length === 0) return parts.store;
  return usable[pickIndex(seed, "headline", usable.length)];
}
```

**各骨格のパターン5本は必ずこの内訳にする**（材料が欠けても必ず1本は残り、欠け方によって選ばれる型が変わるので変化も増える）:

- 2本 = 地域＋業種語が要る
- 1本 = 地域だけで書ける
- 1本 = 業種語だけで書ける
- 1本 = 店名だけで書ける

---

## 5. 骨格と配色の決め方

```ts
// src/domain/render/select.ts
export function selectSkeleton(input: SiteInput, forced?: SkeletonKey): Skeleton {
  if (forced) {
    const found = SKELETONS.find((skeleton) => skeleton.key === forced);
    if (found) return found;
  }
  const eligible = SKELETONS.filter((skeleton) => skeleton.industries.includes(input.industry));
  // 業種の対応表は全業種に最低2つ当たるように組んであるが、
  // 将来 industries を絞りすぎたときに落ちないよう、名刺（全業種型）を最後の受け皿にする。
  if (eligible.length === 0) return MEISHI;
  return eligible[pickIndex(seedOf(input), "skeleton", eligible.length)];
}

/**
 * 見本ページ（options.sample）は店主が配色を選んでいないので、
 * input.colorTheme は営業側が機械的に入れた値でしかない。無視してハッシュで選ぶ。
 * 申込フォーム経由のときだけ、選ばれた温度の中から選ぶ。
 */
export function selectPalette(skeleton: Skeleton, input: SiteInput, isSample: boolean): Palette {
  const seed = seedOf(input);
  const wanted = TEMPERATURE_OF[input.colorTheme];
  const pool = isSample ? skeleton.palettes : skeleton.palettes.filter((p) => p.temp === wanted);
  const list = pool.length > 0 ? pool : skeleton.palettes;
  return list[pickIndex(seed, `palette:${skeleton.key}`, list.length)];
}

const TEMPERATURE_OF: Record<ColorTheme, Temperature> =
  { "あたたかい": "warm", "落ち着いた": "calm", "さわやか": "fresh" };

/** 住所も混ぜるのは、同じ屋号のチェーンが別の町にあるとき別の顔にするため。 */
const seedOf = (input: SiteInput): string => `${input.storeName}|${input.address ?? ""}`;
```

`RenderSiteOptions` に逃げ道を1つ足す（テストと目視QAで必須）:

```ts
export interface RenderSiteOptions {
  publicUrl?: string;
  photoUrl?: string;
  sample?: boolean;
  /** 骨格を固定する。テストと、営業で見せ分けたいときだけ使う。 */
  skeleton?: SkeletonKey;
}
```

デバッグ用に `<body data-型="暖簾" data-配色="藍">` を出す。172ページを目で確認するときにこれが無いと数えられない。

---

## 6. 見出しの重複をなくす仕掛け（判断）

### 6-1. 結論：AIに書かせない。`render.ts` で組み立てる

**「型を先に決めてAIに埋めさせる」も「AIの出力を型に流し込む」も採らない。h1は入力の事実だけから決定的に組む。**

理由:

1. 生成の主力は Workers AI の mistral-small（無料枠）。プロンプトで禁止しても172回の呼び出しの中で必ず常套句に戻る。プロンプトは確率を下げるだけで、保証にならない。
2. h1に必要な材料（店名・地域・業種語）は**全部 input に既にある**。AIを通す理由がない。
3. 決定的なら単体テストで固定でき、生成コストもリトライもゼロ。同じ店は毎回同じ見出しになる。
4. 「AIに型を埋めさせる」は、型の穴に入れる語（形容詞）をAIが作る＝**確かめていない事実を作る**ことになり、`嘘は絶対つかない` に反する。

**代償と、その埋め合わせ**: 事実だけの見出しは「武蔵野市に、And Cafe Sacaiというカフェがあります。」のように叙情性がない。叙情の担当は次の2つに移す。

- **店主が自分で書いたキャッチコピー**（申込フォーム経由なら必ず自筆）を大きく出す。情緒は店主の言葉から出す。
- **書体・色・signature**（明朝の屋号、藍の面、空押し）。気分はタイポグラフィが担う。

見本ページはキャッチが機械文なので tagline を出さず、事実の見出し＋AIの `aboutText` だけになる。見本の断り書き（`sample-notice`）が既にあるので整合する。

### 6-2. 4段構えの防止策

| 層 | やること | 効き方 |
|---|---|---|
| 1 | h1 を決定的に組む（§4） | 常套句が構造的に入らない |
| 2 | 見出し型5本をハッシュで選ぶ | 同じ町の同業種でも文型が変わる |
| 3 | `SYSTEM_PROMPT` に禁止語を明記 | AIの他の欄の常套句を減らす |
| 4 | `lead` と `highlights` をクリシェ除去（§3-5） | 3で漏れた分を表示前に落とす |

層3で `SYSTEM_PROMPT` の「書き方のルール」に1行足す（`provider.ts`）:

```
- 次の言い回しは使わないこと（どの店にも当てはまり、店の違いが消えるため）:
  心温まるひととき／癒しの空間／くつろぎのひととき／こだわりの／隠れ家的／アットホームな／
  至福の／特別な時間／おもてなしの心／笑顔でお迎え／ゆったりとした時間／あたたかい雰囲気
```

`content.headline` はページに出さなくなる。ただし **Step 1〜6の間は provider.ts / qa.ts / GeneratedContent を触らない**（`qa.ts` の `required` 配列が `headline` を見ているため、外すと同じコミットで3ファイル同時修正になる）。最後のStep 7で、プロンプトから `headline` キーを落とし、`GeneratedContent`・`qa.ts`・テストを同時に直す。

---

## 7. 各型の仕様

### 共通の殻（`render.ts` が組む部分）

```
<!doctype html><html lang="ja"><head>
  meta charset / viewport / robots(sample時) / description / og:* / twitter:card
  CSP（現行のまま一字も変えない）
  <link rel="icon" href="{faviconDataUri(initial, palette.mark)}">
  <title>{店名}｜ホームページ</title>
  <style>
    :root{ {palette.vars を --key:value; で展開} --photo-aspect:...; --photo-max:...; --dye-max:...rem; }
    {skeleton.css}
  </style>
</head><body data-型="{key}" data-配色="{palette.key}">
  {skeleton.body(ctx)}
</body></html>
```

**全骨格に共通の必須事項**（守らないとテストが落ちるか、事故る）:

- `--photo-aspect` と `--photo-max` の変数名を必ず `:root` に出す（既存テスト5件がこの文字列を見ている）
- 業種を印字する要素に `class="industry"` を必ず残す（既存テスト2件）。骨格ごとの見た目クラスは併記する（例 `class="mokusatsu industry"`）
- キャッチコピー要素に `class="tagline"` を残す（既存テスト1件）
- フッター文言は現行の文字列をそのまま使う（既存テスト1件）
- タップ領域 `min-height: 44px`
- `html{ overflow-x: clip }`（回転・はみ出しによる横スクロールの保険）
- `*{box-sizing:border-box}`
- 読み幅 `max-width: 640px`（現行880pxは日本語には長すぎる）

---

### 7-1. 名刺（`meishi.ts`）— 全業種・本命

**当てる業種**: 全業種（飲食店 / 美容・サロン / 教室・スクール / 小売・物販 / 修理・住まいのサービス / その他）

**配色（5種・全ペア AA 実測済み）**

固定: `card #FBFAF6` / `paper #F5F3EC` / `ink #1A2229` / `sub #56605E` / `rule #DCD8CC` / `deboss #F3F1EA` / `foot #C6CFD4` / `footlink #DCE3E7`

| key | temp | ground | seal | 実測 |
|---|---|---|---|---|
| 藍鼠 | calm | `#22303A` | `#0F5E6B` | seal/card 7.10 ・ foot/ground 8.56 |
| 焦茶 | warm | `#33281F` | `#8A4A12` | 6.55 ・ 9.07 |
| 深緑 | fresh | `#1F3329` | `#14614A` | 7.08 ・ 8.49 |
| 葡萄 | calm | `#2C2634` | `#5C3B78` | 8.55 ・ 9.26 |
| 利休鼠 | fresh | `#2B322F` | `#4A5A2B` | 7.21 ・ 8.30 |

共通実測: ink/card 15.41、ink/paper 14.50、sub/card 6.22、sub/paper 5.85、印の白抜き card/seal は seal/card と同値。

**書体**

```
--mincho: "Hiragino Mincho ProN","HiraMinProN-W3","Yu Mincho",YuMincho,"Noto Serif JP","Noto Serif CJK JP",serif
--gothic: "Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic Medium","Yu Gothic",YuGothic,"Noto Sans JP","Noto Sans CJK JP",Meiryo,sans-serif
```

明朝は**屋号と裏書きの見出し1行だけ**。本文・箇条・連絡先は全部ゴシック（名刺の組版規則そのもの＝根拠が案件側にある）。屋号は `font-weight:400` のまま大きくする（Hiragino Mincho も Yu Mincho も細ウエイトしか実質持たないため、太らせようとすると合成太字で潰れる）。

**見出し語彙**: `この店のはなし` / `うちの流儀` / `ご用の際は`
**連絡先ラベル**: `電話` / `所在` / `営業`

**見出し型5本**

```ts
const headlines: HeadlinePattern[] = [
  (p) => (p.area && p.word ? `${p.store}。${p.area}の${p.word}です。` : null),
  (p) => (p.area && p.word ? `${p.area}で${p.word}をひとつ。${p.store}。` : null),
  (p) => (p.area ? `用のあるときは、${p.area}の${p.store}へ。` : null),
  (p) => (p.word ? `${p.word}の${p.store}、と申します。` : null),
  (p) => `${p.store}と申します。`,
];
```

**signature: 空押し（からおし）** — 審査指摘を反映した修正版。

3点で1組。(1) 紙の右上角に58px角の角印を −6deg で押す（中身は頭1文字）。(2) 頭1文字を巨大に、紙より2.5%暗い色で置き、上下の陰影を弱く重ねる。(3) ぼかし0の硬い影4枚で紙の小口4pxを作る。

**修正点（そのまま実装すること）**
- 空押しは**傾けない**。
- 影のコントラストを弱める（墨側 22% → **14%**）。
- **紙色そのままで置かない**。`color:#F3F1EA`（紙より2.5%暗い）を base に置く。屋外の直射や安い液晶で陰影が飛んでも、薄い版下として見える。
- **紙の縁で半分以上裁ち落とす**（`right:-30%`）。中途半端に全部見えていると「文字化け」に見える。
- 裁ち落としは `.meishi__field{position:absolute;inset:0;overflow:hidden;pointer-events:none}` の**子**に置いて初めて効く。ここを間違えると横スクロールが出る。
- `aria-hidden="true"` `user-select:none`。
- `initialOf()` が null（絵文字・記号で始まる屋号）なら空押しも角印も出さない。
- 住所は `parseArea` が取れたときだけ「東京都渋谷区」を出す。取れなければ行ごと出さない。
- **`background-attachment: fixed` は使わない**（iOS Safariで実質効かず塗り替えが重い）。

**HTML骨組み**

```html
<main>
  <article class="meishi">
    <div class="meishi__field"><span class="deboss" aria-hidden="true">{initial}</span></div>
    <span class="spine industry">{word}</span>
    <span class="seal" aria-hidden="true">{initial}</span>
    <p class="meishi__place">{areaFull}</p>
    <h1 class="meishi__name">{storeName}</h1>
    <p class="tagline meishi__catch">{tagline}</p>        <!-- tagline が "" なら要素ごと出さない -->
    <p class="meishi__info">{電話}<br>{住所}</p>
  </article>
  <p class="sample-notice">…</p>                          <!-- isSample のときだけ -->
  <p class="fold">うら</p>
  <article class="ura">
    <figure class="print"><img …></figure>                <!-- photo があるときだけ -->
    <h2 class="ura__mark">うら書き</h2>
    <p class="ura__headline">{headline}</p>
    <p class="ura__lead">{lead}</p>                        <!-- lead が "" なら出さない -->
    <h2>この店のはなし</h2><p>{about}</p>
    <h2>うちの流儀</h2><ul><li>…</li></ul>                 <!-- highlights が空なら節ごと出さない -->
    <h2>ご用の際は</h2><p>{closing}</p>
    <div class="contact">…</div>
  </article>
  <footer>…</footer>
</main>
```

`h1` は `.meishi__name`（屋号）に付ける。`.ura__headline` は `<p>` にする（見出しの二重定義を避ける）。

**CSS**

```css
*{box-sizing:border-box}
html{overflow-x:clip}
body{margin:0;background:var(--ground);
  background-image:radial-gradient(120% 60% at 50% 0,color-mix(in srgb,var(--ground) 82%,#fff) 0,var(--ground) 62%);
  color:var(--ink);font-family:var(--gothic);line-height:1.95;-webkit-text-size-adjust:100%}
main{width:100%;max-width:500px;margin:0 auto;padding:40px 20px 52px}

.meishi{position:relative;background:var(--card);border-radius:3px;box-shadow:var(--stock);
  aspect-ratio:55/91;min-height:500px;display:flex;flex-direction:column;padding:34px 24px 28px 46px}
.meishi__field{position:absolute;inset:0;overflow:hidden;border-radius:3px;pointer-events:none}
.meishi::before{content:"";position:absolute;left:32px;top:26px;bottom:26px;border-left:1px solid var(--rule)}
.spine{position:absolute;left:14px;top:30px;writing-mode:vertical-rl;text-orientation:upright;
  font-size:.66rem;font-weight:600;letter-spacing:.36em;color:var(--sub);white-space:nowrap}
.seal{position:absolute;top:-13px;right:-9px;width:58px;height:58px;display:grid;place-items:center;
  border:2.5px solid var(--seal);border-radius:4px;background:var(--card);color:var(--seal);
  font-family:var(--mincho);font-size:1.55rem;line-height:1;transform:rotate(-6deg);z-index:2}
/* 空押し：傾けず、紙より2.5%暗い地色を置いてから陰影を薄く重ね、紙の縁で半分以上を裁ち落とす */
.deboss{position:absolute;right:-30%;bottom:56px;font-family:var(--mincho);
  font-size:clamp(170px,52vw,240px);line-height:1;color:var(--deboss);user-select:none;
  text-shadow:0 1px 0 rgb(255 255 255/.92),0 -1px 1px rgb(26 34 41/.14),0 3px 3px rgb(255 255 255/.55)}
.meishi__place{font-size:.72rem;letter-spacing:.14em;color:var(--sub);margin:0 0 12px}
.meishi__name{font-family:var(--mincho);font-weight:400;font-size:clamp(1.95rem,8.8vw,2.8rem);
  line-height:1.3;letter-spacing:.05em;margin:0;position:relative;z-index:1;
  word-break:auto-phrase;line-break:strict;text-shadow:0 1px 0 #fff,0 -1px 0 rgb(26 34 41/.16)}
.meishi__catch{position:relative;z-index:1;margin:26px 0 0;padding-top:17px;font-size:.94rem;line-height:1.9;font-weight:500}
.meishi__catch::before{content:"";position:absolute;top:0;left:0;width:26px;height:2px;background:var(--seal)}
.meishi__info{position:relative;z-index:1;margin-top:auto;padding-top:22px;
  font-size:.78rem;line-height:1.9;color:var(--sub);font-feature-settings:"palt" 1}

.fold{display:flex;align-items:center;gap:14px;margin:32px 0 24px;color:var(--footlink);
  font-size:.64rem;font-weight:600;letter-spacing:.52em;text-indent:.52em}
.fold::before,.fold::after{content:"";flex:1;border-top:1px dashed color-mix(in srgb,var(--footlink) 45%,transparent)}

.ura{background:var(--paper);border-radius:3px;box-shadow:var(--stock);padding:32px 24px 30px}
.ura__headline{font-family:var(--mincho);font-weight:400;font-size:clamp(1.45rem,6vw,2rem);
  line-height:1.62;letter-spacing:.04em;margin:0 0 14px;word-break:auto-phrase;line-break:strict}
.ura__lead{margin:0;color:var(--sub);font-size:.92rem}
.ura h2{display:flex;align-items:center;gap:10px;font-size:.8rem;font-weight:700;
  letter-spacing:.22em;line-height:1;color:var(--seal);margin:36px 0 12px}
.ura h2::before{content:"";flex:none;width:7px;height:7px;background:var(--seal);transform:rotate(45deg)}
.ura p{margin:0;font-size:.94rem}
.ura ul{list-style:none;margin:0;padding:0}
.ura li{position:relative;padding-left:20px;margin:0 0 11px;font-size:.94rem;line-height:1.9}
.ura li::before{content:"";position:absolute;left:2px;top:.8em;width:6px;height:6px;
  border:1.5px solid var(--seal);transform:rotate(45deg)}
.print{margin:0 0 24px;padding:9px 9px 30px;background:#fff;border-radius:2px;box-shadow:var(--stock)}
.print img{display:block;width:100%;height:auto;border-radius:1px;aspect-ratio:var(--photo-aspect);object-fit:cover}

.contact{margin-top:18px;border-top:1px solid var(--rule);padding-top:6px;font-feature-settings:"palt" 1}
.row{display:flex;gap:12px;align-items:center;min-height:44px;margin:0;font-size:.88rem}
.row .k{flex:none;width:2.6em;font-size:.66rem;font-weight:700;letter-spacing:.14em;color:var(--seal)}
.row .v{flex:1;min-width:0;overflow-wrap:anywhere}
.row a{color:var(--ink);text-decoration:underline;text-underline-offset:4px;
  text-decoration-thickness:1px;display:inline-flex;align-items:center;min-height:44px}
.sample-notice{max-width:460px;margin:20px auto 0;background:#F0EDE2;border-left:3px solid var(--seal);
  border-radius:2px;padding:13px 15px;font-size:.77rem;line-height:1.85}
footer{color:var(--foot);font-size:.7rem;line-height:1.9;margin-top:26px}
footer a{color:var(--footlink)}
```

`--stock` はパレット非依存の固定値として `:root` に置く:
`0 1px 0 #E9E5DA,0 2px 0 #DED9CC,0 3px 0 #D2CCBD,0 4px 0 #C6BFAE,0 16px 26px rgb(10 18 24/42%)`

---

### 7-2. 暖簾（`noren.ts`）— 飲食店のみ

**当てる業種**: 飲食店のみ（審査指摘「和風以外の業種には割り当てない」）

**配色（3種）**

固定: `paper #EDE6D6` / `washi #F5EFE1` / `sumi #221E1A` / `somenuki #F3EFE4` / `kiji #6F5334`

| key | temp | ai（主役の面） | ai-deep | beni（印・電話） | 実測 |
|---|---|---|---|---|---|
| 藍 | calm | `#16334F` | `#0E2438` | `#8E2B1D` | 見出し10.42 ・ 印6.72 ・ 電話白抜き7.27 |
| 柿渋 | warm | `#5E2E1F` | `#3B1B10` | `#1C4A63` | 8.95 ・ 7.65 ・ 8.27 |
| 千歳緑 | fresh | `#1E3E2E` | `#12291E` | `#8C3B12` | 9.47 ・ 6.14 ・ 6.65 |

共通実測: 本文 sumi/paper 13.31、sumi/washi 14.44、木地 kiji/paper 5.70、染め抜き somenuki/ai は9.69〜11.28、敷石の字 paper/ai-deep 12.40〜12.72。

**書体**

```
--mincho: "Hiragino Mincho ProN","Hiragino Mincho Pro","Yu Mincho",YuMincho,"MS PMincho",serif
--gothic: "Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic Medium","Yu Gothic",YuGothic,"Noto Sans JP",Meiryo,sans-serif
```

明朝は**屋号・染め抜き・見出し・キャッチだけ**、かつ **1.2rem 以上でしか使わない**（Windowsの游明朝は細く、小さい字が紙色の上でかすれる）。本文・そえ書き・連絡先はゴシック。見出しの字間は `.03〜.08em`（詰めない）、染め抜きだけ `.30em`。本文行間 1.95。

**見出し語彙**: `のれんの内側` / `うちの決めごと` / `暖簾をくぐる前に`
**連絡先ラベル**: `電話` / `所在` / `商い`

**見出し型5本**

```ts
[
  (p) => (p.area && p.word ? `${p.area}に、${p.store}という${p.word}があります。` : null),
  (p) => (p.area && p.word ? `${p.area}の${p.word}。屋号は${p.store}。` : null),
  (p) => (p.area ? `${p.store}の暖簾は、${p.area}に。` : null),
  (p) => (p.word ? `のれんの向こうは、${p.word}の${p.store}。` : null),
  (p) => `${p.store}。この暖簾が目印です。`,
]
```

**signature: 揺れる藍の暖簾**（軒→竿→布3枚）。**修正版の数値を使うこと。**

| 項目 | 原案 | 採用値 | 理由 |
|---|---|---|---|
| 揺れ幅（外側） | ±0.45° | **±0.2°** | 安っぽく見えると全部台無しになる（審査） |
| 周期 | 8s / 9.5s | **12s / 12s（片方 delay -6s）** | 同上 |
| 揺れ幅（中央） | ±0.12° | **±0.08°** | 文字を読ませる |
| 暖簾の高さ | clamp(146,40vw,206) | **clamp(150px,34vw,210px)** | 390×844で屋号・h1・電話が下に押し出されるのを防ぐ |
| 軒 | clamp(14,4.4vw,22) | **18px 固定** | 高さの読みを確定させる |
| 竿 | 5px | 5px 固定 | — |
| 横スクロール | 記載なし | **`.noren{overflow-x:hidden}`** | 回転で布が横にはみ出す |
| 木札 | 常時2枚 | **地域が取れなければ業種だけ／両方無ければ行ごと出さない** | 住所パースは失敗しうる |
| 染め抜き | 先頭1〜4文字 | **`dyedTextOf()`（5文字以内は全部・超えたら一文字染め）** | 途中で切ると壊れて見える |

写真ゼロ対策は signature の対になる「上がり框」の木目帯が担う。写真があるときは框を12pxの見切りに縮める。

**HTML骨組み**

```html
<div class="noki"></div><div class="sao"></div>
<div class="noren">
  <div class="haba"></div>
  <div class="haba naka"><span class="somenuki">{dyedText}</span></div>
  <div class="haba"></div>
</div>
<main class="wrap">
  <div class="fuda-row">
    <span class="mokusatsu industry">{word}</span>       <!-- word が "" なら出さない -->
    <span class="mokusatsu">{areaFull}</span>            <!-- areaFull が "" なら出さない -->
  </div>
  <h1 class="yago">{storeName}<span class="in" aria-hidden="true">{initial}</span></h1>
  <p class="tagline">{tagline}</p>
  <p class="hikae">…</p>                                  <!-- isSample のときだけ -->
  <p class="midashi">{headline}</p>
  <p class="lead">{lead}</p>
</main>
{photo ? '<figure class="photo">…</figure>' : ''}
<div class="kamachi"></div>
<main class="wrap">
  <section><h2>のれんの内側</h2><p>{about}</p></section>
  <section class="shina"><h2>うちの決めごと</h2><ul>…</ul></section>
  <section><h2>暖簾をくぐる前に</h2><p>{closing}</p></section>
  <section class="shina">
    <a class="tel" href="tel:…">☎ {電話}</a>
    <p class="gyo"><span class="fuda">所在</span><span class="v">…</span></p>
    <p class="gyo"><span class="fuda">商い</span><span class="v">…</span></p>
  </section>
</main>
<footer class="shikiishi"><div class="wrap">…</div></footer>
```

`h1` は屋号（`.yago`）に付ける。`.midashi` は `<p>`。

**CSS**

```css
*{box-sizing:border-box}
html{overflow-x:clip}
body{margin:0;background:var(--paper);color:var(--sumi);font-family:var(--gothic);font-size:16px;line-height:1.95;
  background-image:radial-gradient(circle at 22% 32%,rgb(111 83 52/.05) 0 1px,transparent 1.7px),
                   radial-gradient(circle at 71% 66%,rgb(22 51 79/.045) 0 1px,transparent 1.7px);
  background-size:23px 19px,31px 27px}
.wrap{max-width:640px;margin:0 auto;padding:0 22px}

.noki{height:18px;background:var(--ai-deep)}
.sao{height:5px;background:linear-gradient(180deg,#9A7850 0 2px,#6F5334 2px,#4E3A22)}
.noren{display:flex;gap:6px;align-items:flex-start;height:clamp(150px,34vw,210px);
  padding:0 clamp(10px,4.5vw,24px);background:var(--paper);overflow-x:hidden}
.haba{flex:1;height:97%;border-radius:0 0 2px 2px;transform-origin:top center;
  background:repeating-linear-gradient(90deg,rgb(243 239 228/.055) 0 1px,transparent 1px 4px),
             linear-gradient(180deg,var(--ai) 0 70%,var(--ai-deep) 100%);
  box-shadow:inset -7px 0 12px rgb(0 0 0/.17),0 10px 20px rgb(14 36 56/.15);
  animation:yure 12s ease-in-out infinite}
.haba:first-child{height:93%}
.haba:last-child{height:96%;animation-delay:-6s}
.haba.naka{flex:1.45;height:100%;display:flex;align-items:center;justify-content:center;
  animation:yure-naka 14s ease-in-out infinite;animation-delay:-3s}
.somenuki{writing-mode:vertical-rl;text-orientation:upright;font-family:var(--mincho);color:var(--somenuki);
  font-size:clamp(1.4rem,8.4vw,var(--dye-max));letter-spacing:.30em;padding-block-end:.30em;max-height:84%}
@keyframes yure{0%,100%{transform:rotate(-.2deg)}50%{transform:rotate(.2deg)}}
@keyframes yure-naka{0%,100%{transform:rotate(-.08deg)}50%{transform:rotate(.08deg)}}
@media (prefers-reduced-motion:reduce){.haba,.haba.naka{animation:none}}

.fuda-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:clamp(22px,6vw,34px)}
.mokusatsu{font-size:.76rem;letter-spacing:.14em;color:var(--kiji);
  border:1px solid var(--kiji);border-radius:2px;padding:3px 10px;line-height:1.7}
.yago{font-family:var(--mincho);font-feature-settings:"palt" 1;
  font-size:clamp(1.7rem,7.2vw,2.6rem);line-height:1.45;letter-spacing:.05em;
  margin:14px 0 0;overflow-wrap:anywhere;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.in{flex:none;width:38px;height:38px;border-radius:2px;background:var(--beni);color:var(--somenuki);
  font-family:var(--mincho);display:inline-flex;align-items:center;justify-content:center;
  font-size:1.2rem;transform:rotate(-2.5deg)}
.tagline{font-family:var(--mincho);color:var(--ai);font-size:1.05rem;letter-spacing:.03em;
  border-left:3px solid var(--beni);padding-left:13px;margin:20px 0 0}
.midashi{font-family:var(--mincho);font-feature-settings:"palt" 1;color:var(--ai);
  font-size:clamp(1.55rem,6.4vw,2.15rem);line-height:1.6;letter-spacing:.03em;
  word-break:auto-phrase;line-break:strict;margin:26px 0 12px}
.lead{color:var(--kiji);margin:0;line-break:strict}
.hikae{margin:20px 0 0;padding:14px 16px;background:var(--washi);border-radius:2px;
  border-left:3px solid var(--beni);font-size:.84rem;line-height:1.8}

.kamachi{height:clamp(52px,13vw,84px);margin-top:clamp(26px,7vw,40px);
  background:linear-gradient(180deg,rgb(255 255 255/.26) 0 2px,transparent 2px),
    repeating-linear-gradient(180deg,rgb(0 0 0/.10) 0 1px,transparent 1px 5px,rgb(0 0 0/.05) 5px 6px,transparent 6px 13px),
    linear-gradient(180deg,#7D6040,#54401F);
  box-shadow:inset 0 -9px 15px rgb(0 0 0/.24)}
.photo{margin:clamp(26px,7vw,40px) auto 0;max-width:var(--photo-max);aspect-ratio:var(--photo-aspect);
  border-radius:2px;overflow:hidden;background:var(--washi);box-shadow:0 12px 26px rgb(34 30 26/.14)}
.photo img{width:100%;height:100%;object-fit:cover;display:block}
.photo+.kamachi{height:12px;margin-top:0}

section{margin:clamp(34px,9vw,52px) 0}
h2{font-family:var(--mincho);color:var(--ai);font-size:1.22rem;letter-spacing:.08em;
  margin:0 0 14px;display:flex;align-items:center;gap:10px;line-height:1.5}
h2::before{content:"";flex:none;width:3px;height:1em;background:var(--ai)}
p{margin:0 0 1em}
.shina{background:var(--washi);border-radius:2px;padding:24px 20px;
  box-shadow:0 1px 0 rgb(34 30 26/.07),0 14px 26px rgb(34 30 26/.06)}
.shina ul{list-style:none;margin:0;padding:0}
.shina li{position:relative;padding-left:18px;margin:0 0 14px}
.shina li:last-child{margin-bottom:0}
.shina li::before{content:"";position:absolute;left:0;top:.62em;width:2px;height:.95em;background:var(--beni)}
.tel{display:flex;align-items:center;justify-content:center;gap:10px;min-height:56px;margin:0 0 16px;
  border-radius:2px;background:var(--beni);color:var(--somenuki);text-decoration:none;
  font-size:1.22rem;font-weight:700;letter-spacing:.06em}
.gyo{display:flex;gap:12px;align-items:flex-start;min-height:44px;padding:11px 0;
  border-bottom:1px solid rgb(111 83 52/.26);margin:0}
.gyo:last-child{border-bottom:0}
.gyo .fuda{flex:none;width:5.2em;margin-top:5px;padding:2px 0;text-align:center;font-size:.76rem;
  letter-spacing:.1em;color:var(--kiji);border:1px solid rgb(111 83 52/.5);border-radius:2px;line-height:1.7}
.gyo .v{flex:1;min-width:0;overflow-wrap:anywhere}
.gyo a{color:var(--sumi);text-underline-offset:4px;text-decoration-thickness:1px;
  display:inline-flex;align-items:center;min-height:44px}
.shikiishi{background:var(--ai-deep);color:var(--paper);margin-top:clamp(40px,10vw,64px);padding:26px 0 30px}
.shikiishi .wrap{font-size:.76rem;line-height:1.85}
.shikiishi a{color:var(--paper)}
@media (min-width:720px){.noren{height:236px}}
```

---

### 7-3. 短冊（`tanzaku.ts`）— 飲食店以外

**位置づけ**: 垂線案の修正版。審査で潰された3点（17pxの見出し／82svhの空白／縦組みの店名長に上限なし・ラテン矛盾）を全部直したうえで、「静かな一枚」の主張だけを残す。名刺と同じ客層を別の顔でカバーするために要る（美容・サロンが名刺1本だと全店同じ顔になる）。

**配色（5種）**

固定: `paper #F2F3EF`（クリームではなく冷たい灰白＝AI定番1回避） / `surface #FAFAF7` / `ink #1F2320` / `sub #565C55`

| key | temp | strip | 実測（見出し strip/paper） |
|---|---|---|---|
| 藍 | calm | `#1B3A54` | 10.59 |
| 臙脂 | warm | `#6B2333` | 9.85 |
| 苔 | fresh | `#23402C` | 10.23 |
| 墨 | calm | `#2E2C2A` | 12.48 |
| 菫 | warm | `#4A3A6B` | 8.94 |

共通実測: ink/paper 14.28、ink/surface 15.22、sub/paper 6.16、白抜き surface/strip 9.52〜13.51。

**書体**: 名刺と同じ2スタック。明朝は**縦組みの短冊とh1だけ**。

**見出し語彙**: `ここでしていること` / `ふだんのこと` / `お越しになる方へ`
**連絡先ラベル**: `電話` / `ところ` / `あいている時間`（ラベル欄は `7em`）

**見出し型5本**（この型だけ体言止めで揃える＝他3型と文型がぶつからない）

```ts
[
  (p) => (p.area && p.word ? `${p.area}、${p.word}。${p.store}。` : null),
  (p) => (p.area && p.word ? `${p.store}。${p.area}の${p.word}。` : null),
  (p) => (p.area ? `${p.area}にひとつ。${p.store}。` : null),
  (p) => (p.word ? `${p.word}、${p.store}。` : null),
  (p) => `${p.store}。`,
]
```

**signature: 下がった短冊と、最後まで走る色帯**

ヒーローの左に幅 `clamp(58px,17vw,84px)` の縦帯を上端から吊り、下端を `clip-path` でV字に切り欠く。中に白の縦組み。ヒーロー以降はページ左端を6pxの同色帯が最後まで走り、1本の線でページを串刺しにする。写真ゼロでも縦に長い物体が画面の左1/5を占めるので、白い空白が出ない。

**修正点**
- **h1 は 17px ではなく `clamp(1.5rem,6vw,2.05rem)`**。
- **ヒーローは `min(55svh,460px)`**（82svhをやめる）。電話が1スクロール以内に入る。
- **縦組みの中身は決定的な梯子**で決める。矛盾（ラテン名を縦に積むのか横倒しにするのか）を構造ごと消す:
  1. `dyedTextOf(storeName)` が CJK を返し、かつ8文字以内 → それ
  2. だめなら `areaFull`（必ずCJK）
  3. だめなら `word`
  4. だめなら空（帯だけ。文字を出さない）
  ラテン名の店は 1 で単文字（`dyedTextOf` が頭1文字を返す）になるので、積み上げ問題が起きない。
- `writing-mode` と `text-orientation` を**両方明示**する。
- フォントサイズは文字数から決める（`--dye-max`）。

**HTML骨組み**

```html
<div class="hero">
  <div class="tanzaku"><span class="tate">{dyedText or areaFull or word}</span></div>
  <div class="hero__body">
    <p class="kuni industry">{word}</p>
    <h1>{headline}</h1>
    <p class="tagline">{tagline}</p>
    <p class="lead">{lead}</p>
  </div>
</div>
<main>
  <p class="sample-notice">…</p>
  <p class="yago">{storeName}</p>
  {photo}
  <section><h2>ここでしていること</h2><p>{about}</p></section>
  <section><h2>ふだんのこと</h2><ul>…</ul></section>
  <section><h2>お越しになる方へ</h2><p>{closing}</p><div class="contact">…</div></section>
  <footer>…</footer>
</main>
```

**CSS**

```css
*{box-sizing:border-box}
html{overflow-x:clip}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--gothic);font-size:16px;line-height:1.95}
.hero{display:flex;gap:clamp(16px,5vw,28px);align-items:stretch;
  min-height:420px;min-height:min(55svh,460px);padding:0 22px 28px 0}
.tanzaku{flex:none;width:clamp(58px,17vw,84px);background:var(--strip);
  display:flex;justify-content:center;padding:clamp(18px,5vw,26px) 0 34px;
  clip-path:polygon(0 0,100% 0,100% calc(100% - 18px),50% 100%,0 calc(100% - 18px));
  box-shadow:0 10px 22px rgb(31 35 32/.16)}
.tate{writing-mode:vertical-rl;text-orientation:upright;font-family:var(--mincho);color:var(--surface);
  font-size:clamp(1.15rem,6.4vw,var(--dye-max));letter-spacing:.26em;padding-block-end:.26em;line-height:1}
.hero__body{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;
  padding-top:clamp(28px,8vw,44px)}
.kuni{margin:0 0 12px;font-size:.72rem;letter-spacing:.22em;color:var(--sub)}
h1{font-family:var(--mincho);font-weight:400;font-size:clamp(1.5rem,6vw,2.05rem);line-height:1.62;
  letter-spacing:.04em;margin:0;word-break:auto-phrase;line-break:strict;font-feature-settings:"palt" 1}
.tagline{margin:18px 0 0;padding-left:13px;border-left:3px solid var(--strip);font-size:.96rem;font-weight:500}
.lead{margin:16px 0 0;color:var(--sub);font-size:.94rem;line-break:strict}

main{max-width:640px;margin:0 auto;padding:0 22px 60px;border-left:6px solid var(--strip)}
.yago{margin:0 0 clamp(26px,7vw,38px);font-size:.86rem;letter-spacing:.14em;color:var(--sub)}
.photo{margin:0 0 clamp(26px,7vw,38px);max-width:var(--photo-max);aspect-ratio:var(--photo-aspect);
  overflow:hidden;border-radius:2px;background:var(--surface)}
.photo img{width:100%;height:100%;object-fit:cover;display:block}
section{background:var(--surface);border-left:1px solid color-mix(in srgb,var(--strip) 22%,transparent);
  padding:26px 22px;margin:0 0 14px}
h2{font-family:var(--mincho);font-weight:400;color:var(--strip);font-size:1.16rem;letter-spacing:.08em;
  margin:0 0 14px;line-height:1.5}
p{margin:0 0 1em}
section p:last-child{margin-bottom:0}
ul{list-style:none;margin:0;padding:0}
li{position:relative;padding-left:17px;margin:0 0 12px;line-height:1.9}
li::before{content:"";position:absolute;left:0;top:.85em;width:9px;height:1px;background:var(--strip)}
.sample-notice{margin:0 0 24px;padding:14px 16px;background:var(--surface);
  border-left:3px solid var(--strip);font-size:.8rem;line-height:1.85}
.contact{margin-top:20px;border-top:1px solid color-mix(in srgb,var(--sub) 26%,transparent);padding-top:8px}
.row{display:flex;gap:12px;align-items:center;min-height:44px;margin:0;font-size:.9rem}
.row .k{flex:none;width:7em;font-size:.7rem;letter-spacing:.1em;color:var(--sub)}
.row .v{flex:1;min-width:0;overflow-wrap:anywhere}
.row a{color:var(--ink);text-decoration:underline;text-underline-offset:4px;
  text-decoration-thickness:1px;display:inline-flex;align-items:center;min-height:44px}
footer{color:var(--sub);font-size:.74rem;line-height:1.9;margin-top:28px}
footer a{color:var(--strip)}
```

---

### 7-4. 方眼（`hogan.ts`）— 美容・サロン以外

**位置づけ**: 減量版。**蛍光ペンと囲みは実装しない。手描きは見出し下線1箇所だけ。**

**配色（3種）**

固定: `paper #FCFBF4` / `band #EFEEE2` / `ink #23282B` / `sub #575D58` / `grid #C7CFD2`（**装飾専用。この上に文字を置かない**。paper比 1.52:1 と低いのは承知のうえで、罫が本文の裏を通らない設計にしてある）

| key | temp | pen | 実測（見出し pen/paper） |
|---|---|---|---|
| 青インク | calm | `#1F4E79` | 8.35 |
| 焦茶インク | warm | `#6B3B14` | 8.95 |
| 緑インク | fresh | `#1B5545` | 8.32 |

共通実測: ink/paper 14.36、ink/band 12.77、sub/paper 6.51、sub/band 5.78、白抜き paper/pen 8.32〜8.95。

**書体（この型だけ明朝を一切使わない＝AI定番1を構造的に回避）**

```
--maru: "Hiragino Maru Gothic ProN","Hiragino Maru Gothic Pro","BIZ UDPGothic","Yu Gothic Medium","Noto Sans JP",Meiryo,sans-serif
```

**`font-weight` は 500 を上限にする（絶対）**。Hiragino Maru Gothic は実質W4しか持たず、700指定すると合成太字で潰れる。見出しの太さは色（pen）とサイズで出す。

**見出し語彙**: `おぼえがき` / `きめていること` / `お立ち寄りの前に`
**連絡先ラベル**: `電話` / `場所` / `時間`

**見出し型5本**（この型は素直な事実文で揃える）

```ts
[
  (p) => (p.area && p.word ? `${p.area}の${p.word}、${p.store}です。` : null),
  (p) => (p.area && p.word ? `${p.store}。${p.area}で${p.word}をしています。` : null),
  (p) => (p.area ? `${p.store}は${p.area}にあります。` : null),
  (p) => (p.word ? `${p.word}の${p.store}です。` : null),
  (p) => `${p.store}です。`,
]
```

**signature: 二度なぞりの下線**

h2の下に、わずかにずれた2本の線を `background-image` の `linear-gradient` 2層で引く。両端を transparent に落として、手で引いた線に見せる。**フォント非依存なので、Mac/Win/Android の書体差で崩れない**（審査で「signature が font 非依存なのは致命傷ではない」と認められた設計を維持）。

**修正点**
- 方眼罫は**ヒーロー帯と節間の余白帯にだけ**敷く。本文段落の背後には絶対に敷かない。
- 蛍光ペン・囲みは実装しない。
- `font-weight` 上限500。
- 写真ゼロ対策は「大きい方眼帯」が担う（`clamp(150px,38vw,220px)` のヒーロー帯の中にh1を置く）。

**HTML骨組み**

```html
<div class="hero">
  <div class="wrap">
    <p class="mise industry">{word}｜{areaFull}</p>   <!-- 片方しか無ければ片方だけ -->
    <h1>{headline}</h1>
    <p class="tagline">{tagline}</p>
  </div>
</div>
<main class="wrap">
  <p class="sample-notice">…</p>
  <p class="yago">{storeName}</p>
  <p class="lead">{lead}</p>
  {photo}
  <section><h2>おぼえがき</h2><p>{about}</p></section>
  <div class="kiri"></div>
  <section><h2>きめていること</h2><ul>…</ul></section>
  <div class="kiri"></div>
  <section><h2>お立ち寄りの前に</h2><p>{closing}</p><div class="contact">…</div></section>
  <footer>…</footer>
</main>
```

**CSS**

```css
*{box-sizing:border-box}
html{overflow-x:clip}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--maru);
  font-size:16px;font-weight:400;line-height:1.95}
.wrap{max-width:640px;margin:0 auto;padding:0 22px}
/* 方眼はヒーロー帯と切り取り線の帯にだけ敷く。本文の裏には通さない */
.hero{min-height:clamp(150px,38vw,220px);display:flex;align-items:flex-end;
  padding:clamp(26px,8vw,44px) 0 clamp(20px,6vw,32px);background:var(--band);
  background-image:linear-gradient(var(--grid) 1px,transparent 1px),
                   linear-gradient(90deg,var(--grid) 1px,transparent 1px);
  background-size:26px 26px;border-bottom:1px solid var(--grid)}
.mise{margin:0 0 10px;font-size:.74rem;letter-spacing:.16em;color:var(--sub)}
h1{font-weight:500;font-size:clamp(1.5rem,6.2vw,2.1rem);line-height:1.6;letter-spacing:.02em;
  margin:0;word-break:auto-phrase;line-break:strict}
.tagline{margin:14px 0 0;font-size:.96rem;font-weight:500;color:var(--pen)}
main{padding-bottom:56px}
.yago{margin:clamp(24px,7vw,34px) 0 0;font-size:.86rem;letter-spacing:.12em;color:var(--sub)}
.lead{margin:10px 0 0;color:var(--sub);font-size:.95rem;line-break:strict}
.photo{margin:clamp(24px,7vw,34px) auto 0;max-width:var(--photo-max);aspect-ratio:var(--photo-aspect);
  overflow:hidden;border-radius:2px;background:var(--band);box-shadow:0 10px 22px rgb(35 40 43/.1)}
.photo img{width:100%;height:100%;object-fit:cover;display:block}
section{margin:clamp(28px,8vw,40px) 0}
/* signature：二度なぞりの下線。両端をtransparentに落として手で引いた線にする */
h2{font-weight:500;font-size:1.2rem;letter-spacing:.06em;color:var(--pen);
  margin:0 0 16px;padding-bottom:11px;line-height:1.5;display:inline-block;
  background-repeat:no-repeat;
  background-image:
    linear-gradient(90deg,transparent 0,var(--pen) 3%,var(--pen) 96%,transparent 100%),
    linear-gradient(90deg,transparent 0,var(--pen) 8%,var(--pen) 91%,transparent 100%);
  background-size:100% 2px,96% 1px;
  background-position:0 100%,3px calc(100% - 3px)}
p{margin:0 0 1em}
section p:last-child{margin-bottom:0}
ul{list-style:none;margin:0;padding:0}
li{position:relative;padding-left:22px;margin:0 0 13px;line-height:1.9}
li::before{content:"";position:absolute;left:2px;top:.72em;width:9px;height:9px;
  border:1.5px solid var(--pen);border-radius:2px}
/* 切り取り線。方眼はここにも敷いてよい（文字が乗らないため） */
.kiri{height:26px;margin:clamp(26px,7vw,36px) 0;
  background-image:linear-gradient(90deg,var(--grid) 0 8px,transparent 8px 16px);
  background-size:16px 1px;background-repeat:repeat-x;background-position:0 50%}
.sample-notice{margin:clamp(24px,7vw,34px) 0 0;padding:14px 16px;background:var(--band);
  border-left:3px solid var(--pen);border-radius:2px;font-size:.8rem;line-height:1.85}
.contact{margin-top:20px;border-top:1px solid var(--grid);padding-top:8px}
.row{display:flex;gap:12px;align-items:center;min-height:44px;margin:0;font-size:.9rem}
.row .k{flex:none;width:3.2em;font-size:.72rem;letter-spacing:.1em;color:var(--pen);font-weight:500}
.row .v{flex:1;min-width:0;overflow-wrap:anywhere}
.row a{color:var(--ink);text-decoration:underline;text-underline-offset:4px;
  text-decoration-thickness:1px;display:inline-flex;align-items:center;min-height:44px}
footer{color:var(--sub);font-size:.74rem;line-height:1.9;margin-top:30px}
footer a{color:var(--pen)}
```

---

## 8. 実装の順番

各ステップ単体でデプロイでき、次に進まなくても価値が残る順に並べてある。

| # | やること | 触るファイル | ここまでで得られるもの |
|---|---|---|---|
| **1** | `hash.ts` `parts.ts` `headline.ts` を作り、**現行デザインのまま** h1を決定的な見出しに差し替え、lead/highlightsのクリシェ除去、機械文キャッチの非表示を入れる | render.ts + 新規3本 | **「心温まるひととき」問題がこの時点で全部消える。** デザイン変更ゼロなのでリスクが最も低い。172店の作り直しはここで一度やる |
| **2** | `types.ts` `select.ts` `skeletons/` の器を作り、現行の見た目を `legacy` 骨格としてそのまま移植（1ピクセルも変えない）。`options.skeleton` を追加 | render.ts分割 | 器が入る。テストは全部緑のまま |
| **3** | **名刺**を実装。選択を「名刺 / legacy」の2択にする | meishi.ts | 半数のページが別の顔になる。最も難しい signature（空押し）をここで片付ける |
| **4** | **暖簾**を実装（飲食店のみ） | noren.ts | 飲食店が3択になる |
| **5** | **短冊**を実装（飲食店以外） | tanzaku.ts | 美容・サロンが2択になる。ここで全業種が最低2択を満たす |
| **6** | **方眼**を実装（美容・サロン以外） | hogan.ts | 表の完成 |
| **7** | `legacy` を削除。`SYSTEM_PROMPT` から `headline` キーを落とし、`GeneratedContent`・`qa.ts`・テストを同時に直す | provider.ts / qa.ts / tests | 死にコード・死にトークンの除去 |

Step 3〜6 はそれぞれ、実ブラウザ（390px幅）で以下を必ず確認してから次へ:
写真あり／写真なし／住所が取れない店／店名40文字／店名がラテン／highlights 0件／`sample:true` の7ケース。`options.skeleton` で骨格を固定して1店ぶん全型を並べて撮ると速い。

---

## 9. 壊れうる箇所

### 9-1. 既存テスト（`worker/tests/index.test.ts`）

| 落ちるもの | 何を見ている | 対処 |
|---|---|---|
| `--photo-aspect` 系 5件 | `/--photo-aspect: 3 \/ 4/` 等の**文字列** | 全骨格の `:root` に `--photo-aspect` `--photo-max` を必ず出す。変数名を変えない |
| 「その他のとき業種を印字しない」 | `class="industry"` の有無 | 業種を出す要素に `industry` クラスを併記（`class="mokusatsu industry"`） |
| 「業種を印字する」 | `/class="industry">飲食店</` | 上と同じ。ただし**この正規表現は `class="mokusatsu industry"` に一致しない**。テスト側を `/class="[^"]*industry"[^>]*>飲食店</` に直す |
| 「キャッチコピーが出る」 | `/class="tagline">三代つづく、町の定食屋</` | fixtureのキャッチは自筆判定になるので表示される。クラス名の順序だけ注意（上と同じ修正） |
| 「highlightsが空なら節ごと出さない」 | 文字列 `大切にしていること` | 骨格ごとに見出しが変わるので、`options.skeleton` で固定して新しい見出し語で assert し直す |
| フッター文言 | `このお店へのお問い合わせ窓口ではありません` | フッター文は一字も変えない |

**テストは必ず `options.skeleton` で骨格を固定すること。** 固定しないと、fixture の店名（`喫茶かえる`）から選ばれた骨格に依存し、骨格を1つ足すたびにテストが落ちる。

### 9-2. 実装で踏みやすい罠

1. **空押しが横スクロールを作る** — `.deboss` を `.meishi__field`（`overflow:hidden`）の子にしないと、`right:-30%` の巨大文字がそのまま画面外にはみ出す。`pointer-events:none` を忘れると角印やリンクが押せなくなる。
2. **暖簾の回転で横スクロール** — `.noren{overflow-x:hidden}` が必須。加えて `html{overflow-x:clip}` を保険にする（`clip` はスクロールコンテナを作らないので `hidden` より安全）。
3. **縦組みの letter-spacing が下に余りを作る** — `padding-block-end` を `letter-spacing` と同値入れて相殺する（`.somenuki` `.tate` 両方）。
4. **合成太字の潰れ** — 方眼で `font-weight:700` を書いた瞬間に見出しが潰れる。500上限。
5. **`background-attachment: fixed`** — iOS Safari で実質効かず塗り替えが重い。使わない。
6. **絵文字の屋号** — `initialOf` / `dyedTextOf` が null を返したら、印・空押し・染め抜きを**出さない**。現行 `faviconDataUri` の `?? "・"` も同時に直す。
7. **住所パースの取りこぼし** — 「大阪市中央区…」のように都道府県が無い住所は取れない。取れないときは地域を書かない（見出し型が自動で落ちる）。ここで無理に推測すると `無い事実は作らない` に反する。
8. **二重エスケープ** — `SkeletonContext` の文字列は全部エスケープ済み。骨格側で `escapeHtml` を呼ばない。逆に、骨格が `input` を直接読むと生の値が漏れる。骨格には `input` / `content` を渡さない設計にしてある。
9. **`word-break: auto-phrase`** — 現行コードで既に使っており対応ブラウザは限られるが、未対応でも通常の折り返しに落ちるだけで壊れない。全骨格の h1 に付ける。
10. **配色を増やしたときのコントラスト** — 新しいパレットを足すときは、必ず本文・補助・見出し・白抜き・フッターの5系統を 4.5:1 で測ってから足す。検証スクリプトは `(ローカル一時パス・削除済み)` に置いてある（プロジェクト配下に移すこと）。
11. **同じ店を作り直すと見た目が変わる** — `seedOf` に住所を混ぜているので、住所を直して再生成すると骨格が変わる。営業で見せた見本と別物になるのが困る場合は、`options.skeleton` で固定して作り直す。

### 9-3. データ側

- 見本バッチ（`/api/sample`）が送る `colorTheme` は無視される（`isSample` のときはハッシュで選ぶ）。バッチ側を直す必要はない。
- 既にKVに入っている172ページのHTMLは**上書きされない**（`site:{slug}` に保存済みのため）。新しい見た目にするには作り直しが要る。Step 1 の時点で一度やり、Step 6 の完了後にもう一度やる。旧URLを保つ必要があるなら、同じ slug に `put` し直すバッチを別途書く。
