import type { GeneratedContent } from "../generation/provider.ts";
import { buildSkeletonContext, escapeHtml, resolvePhotoFrame, sampleDisclaimerOf } from "./render/parts.ts";
import { selectPalette, selectSkeleton } from "./render/select.ts";
import type { SkeletonKey } from "./render/types.ts";
import type { SampleSource, SiteInput } from "./validate.ts";

const META_DESCRIPTION_MAX_LENGTH = 120;
const SITE_NAME = "AIホームページ製作所（RYOSEIWORLD）";
const SAMPLE_DISCLAIMER_CSS = `.sample-disclaimer{box-sizing:border-box;width:100%;margin:0;padding:.45rem 1rem;background:#eee;color:#444;font-family:system-ui,-apple-system,"Hiragino Sans","Yu Gothic",sans-serif;font-size:.75rem;font-weight:400;line-height:1.65;text-align:center}`;

export interface RenderSiteOptions {
  publicUrl?: string;
  /**
   * 写真を配信するURL。指定されればページ本体も共有カードもこれを参照する。
   * 無指定のときは従来どおりHTMLにdata URIを埋め込む（テストや単体呼び出し用の後方互換）。
   */
  photoUrl?: string;
  /**
   * こちらから提案するために作った見本（お店の承諾を得ていないもの）。
   * 立てると2つのことが起きる:
   *  1. 検索エンジンに載せない（店名入りのページが公式サイトと誤解されるため）
   *  2. 「紹介文は仮のもの」とページ上に明記する
   * 2が要るのは、AIが薄い入力から「丁寧なカウンセリングを心がけています」のような
   * 確かめていない事実を書いてしまうため。断らずに出すと、お店について嘘を書くことになる。
   */
  sample?: boolean;
  /**
   * 見本の元ネタ。sample:true のときだけ意味を持ち、断り書きの文言を変える。
   * 省略時は "map"（後方互換：既存の呼び出し元は指定しない）。
   */
  sampleSource?: SampleSource;
  /** 骨格を固定する。テストと、営業で見せ分けたいときだけ使う。 */
  skeleton?: SkeletonKey;
}

export { escapeHtml };

const text = (value: string | undefined): string => escapeHtml(value ?? "");

function truncateText(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

/**
 * 店名の頭文字を使ったファビコンをSVGのdata URIで作る。
 * 外部ファイルを置かずに済ませるため。CSPの img-src が 'self' data: を許可しているのでそのまま表示できる。
 * initial が null（絵文字・記号で始まる屋号）なら「・」を使い、タブに何も出ない状態を避ける。
 */
function faviconDataUri(initial: string | null, mark: string): string {
  const glyph = initial ?? "・";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${mark}"/><text x="32" y="45" font-family="system-ui,sans-serif" font-size="38" font-weight="700" fill="#ffffff" text-anchor="middle">${escapeHtml(glyph)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * renderSite の呼び出し形は保つ。
 * 骨格・配色の決定はrender/select.tsへ、材料の組み立てはrender/parts.tsへ委譲し、
 * ここでは <head>・CSP・共通殻の組み立てだけを行う。
 */
export function renderSite(input: SiteInput, content: GeneratedContent, options: RenderSiteOptions = {}): string {
  const isSample = options.sample ?? false;
  const sampleSource = options.sampleSource ?? "map";
  const skeleton = selectSkeleton(input, options.skeleton);
  const palette = selectPalette(skeleton, input, isSample);
  const ctx = buildSkeletonContext(input, content, skeleton, palette, options.photoUrl, isSample, sampleSource);
  const frame = resolvePhotoFrame(input);

  const metaDescription = text(truncateText(input.description || input.catchphrase, META_DESCRIPTION_MAX_LENGTH));
  const ogUrl = options.publicUrl ? `\n  <meta property="og:url" content="${text(options.publicUrl)}">` : "";
  // 共有カード（LINE・SNS）に写真を出すには参照可能なURLが要る。data URIでは出せない。
  const sharePhotoUrl = ctx.photo ? options.photoUrl : undefined;
  const ogImage = sharePhotoUrl ? `\n  <meta property="og:image" content="${text(sharePhotoUrl)}">` : "";
  const twitterCard = sharePhotoUrl ? "summary_large_image" : "summary";
  const robots = options.sample ? `\n  <meta name="robots" content="noindex,nofollow">` : "";
  const sampleDocumentAttribute = isSample ? ' data-freehp-sample="true"' : "";
  const sampleDisclaimer = isSample
    ? `<aside class="sample-disclaimer" aria-label="見本について">${sampleDisclaimerOf(sampleSource, ctx.storeName)}</aside>\n  `
    : "";

  const rootVars = Object.entries(palette.vars)
    .map(([key, value]) => `--${key}: ${value};`)
    .join(" ");

  return `<!doctype html>
<html lang="ja"${sampleDocumentAttribute}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">${robots}
  <meta name="description" content="${metaDescription}">
  <meta property="og:title" content="${ctx.storeName}">
  <meta property="og:description" content="${metaDescription}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${text(SITE_NAME)}">${ogUrl}${ogImage}
  <meta name="twitter:card" content="${twitterCard}">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
  <link rel="icon" href="${faviconDataUri(ctx.initial, palette.mark)}">
  <title>${ctx.storeName}｜ホームページ</title>
  <style>
    :root { ${rootVars} --photo-aspect: ${frame.aspect}; --photo-max: ${frame.maxWidth}; --dye-max: ${ctx.dyedMaxRem}rem; --name-max: ${ctx.nameMaxRem}rem; }
    ${skeleton.css}${isSample ? `\n    ${SAMPLE_DISCLAIMER_CSS}` : ""}
  </style>
</head>
<body data-型="${skeleton.key}" data-配色="${palette.key}">
  ${sampleDisclaimer}${skeleton.body(ctx)}
</body>
</html>`;
}
