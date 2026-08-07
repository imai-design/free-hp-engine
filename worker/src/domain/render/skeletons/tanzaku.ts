import { footerHtml, renderActionLinks, renderContactRows, renderMenuItems, SAMPLE_NOTICE_HTML } from "../parts.ts";
import type { HeadlineParts, Palette, Skeleton, SkeletonContext } from "../types.ts";

const FIXED = {
  paper: "#F2F3EF",
  surface: "#FAFAF7",
  ink: "#1F2320",
  sub: "#565C55",
};

const PALETTES: readonly Palette[] = [
  { key: "藍", temp: "calm", mark: "#1B3A54", vars: { ...FIXED, strip: "#1B3A54" } },
  { key: "臙脂", temp: "warm", mark: "#6B2333", vars: { ...FIXED, strip: "#6B2333" } },
  { key: "苔", temp: "fresh", mark: "#23402C", vars: { ...FIXED, strip: "#23402C" } },
  { key: "墨", temp: "calm", mark: "#2E2C2A", vars: { ...FIXED, strip: "#2E2C2A" } },
  { key: "菫", temp: "warm", mark: "#4A3A6B", vars: { ...FIXED, strip: "#4A3A6B" } },
];

const HEADINGS = { about: "ここでしていること", highlights: "ふだんのこと", closing: "お越しになる方へ" };
const CONTACT_LABELS = { phone: "電話", address: "ところ", hours: "あいている時間" };

// この型だけ体言止めで揃える＝他3型と文型がぶつからない
const HEADLINES: readonly ((parts: HeadlineParts) => string | null)[] = [
  (p) => (p.area && p.word ? `${p.area}、${p.word}。${p.store}。` : null),
  (p) => (p.area && p.word ? `${p.store}。${p.area}の${p.word}。` : null),
  (p) => (p.area ? `${p.area}にひとつ。${p.store}。` : null),
  (p) => (p.word ? `${p.word}、${p.store}。` : null),
  (p) => `${p.store}。`,
];

const CSS = `
:root{
  --mincho:"Hiragino Mincho ProN","HiraMinProN-W3","Yu Mincho",YuMincho,"Noto Serif JP","Noto Serif CJK JP",serif;
  --gothic:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic Medium","Yu Gothic",YuGothic,"Noto Sans JP","Noto Sans CJK JP",Meiryo,sans-serif;
}
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
.menu__item{display:flex;align-items:baseline;gap:14px}
.menu__name{min-width:0;overflow-wrap:anywhere}
.menu__price{flex:none;margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}
.sample-notice{margin:0 0 24px;padding:14px 16px;background:var(--surface);
  border-left:3px solid var(--strip);font-size:.8rem;line-height:1.85}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.action{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;
  border:1.5px solid var(--strip);border-radius:2px;color:var(--strip);font-size:.85rem;font-weight:600;
  text-decoration:none}
.action--reserve{background:var(--strip);color:var(--surface)}
.contact{margin-top:20px;border-top:1px solid color-mix(in srgb,var(--sub) 26%,transparent);padding-top:8px}
.row{display:flex;gap:12px;align-items:center;min-height:44px;margin:0;font-size:.9rem}
.row .k{flex:none;width:7em;font-size:.7rem;letter-spacing:.1em;color:var(--sub)}
.row .v{flex:1;min-width:0;overflow-wrap:anywhere}
.row a{color:var(--ink);text-decoration:underline;text-underline-offset:4px;
  text-decoration-thickness:1px;display:inline-flex;align-items:center;min-height:44px}
footer{color:var(--sub);font-size:.74rem;line-height:1.9;margin-top:28px}
footer a{color:var(--strip)}
`;

/**
 * 縦組みの中身は決定的な梯子で決める（矛盾＝ラテン名を縦に積むか横倒しにするかを構造ごと消す）。
 * 1. dyedTextOf(storeName) の結果（8文字以内）→ それ。CJKなら5文字以内の屋号そのもの、
 *    それ以外（ラテン名を含む）は常に頭1文字なので、どちらも積み上げ問題が起きない。
 * 2. だめなら areaFull（必ずCJK）
 * 3. だめなら word
 * 4. だめなら空（帯だけ。文字を出さない）
 */
const VERTICAL_TEXT_MAX_LENGTH = 8;

function verticalTextOf(ctx: SkeletonContext): string {
  if (ctx.dyedText && Array.from(ctx.dyedText).length <= VERTICAL_TEXT_MAX_LENGTH) return ctx.dyedText;
  if (ctx.areaFull) return ctx.areaFull;
  if (ctx.word) return ctx.word;
  return "";
}

function body(ctx: SkeletonContext): string {
  const tate = verticalTextOf(ctx);
  const kuni = ctx.word ? `<p class="kuni industry">${ctx.word}</p>` : "";
  const tagline = ctx.tagline ? `<p class="tagline">${ctx.tagline}</p>` : "";
  const lead = ctx.lead ? `<p class="lead">${ctx.lead}</p>` : "";
  const sampleNotice = ctx.isSample ? `<p class="sample-notice">${SAMPLE_NOTICE_HTML}</p>` : "";
  const photo = ctx.photo
    ? `<figure class="photo"><img src="${ctx.photo.srcHtml}" alt="${ctx.photo.altHtml}" loading="eager" decoding="async"></figure>`
    : "";
  const highlights = ctx.highlights.length
    ? `<section><h2>${HEADINGS.highlights}</h2><ul>${ctx.highlights.map((item) => `<li>${item}</li>`).join("")}</ul></section>`
    : "";
  const menu = ctx.menuItems.length
    ? `<section class="menu"><h2>menu</h2><ul class="menu__list">${renderMenuItems(ctx.menuItems)}</ul></section>`
    : "";
  const actions = renderActionLinks(ctx.actions, "actions", "action");
  const contact = ctx.contactRows.length
    ? `<div class="contact">${renderContactRows(ctx.contactRows, CONTACT_LABELS, "row", "k")}</div>`
    : "";

  return `<div class="hero">
  <div class="tanzaku">${tate ? `<span class="tate">${tate}</span>` : ""}</div>
  <div class="hero__body">
    ${kuni}
    <h1>${ctx.headline}</h1>
    ${tagline}
    ${lead}
  </div>
</div>
<main>
  ${sampleNotice}
  <p class="yago">${ctx.storeName}</p>
  ${photo}
  <section><h2>${HEADINGS.about}</h2><p>${ctx.about}</p></section>
  ${highlights}
  ${menu}
  <section><h2>${HEADINGS.closing}</h2><p>${ctx.closing}</p>${actions}${contact}</section>
  <footer>${footerHtml(ctx.isSample)}</footer>
</main>`;
}

export const TANZAKU: Skeleton = {
  key: "短冊",
  industries: ["美容・サロン", "その他"],
  palettes: PALETTES,
  headings: HEADINGS,
  contactLabels: CONTACT_LABELS,
  headlines: HEADLINES,
  css: CSS,
  body,
};
