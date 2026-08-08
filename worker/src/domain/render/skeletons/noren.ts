import { footerHtml, renderActionLinks, renderMenuItems, SAMPLE_NOTICE_HTML } from "../parts.ts";
import type { HeadlineParts, Palette, Skeleton, SkeletonContext } from "../types.ts";

const FIXED = {
  paper: "#EDE6D6",
  washi: "#F5EFE1",
  sumi: "#221E1A",
  somenuki: "#F3EFE4",
  kiji: "#6F5334",
};

/*
 * 新テーマのWCAG AAコントラスト比（sRGB相対輝度、前景/背景、すべて4.5:1以上）。
 * 祭青: sumi/paper 14.56, sumi/washi 15.14, kiji/paper 7.06, kiji/washi 7.34,
 *   ai-text/paper 7.03, ai-text/washi 7.31, beni-text/paper 6.98,
 *   somenuki/ai 7.08, somenuki/ai-deep 11.84, somenuki/beni 7.03,
 *   footer-ink/ai-deep 11.76.
 * 宵紫: sumi/paper 15.42, sumi/washi 14.00, kiji/paper 9.64, kiji/washi 8.75,
 *   ai-text/paper 9.02, ai-text/washi 8.18, beni-text/paper 8.84,
 *   somenuki/ai 12.79, somenuki/ai-deep 16.01, somenuki/beni 10.14,
 *   footer-ink/ai-deep 14.77.
 */
const PALETTES: readonly Palette[] = [
  { key: "藍", temp: "calm", mark: "#16334F", vars: { ...FIXED, ai: "#16334F", "ai-deep": "#0E2438", beni: "#8E2B1D" } },
  { key: "柿渋", temp: "warm", mark: "#5E2E1F", vars: { ...FIXED, ai: "#5E2E1F", "ai-deep": "#3B1B10", beni: "#1C4A63" } },
  { key: "千歳緑", temp: "fresh", mark: "#1E3E2E", vars: { ...FIXED, ai: "#1E3E2E", "ai-deep": "#12291E", beni: "#8C3B12" } },
  {
    key: "祭青",
    temp: "lively",
    mark: "#1554A2",
    vars: {
      ...FIXED,
      paper: "#FFF8E8",
      washi: "#FFFDF6",
      sumi: "#20233A",
      somenuki: "#FFF9E9",
      kiji: "#66504A",
      ai: "#1554A2",
      "ai-deep": "#0B326C",
      "ai-text": "#1554A2",
      beni: "#A21D55",
      "beni-text": "#A21D55",
      "footer-ink": "#FFF8E8",
    },
  },
  {
    key: "宵紫",
    temp: "moody",
    mark: "#4D294B",
    vars: {
      ...FIXED,
      paper: "#161218",
      washi: "#221B23",
      sumi: "#F2E9DE",
      somenuki: "#FFF1D6",
      kiji: "#C8B8AF",
      ai: "#39223D",
      "ai-deep": "#211222",
      "ai-text": "#D7A7C5",
      beni: "#64243A",
      "beni-text": "#E1A2B3",
      "footer-ink": "#F1E8DF",
    },
  },
];

const HEADINGS = { about: "のれんの内側", highlights: "うちの決めごと", closing: "暖簾をくぐる前に" };
const CONTACT_LABELS = { phone: "電話", address: "所在", hours: "商い" };

const HEADLINES: readonly ((parts: HeadlineParts) => string | null)[] = [
  (p) => (p.area && p.word ? `${p.area}に、${p.store}という${p.word}があります。` : null),
  (p) => (p.area && p.word ? `${p.area}の${p.word}。屋号は${p.store}。` : null),
  (p) => (p.area ? `${p.store}の暖簾は、${p.area}に。` : null),
  (p) => (p.word ? `のれんの向こうは、${p.word}の${p.store}。` : null),
  (p) => `${p.store}。この暖簾が目印です。`,
];

const CSS = `
:root{
  --mincho:"Hiragino Mincho ProN","Hiragino Mincho Pro","Yu Mincho",YuMincho,"MS PMincho",serif;
  --gothic:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic Medium","Yu Gothic",YuGothic,"Noto Sans JP",Meiryo,sans-serif;
}
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
.tagline{font-family:var(--mincho);color:var(--ai-text,var(--ai));font-size:1.05rem;letter-spacing:.03em;
  border-left:3px solid var(--beni-text,var(--beni));padding-left:13px;margin:20px 0 0}
.midashi{font-family:var(--mincho);font-feature-settings:"palt" 1;color:var(--ai-text,var(--ai));
  font-size:clamp(1.55rem,6.4vw,2.15rem);line-height:1.6;letter-spacing:.03em;
  word-break:auto-phrase;line-break:strict;margin:26px 0 12px}
.lead{color:var(--kiji);margin:0;line-break:strict}
.hikae{margin:20px 0 0;padding:14px 16px;background:var(--washi);border-radius:2px;
  border-left:3px solid var(--beni-text,var(--beni));font-size:.84rem;line-height:1.8}

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
h2{font-family:var(--mincho);color:var(--ai-text,var(--ai));font-size:1.22rem;letter-spacing:.08em;
  margin:0 0 14px;display:flex;align-items:center;gap:10px;line-height:1.5}
h2::before{content:"";flex:none;width:3px;height:1em;background:var(--ai-text,var(--ai))}
p{margin:0 0 1em}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 16px}
.action{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;
  border:1.5px solid var(--beni-text,var(--beni));border-radius:2px;color:var(--beni-text,var(--beni));font-size:.86rem;font-weight:600;
  text-decoration:none}
.action--reserve{background:var(--beni);color:var(--somenuki)}
.shina{background:var(--washi);border-radius:2px;padding:24px 20px;
  box-shadow:0 1px 0 rgb(34 30 26/.07),0 14px 26px rgb(34 30 26/.06)}
.shina ul{list-style:none;margin:0;padding:0}
.shina li{position:relative;padding-left:18px;margin:0 0 14px}
.shina li:last-child{margin-bottom:0}
.shina li::before{content:"";position:absolute;left:0;top:.62em;width:2px;height:.95em;background:var(--beni-text,var(--beni))}
.menu__item{display:flex;align-items:baseline;gap:14px}
.menu__name{min-width:0;overflow-wrap:anywhere}
.menu__price{flex:none;margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}
.gyo{display:flex;gap:12px;align-items:flex-start;min-height:44px;padding:11px 0;
  border-bottom:1px solid rgb(111 83 52/.26);margin:0}
.gyo:last-child{border-bottom:0}
.gyo .fuda{flex:none;width:5.2em;margin-top:5px;padding:2px 0;text-align:center;font-size:.76rem;
  letter-spacing:.1em;color:var(--kiji);border:1px solid rgb(111 83 52/.5);border-radius:2px;line-height:1.7}
.gyo .v{flex:1;min-width:0;overflow-wrap:anywhere}
.gyo a{color:var(--sumi);text-underline-offset:4px;text-decoration-thickness:1px;
  display:inline-flex;align-items:center;min-height:44px}
/* 電話だけは呼び出しボタンとして目立たせる。中身のリンク自体は電話番号のテキストのまま（発信リンクの体裁は崩さない）。 */
.gyo--tel{background:var(--beni);border-radius:2px;padding:0 16px;border-bottom:0;margin:0 0 16px;min-height:56px}
.gyo--tel .fuda{color:var(--somenuki);border-color:var(--somenuki)}
.gyo--tel a{color:var(--somenuki);font-size:1.1rem;font-weight:700}
.shikiishi{background:var(--ai-deep);color:var(--footer-ink,var(--paper));margin-top:clamp(40px,10vw,64px);padding:26px 0 30px}
.shikiishi .wrap{font-size:.76rem;line-height:1.85}
.shikiishi a{color:var(--footer-ink,var(--paper))}
@media (min-width:720px){.noren{height:236px}}
`;

function contactSection(ctx: SkeletonContext): string {
  if (!ctx.contactRows.length) return "";
  const rows = ctx.contactRows
    .map((row) => {
      const label = CONTACT_LABELS[row.kind];
      const extra = row.kind === "phone" ? " gyo--tel" : "";
      return `<p class="gyo${extra}"><span class="fuda">${label}</span><span class="v">${row.valueHtml}</span></p>`;
    })
    .join("");
  return `<section class="shina">${rows}</section>`;
}

function body(ctx: SkeletonContext): string {
  const industryFuda = ctx.word ? `<span class="mokusatsu industry">${ctx.word}</span>` : "";
  const areaFuda = ctx.areaFull ? `<span class="mokusatsu">${ctx.areaFull}</span>` : "";
  const fudaRow = industryFuda || areaFuda ? `<div class="fuda-row">${industryFuda}${areaFuda}</div>` : "";
  const initial = ctx.initial ? `<span class="in" aria-hidden="true">${ctx.initial}</span>` : "";
  const tagline = ctx.tagline ? `<p class="tagline">${ctx.tagline}</p>` : "";
  const hikae = ctx.isSample ? `<p class="hikae">${SAMPLE_NOTICE_HTML}</p>` : "";
  const lead = ctx.lead ? `<p class="lead">${ctx.lead}</p>` : "";
  const photo = ctx.photo
    ? `<figure class="photo"><img src="${ctx.photo.srcHtml}" alt="${ctx.photo.altHtml}" loading="eager" decoding="async"></figure>`
    : "";
  const highlights = ctx.highlights.length
    ? `<section class="shina"><h2>${HEADINGS.highlights}</h2><ul>${ctx.highlights.map((item) => `<li>${item}</li>`).join("")}</ul></section>`
    : "";
  const menu = ctx.menuItems.length
    ? `<section class="shina menu"><h2>お品書き</h2><ul class="menu__list">${renderMenuItems(ctx.menuItems)}</ul></section>`
    : "";

  return `<div class="noki"></div><div class="sao"></div>
<div class="noren">
  <div class="haba"></div>
  <div class="haba naka">${ctx.dyedText ? `<span class="somenuki">${ctx.dyedText}</span>` : ""}</div>
  <div class="haba"></div>
</div>
<main class="wrap">
  ${fudaRow}
  <h1 class="yago">${ctx.storeName}${initial}</h1>
  ${tagline}
  ${hikae}
  <p class="midashi">${ctx.headline}</p>
  ${lead}
</main>
${photo}
<div class="kamachi"></div>
<main class="wrap">
  <section><h2>${HEADINGS.about}</h2><p>${ctx.about}</p></section>
  ${highlights}
  ${menu}
  <section><h2>${HEADINGS.closing}</h2><p>${ctx.closing}</p></section>
  ${renderActionLinks(ctx.actions, "actions", "action")}
  ${contactSection(ctx)}
</main>
<footer class="shikiishi"><div class="wrap">${footerHtml(ctx.isSample)}</div></footer>`;
}

export const NOREN: Skeleton = {
  key: "暖簾",
  industries: ["飲食店"],
  palettes: PALETTES,
  headings: HEADINGS,
  contactLabels: CONTACT_LABELS,
  headlines: HEADLINES,
  css: CSS,
  body,
};
