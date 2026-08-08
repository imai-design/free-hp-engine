import { footerHtml, renderActionLinks, renderContactRows, renderMenuItems, SAMPLE_NOTICE_HTML } from "../parts.ts";
import type { HeadlineParts, Palette, Skeleton, SkeletonContext } from "../types.ts";

const FIXED = {
  paper: "#FCFBF4",
  band: "#EFEEE2",
  ink: "#23282B",
  sub: "#575D58",
  grid: "#C7CFD2",
};

const PALETTES: readonly Palette[] = [
  { key: "青インク", temp: "calm", mark: "#1F4E79", vars: { ...FIXED, pen: "#1F4E79" } },
  { key: "焦茶インク", temp: "warm", mark: "#6B3B14", vars: { ...FIXED, pen: "#6B3B14" } },
  { key: "緑インク", temp: "fresh", mark: "#1B5545", vars: { ...FIXED, pen: "#1B5545" } },
];

const HEADINGS = { about: "おぼえがき", highlights: "きめていること", closing: "お立ち寄りの前に" };
const CONTACT_LABELS = { phone: "電話", address: "場所", hours: "時間" };

// この型は素直な事実文で揃える
const HEADLINES: readonly ((parts: HeadlineParts) => string | null)[] = [
  (p) => (p.area && p.word ? `${p.area}の${p.word}、${p.store}です。` : null),
  (p) => (p.area && p.word ? `${p.store}。${p.area}で${p.word}をしています。` : null),
  (p) => (p.area ? `${p.store}は${p.area}にあります。` : null),
  (p) => (p.word ? `${p.word}の${p.store}です。` : null),
  (p) => `${p.store}です。`,
];

const CSS = `
:root{
  --maru:"Hiragino Maru Gothic ProN","Hiragino Maru Gothic Pro","BIZ UDPGothic","Yu Gothic Medium","Noto Sans JP",Meiryo,sans-serif;
}
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
.menu__item{display:flex;align-items:baseline;gap:14px}
.menu__name{min-width:0;overflow-wrap:anywhere}
.menu__price{flex:none;margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}
/* 切り取り線。方眼はここにも敷いてよい（文字が乗らないため） */
.kiri{height:26px;margin:clamp(26px,7vw,36px) 0;
  background-image:linear-gradient(90deg,var(--grid) 0 8px,transparent 8px 16px);
  background-size:16px 1px;background-repeat:repeat-x;background-position:0 50%}
.sample-notice{margin:clamp(24px,7vw,34px) 0 0;padding:14px 16px;background:var(--band);
  border-left:3px solid var(--pen);border-radius:2px;font-size:.8rem;line-height:1.85}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.action{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;
  border:1.5px solid var(--pen);border-radius:3px;color:var(--pen);font-size:.85rem;font-weight:600;
  text-decoration:none}
.action--reserve{background:var(--pen);color:var(--paper)}
.contact{margin-top:20px;border-top:1px solid var(--grid);padding-top:8px}
.row{display:flex;gap:12px;align-items:center;min-height:44px;margin:0;font-size:.9rem}
.row .k{flex:none;width:3.2em;font-size:.72rem;letter-spacing:.1em;color:var(--pen);font-weight:500}
.row .v{flex:1;min-width:0;overflow-wrap:anywhere}
.row a{color:var(--ink);text-decoration:underline;text-underline-offset:4px;
  text-decoration-thickness:1px;display:inline-flex;align-items:center;min-height:44px}
footer{color:var(--sub);font-size:.74rem;line-height:1.9;margin-top:30px}
footer a{color:var(--pen)}
`;

/**
 * 業種と地域を1行にまとめる（{word}｜{areaFull}、片方しか無ければ片方だけ）。
 * industry クラスは word だけを囲む span に付け、地域文字列を混ぜて既存テストの
 * `class="[^"]*industry"[^>]*>飲食店<` 判定を壊さないようにする。
 */
function miseLine(ctx: SkeletonContext): string {
  const industry = ctx.word ? `<span class="industry">${ctx.word}</span>` : "";
  if (!industry && !ctx.areaFull) return "";
  const separator = industry && ctx.areaFull ? "｜" : "";
  return `<p class="mise">${industry}${separator}${ctx.areaFull}</p>`;
}

function body(ctx: SkeletonContext): string {
  const tagline = ctx.tagline ? `<p class="tagline">${ctx.tagline}</p>` : "";
  const sampleNotice = ctx.isSample ? `<p class="sample-notice">${SAMPLE_NOTICE_HTML}</p>` : "";
  const lead = ctx.lead ? `<p class="lead">${ctx.lead}</p>` : "";
  const photo = ctx.photo
    ? `<figure class="photo"><img src="${ctx.photo.srcHtml}" alt="${ctx.photo.altHtml}" loading="eager" decoding="async"></figure>`
    : "";
  const highlights = ctx.highlights.length
    ? `<section><h2>${HEADINGS.highlights}</h2><ul>${ctx.highlights.map((item) => `<li>${item}</li>`).join("")}</ul><div class="kiri"></div></section>`
    : "";
  const menu = ctx.menuItems.length
    ? `<section class="menu"><h2>料金表</h2><ul class="menu__list">${renderMenuItems(ctx.menuItems)}</ul></section>`
    : "";
  const actions = renderActionLinks(ctx.actions, "actions", "action");
  const contact = ctx.contactRows.length
    ? `<div class="contact">${renderContactRows(ctx.contactRows, CONTACT_LABELS, "row", "k")}</div>`
    : "";

  return `<div class="hero">
  <div class="wrap">
    ${miseLine(ctx)}
    <h1>${ctx.headline}</h1>
    ${tagline}
  </div>
</div>
<main class="wrap">
  ${sampleNotice}
  <p class="yago">${ctx.storeName}</p>
  ${lead}
  ${photo}
  <section><h2>${HEADINGS.about}</h2><p>${ctx.about}</p></section>
  <div class="kiri"></div>
  ${highlights}
  ${menu}
  <section><h2>${HEADINGS.closing}</h2><p>${ctx.closing}</p>${actions}${contact}</section>
  <footer>${footerHtml(ctx.isSample)}</footer>
</main>`;
}

export const HOGAN: Skeleton = {
  key: "方眼",
  industries: ["飲食店", "教室・スクール", "小売・物販", "修理・住まいのサービス", "その他"],
  palettes: PALETTES,
  headings: HEADINGS,
  contactLabels: CONTACT_LABELS,
  headlines: HEADLINES,
  css: CSS,
  body,
};
