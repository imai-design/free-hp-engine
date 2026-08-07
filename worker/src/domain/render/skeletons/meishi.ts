import { footerHtml, renderActionLinks, renderContactRows, renderMenuItems, SAMPLE_NOTICE_HTML } from "../parts.ts";
import type { HeadlineParts, Palette, Skeleton, SkeletonContext } from "../types.ts";

// 固定トークン（配色に依存しない）。5配色すべてに同じ値を混ぜる。
const FIXED = {
  card: "#FBFAF6",
  paper: "#F5F3EC",
  ink: "#1A2229",
  sub: "#56605E",
  rule: "#DCD8CC",
  deboss: "#F3F1EA",
  foot: "#C6CFD4",
  footlink: "#DCE3E7",
};

const PALETTES: readonly Palette[] = [
  { key: "藍鼠", temp: "calm", mark: "#0F5E6B", vars: { ...FIXED, ground: "#22303A", seal: "#0F5E6B" } },
  { key: "焦茶", temp: "warm", mark: "#8A4A12", vars: { ...FIXED, ground: "#33281F", seal: "#8A4A12" } },
  { key: "深緑", temp: "fresh", mark: "#14614A", vars: { ...FIXED, ground: "#1F3329", seal: "#14614A" } },
  { key: "葡萄", temp: "calm", mark: "#5C3B78", vars: { ...FIXED, ground: "#2C2634", seal: "#5C3B78" } },
  { key: "利休鼠", temp: "fresh", mark: "#4A5A2B", vars: { ...FIXED, ground: "#2B322F", seal: "#4A5A2B" } },
];

const HEADINGS = { about: "この店のはなし", highlights: "うちの流儀", closing: "ご用の際は" };
const CONTACT_LABELS = { phone: "電話", address: "所在", hours: "営業" };

const HEADLINES: readonly ((parts: HeadlineParts) => string | null)[] = [
  (p) => (p.area && p.word ? `${p.store}。${p.area}の${p.word}です。` : null),
  (p) => (p.area && p.word ? `${p.area}で${p.word}をひとつ。${p.store}。` : null),
  (p) => (p.area ? `用のあるときは、${p.area}の${p.store}へ。` : null),
  (p) => (p.word ? `${p.word}の${p.store}、と申します。` : null),
  (p) => `${p.store}と申します。`,
];

const CSS = `
:root{
  --mincho:"Hiragino Mincho ProN","HiraMinProN-W3","Yu Mincho",YuMincho,"Noto Serif JP","Noto Serif CJK JP",serif;
  --gothic:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic Medium","Yu Gothic",YuGothic,"Noto Sans JP","Noto Sans CJK JP",Meiryo,sans-serif;
  --stock:0 1px 0 #E9E5DA,0 2px 0 #DED9CC,0 3px 0 #D2CCBD,0 4px 0 #C6BFAE,0 16px 26px rgb(10 18 24/42%);
}
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
.menu__item{display:flex;align-items:baseline;gap:14px}
.menu__name{min-width:0;overflow-wrap:anywhere}
.menu__price{flex:none;margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}
.print{margin:0 0 24px;padding:9px 9px 30px;background:#fff;border-radius:2px;box-shadow:var(--stock)}
.print img{display:block;width:100%;height:auto;border-radius:1px;aspect-ratio:var(--photo-aspect);object-fit:cover}

.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}
.action{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;
  border:1.5px solid var(--seal);border-radius:3px;color:var(--seal);font-size:.82rem;font-weight:600;
  letter-spacing:.04em;text-decoration:none}
.action--reserve{background:var(--seal);color:var(--card)}
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
`;

function frontInfoLine(ctx: SkeletonContext): string {
  const phone = ctx.contactRows.find((row) => row.kind === "phone");
  const address = ctx.contactRows.find((row) => row.kind === "address");
  const parts = [phone?.valueHtml, address?.valueHtml].filter((value): value is string => Boolean(value));
  return parts.length ? `<p class="meishi__info">${parts.join("<br>")}</p>` : "";
}

function body(ctx: SkeletonContext): string {
  const field = ctx.initial
    ? `<div class="meishi__field"><span class="deboss" aria-hidden="true">${ctx.initial}</span></div>`
    : "";
  const seal = ctx.initial ? `<span class="seal" aria-hidden="true">${ctx.initial}</span>` : "";
  const spine = ctx.word ? `<span class="spine industry">${ctx.word}</span>` : "";
  const place = ctx.areaFull ? `<p class="meishi__place">${ctx.areaFull}</p>` : "";
  const tagline = ctx.tagline ? `<p class="tagline meishi__catch">${ctx.tagline}</p>` : "";
  const sampleNotice = ctx.isSample ? `<p class="sample-notice">${SAMPLE_NOTICE_HTML}</p>` : "";
  const photo = ctx.photo
    ? `<figure class="print"><img src="${ctx.photo.srcHtml}" alt="${ctx.photo.altHtml}" loading="eager" decoding="async"></figure>`
    : "";
  const lead = ctx.lead ? `<p class="ura__lead">${ctx.lead}</p>` : "";
  const highlights = ctx.highlights.length
    ? `<h2>${HEADINGS.highlights}</h2><ul>${ctx.highlights.map((item) => `<li>${item}</li>`).join("")}</ul>`
    : "";
  const menu = ctx.menuItems.length
    ? `<section class="menu"><h2>しな書き</h2><ul class="menu__list">${renderMenuItems(ctx.menuItems)}</ul></section>`
    : "";
  const actions = renderActionLinks(ctx.actions, "actions", "action");
  const contact = ctx.contactRows.length
    ? `<div class="contact">${renderContactRows(ctx.contactRows, CONTACT_LABELS, "row", "k")}</div>`
    : "";

  return `<main>
  <article class="meishi">
    ${field}
    ${spine}
    ${seal}
    ${place}
    <h1 class="meishi__name">${ctx.storeName}</h1>
    ${tagline}
    ${frontInfoLine(ctx)}
  </article>
  ${sampleNotice}
  <p class="fold">うら</p>
  <article class="ura">
    ${photo}
    <h2 class="ura__mark">うら書き</h2>
    <p class="ura__headline">${ctx.headline}</p>
    ${lead}
    <h2>${HEADINGS.about}</h2><p>${ctx.about}</p>
    ${highlights}
    ${menu}
    <h2>${HEADINGS.closing}</h2><p>${ctx.closing}</p>
    ${actions}
    ${contact}
  </article>
  <footer>${footerHtml(ctx.isSample)}</footer>
</main>`;
}

export const MEISHI: Skeleton = {
  key: "名刺",
  industries: ["飲食店", "美容・サロン", "その他"],
  palettes: PALETTES,
  headings: HEADINGS,
  contactLabels: CONTACT_LABELS,
  headlines: HEADLINES,
  css: CSS,
  body,
};
