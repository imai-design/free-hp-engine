import { footerHtml, renderActionLinks, renderMenuItems, SAMPLE_NOTICE_HTML } from "../parts.ts";
import type { HeadlineParts, Palette, Skeleton, SkeletonContext } from "../types.ts";

/*
 * WCAG AA contrast ratios (sRGB, foreground/background).
 * Every pair below is used for text in this skeleton; all exceed 4.5:1.
 * (相対輝度から自分で再計算し、tests/skeleton.test.ts の8ペアと一致することを確認済み。)
 *
 * 表面（hero）で使う4ペア — .hero__headline=ink/night, .hero__lead=muted/night,
 * .kanban__name/.kanban__meta=sign-ink/sign, .tagline=accent-ink/accent:
 * 赤提灯: ink/night 15.90, muted/night 10.76, sign-ink/sign 9.35, accent-ink/accent 9.81.
 * 夜藍: ink/night 15.67, muted/night 9.97, sign-ink/sign 9.90, accent-ink/accent 10.16.
 * 深緑: ink/night 15.40, muted/night 10.57, sign-ink/sign 8.24, accent-ink/accent 10.13.
 * ネオン菫: ink/night 17.08, muted/night 11.19, sign-ink/sign 8.23, accent-ink/accent 11.29.
 * 黒葡萄: ink/night 16.16, muted/night 10.27, sign-ink/sign 11.18, accent-ink/accent 7.43.
 *
 * うら面（main/footer）で使う残り4ペア — panel本文=ink/surface, .contact-label等=muted/surface,
 * footer a=accent/night, .action・.menu__price=accent/surface（このスキルでは未変更）:
 * 赤提灯: ink/surface 13.85, muted/surface 9.37, accent/night 10.45, accent/surface 9.10.
 * 夜藍: ink/surface 13.19, muted/surface 8.40, accent/night 10.17, accent/surface 8.56.
 * 深緑: ink/surface 12.95, muted/surface 8.89, accent/night 10.01, accent/surface 8.42.
 * ネオン菫: ink/surface 15.00, muted/surface 9.83, accent/night 11.65, accent/surface 10.23.
 * 黒葡萄: ink/surface 14.80, muted/surface 9.40, accent/night 7.79, accent/surface 7.13.
 */
const PALETTES: readonly Palette[] = [
  {
    key: "赤提灯",
    temp: "warm",
    mark: "#781F12",
    vars: {
      night: "#160E0A",
      surface: "#2A1B13",
      ink: "#F7E9CF",
      muted: "#D7BFA0",
      sign: "#781F12",
      "sign-ink": "#FFF2C2",
      accent: "#F2B632",
      "accent-ink": "#251305",
    },
  },
  {
    key: "夜藍",
    temp: "calm",
    mark: "#123E61",
    vars: {
      night: "#0B111B",
      surface: "#172236",
      ink: "#F3E9D2",
      muted: "#C7BBA4",
      sign: "#123E61",
      "sign-ink": "#FFF1C9",
      accent: "#E5B84A",
      "accent-ink": "#161006",
    },
  },
  {
    key: "深緑",
    temp: "fresh",
    mark: "#14523B",
    vars: {
      night: "#0C1510",
      surface: "#17271D",
      ink: "#F0EAD2",
      muted: "#C6C5A8",
      sign: "#14523B",
      "sign-ink": "#FFF3CC",
      accent: "#E3B94F",
      "accent-ink": "#161106",
    },
  },
  {
    key: "ネオン菫",
    temp: "lively",
    mark: "#6B1FA2",
    vars: {
      night: "#0C1024",
      surface: "#171C3D",
      ink: "#FFF3D6",
      muted: "#D2C6B4",
      sign: "#6B1FA2",
      "sign-ink": "#FFF5D6",
      accent: "#F4C63D",
      "accent-ink": "#1C1404",
    },
  },
  {
    key: "黒葡萄",
    temp: "moody",
    mark: "#4B2038",
    vars: {
      night: "#090A0E",
      surface: "#17151B",
      ink: "#EFE7DE",
      muted: "#C5B8B5",
      sign: "#4B2038",
      "sign-ink": "#F7E8D7",
      accent: "#C89B52",
      "accent-ink": "#171006",
    },
  },
];

const HEADINGS = { about: "うちの話", highlights: "大事にしていること", closing: "お越しの前に" };
const CONTACT_LABELS = { phone: "電話", address: "場所", hours: "営業時間" };

// 太く短い口上に揃え、看板の店名を主役にしたまま事実だけを伝える。
const HEADLINES: readonly ((parts: HeadlineParts) => string | null)[] = [
  (p) => (p.area && p.word ? `${p.area}の${p.word}、${p.store}。` : null),
  (p) => (p.area && p.word ? `${p.store}。${p.area}で営む${p.word}です。` : null),
  (p) => (p.area ? `${p.store}は、${p.area}にあります。` : null),
  (p) => (p.word ? `${p.word}の${p.store}です。` : null),
  (p) => `その名は、${p.store}。`,
];

const CSS = `
:root{
  --gothic:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","YuGothic","Noto Sans JP",Meiryo,sans-serif;
}
*{box-sizing:border-box}
html{overflow-x:clip;background:var(--night)}
body{margin:0;background:var(--night);color:var(--ink);font-family:var(--gothic);font-size:16px;
  font-weight:600;line-height:1.85;background-image:repeating-linear-gradient(90deg,rgb(255 255 255/.018) 0 1px,transparent 1px 42px)}
.wrap{width:min(100%,760px);margin:0 auto;padding-inline:22px}

.hero{position:relative;overflow:hidden;background:var(--night);
  padding:clamp(28px,7vw,54px) 0 clamp(26px,6vw,42px);
  border-bottom:8px solid var(--accent)}
.hero::before,.hero::after{content:"";position:absolute;z-index:0;width:180px;height:180px;border-radius:50%;
  border:18px solid var(--accent);opacity:.06;filter:blur(2px)}
.hero::before{left:-110px;top:-96px}
.hero::after{right:-120px;bottom:-116px}
.hero__inner{position:relative;z-index:1}
.kanban{position:relative;margin:0 auto;padding:clamp(22px,6vw,42px) clamp(18px,5vw,38px) clamp(20px,5.5vw,34px);
  background:var(--sign);border:clamp(5px,1.5vw,10px) solid var(--accent);
  box-shadow:0 0 0 4px var(--sign),0 18px 0 rgb(0 0 0/.22),0 28px 52px rgb(0 0 0/.42);
  transform:rotate(-.28deg)}
.kanban::before,.kanban::after{content:"";position:absolute;top:12px;width:10px;height:10px;
  border-radius:50%;background:var(--accent);box-shadow:inset 0 2px 2px rgb(255 255 255/.22),0 2px 2px rgb(0 0 0/.35)}
.kanban::before{left:12px}.kanban::after{right:12px}
.kanban__meta{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px 12px;
  margin:0 0 clamp(14px,4vw,24px);color:var(--sign-ink);font-size:.76rem;font-weight:800;
  letter-spacing:.16em;text-align:center}
.kanban__divider{color:var(--sign-ink)}
/*
 * 店名の長さでフォントサイズを頭打ちにする。--name-max は看板専用の文字数連動サイズ
 * （parts.ts nameMaxRemOf）で、render.ts が全骨格の:rootに必ず注入している。
 * 他骨格（短冊の縦組み・暖簾の染め抜き）が使う --dye-max（parts.ts dyedTextOf）は
 * 「5文字を超えたら頭文字1文字に切り詰める」設計のため、店名をまるごと表示する看板に
 * 流用すると6文字以上の屋号が一律「1文字」扱いになり非単調（Issue #4）になっていた。
 * 最小値1.6remはnameMaxRemの取りうる下限（DEFAULT_DYE_MAX_REM）に合わせ、
 * clampのmin>maxで頭打ちが無効化されないようにしてある。
 * word-break:keep-allで「炭火食堂 まっすぐ」のような分かち書きの店名を単語の途中で折り返さず、
 * スペースでだけ改行する（それでも収まらない場合だけoverflow-wrap:break-wordが強制的に折る）。
 */
.kanban__name{margin:0;color:var(--sign-ink);font-size:clamp(1.6rem,13vw,var(--name-max));font-weight:900;
  line-height:.98;letter-spacing:-.055em;text-align:center;word-break:keep-all;overflow-wrap:break-word;
  text-shadow:0 4px 0 rgb(0 0 0/.22),0 8px 18px rgb(0 0 0/.24)}
.tagline{position:relative;width:fit-content;max-width:calc(100% - 14px);margin:clamp(18px,5vw,30px) auto -4px;
  padding:8px 24px;background:var(--accent);color:var(--accent-ink);font-size:clamp(.82rem,3.5vw,1rem);
  font-weight:900;letter-spacing:.06em;text-align:center;line-height:1.65;
  clip-path:polygon(10px 0,100% 0,calc(100% - 10px) 100%,0 100%);transform:rotate(.65deg)}
.hero__headline{margin:clamp(18px,4.5vw,28px) 0 0;color:var(--ink);font-size:clamp(1.35rem,5.6vw,2.6rem);
  font-weight:900;line-height:1.35;letter-spacing:.02em;text-align:center;word-break:auto-phrase;line-break:strict}
.hero__lead{max-width:620px;margin:12px auto 0;color:var(--muted);font-size:.94rem;font-weight:600;
  text-align:center;line-break:strict}

main{padding-block:clamp(30px,8vw,58px) 10px}
.sample-notice{margin:0 0 clamp(26px,7vw,40px);padding:15px 17px;background:var(--surface);color:var(--ink);
  border:2px solid var(--accent);font-size:.8rem;font-weight:600;line-height:1.85}
.photo{width:100%;max-width:var(--photo-max);aspect-ratio:var(--photo-aspect);margin:0 auto clamp(32px,8vw,50px);
  overflow:hidden;background:var(--surface);border:5px solid var(--accent);box-shadow:10px 10px 0 var(--sign)}
.photo img{display:block;width:100%;height:100%;object-fit:cover}
.panel{position:relative;margin:0 0 clamp(24px,6vw,36px);padding:clamp(30px,7vw,42px) clamp(18px,5vw,30px) 24px;
  background:var(--surface);border:3px solid var(--sign);box-shadow:7px 7px 0 var(--sign)}
.panel h2{display:inline-block;margin:-50px 0 22px -8px;padding:8px 18px;background:var(--sign);color:var(--sign-ink);
  border:3px solid var(--accent);font-size:clamp(1.05rem,4.6vw,1.32rem);font-weight:900;line-height:1.45;
  letter-spacing:.08em;box-shadow:4px 4px 0 var(--accent)}
p{margin:0 0 1em}
.panel p:last-child{margin-bottom:0}
ul{list-style:none;margin:0;padding:0}
li{position:relative;margin:0 0 13px;padding-left:22px;color:var(--ink)}
li:last-child{margin-bottom:0}
li::before{content:"";position:absolute;left:0;top:.68em;width:11px;height:11px;background:var(--accent);transform:rotate(45deg)}
.menu__item{display:flex;align-items:baseline;gap:14px;padding-block:8px;border-bottom:2px solid var(--accent)}
.menu__item:last-child{border-bottom:0}
.menu__item::before{top:1.35em}
.menu__name{min-width:0;overflow-wrap:anywhere}
.menu__price{flex:none;margin-left:auto;white-space:nowrap;color:var(--accent);font-variant-numeric:tabular-nums;font-weight:900}

.actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:22px 0 0}
.action{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:8px 16px;
  border:3px solid var(--accent);color:var(--accent);font-size:.88rem;font-weight:900;line-height:1.4;
  text-align:center;text-decoration:none}
.action--reserve{background:var(--accent);color:var(--accent-ink)}
.contact{padding-bottom:16px}
.contact-row{display:flex;gap:14px;align-items:flex-start;min-height:48px;margin:0;padding:10px 0;
  border-bottom:1px solid var(--accent)}
.contact-row:last-child{border-bottom:0}
.contact-label{flex:none;width:5em;color:var(--muted);font-size:.74rem;font-weight:900;letter-spacing:.08em}
.contact-value{flex:1;min-width:0;color:var(--ink);overflow-wrap:anywhere}
.contact-row a{display:inline-flex;align-items:center;min-height:44px;color:var(--ink);text-decoration:underline;
  text-decoration-thickness:2px;text-underline-offset:4px}
.contact-row--phone{align-items:center;margin:0 0 8px;padding:5px 14px;background:var(--accent);border-bottom:0}
.contact-row--phone .contact-label,.contact-row--phone .contact-value,.contact-row--phone a{color:var(--accent-ink)}
.contact-row--phone a{font-size:1.08rem;font-weight:900}

footer{margin-top:clamp(38px,9vw,64px);padding:26px 0 32px;border-top:8px solid var(--accent);
  color:var(--muted);font-size:.74rem;font-weight:600;line-height:1.9}
footer a{color:var(--accent);font-weight:900}
@media (max-width:480px){
  .kanban{box-shadow:0 0 0 3px var(--sign),0 12px 0 rgb(0 0 0/.22),0 22px 36px rgb(0 0 0/.38)}
  .panel{box-shadow:5px 5px 0 var(--sign)}
  .contact-row:not(.contact-row--phone){display:block}
  .contact-label{display:block;width:auto;margin-bottom:2px}
}
`;

function metaLine(ctx: SkeletonContext): string {
  const industry = ctx.word ? `<span class="industry">${ctx.word}</span>` : "";
  const area = ctx.areaFull ? `<span>${ctx.areaFull}</span>` : "";
  if (!industry && !area) return "";
  const divider = industry && area ? `<span class="kanban__divider" aria-hidden="true">／</span>` : "";
  return `<p class="kanban__meta">${industry}${divider}${area}</p>`;
}

function contactSection(ctx: SkeletonContext): string {
  if (!ctx.contactRows.length) return "";
  const rows = ctx.contactRows
    .map((row) => {
      const phoneClass = row.kind === "phone" ? " contact-row--phone" : "";
      return `<p class="contact-row${phoneClass}"><span class="contact-label">${CONTACT_LABELS[row.kind]}</span><span class="contact-value">${row.valueHtml}</span></p>`;
    })
    .join("");
  return `<section class="panel contact"><h2>店の案内</h2>${rows}</section>`;
}

function body(ctx: SkeletonContext): string {
  const tagline = ctx.tagline ? `<p class="tagline">${ctx.tagline}</p>` : "";
  const lead = ctx.lead ? `<p class="hero__lead">${ctx.lead}</p>` : "";
  const sampleNotice = ctx.isSample ? `<p class="sample-notice">${SAMPLE_NOTICE_HTML}</p>` : "";
  const photo = ctx.photo
    ? `<figure class="photo"><img src="${ctx.photo.srcHtml}" alt="${ctx.photo.altHtml}" loading="eager" decoding="async"></figure>`
    : "";
  const highlights = ctx.highlights.length
    ? `<section class="panel"><h2>${HEADINGS.highlights}</h2><ul>${ctx.highlights.map((item) => `<li>${item}</li>`).join("")}</ul></section>`
    : "";
  const menu = ctx.menuItems.length
    ? `<section class="panel menu"><h2>品書き・価格</h2><ul class="menu__list">${renderMenuItems(ctx.menuItems)}</ul></section>`
    : "";

  return `<header class="hero">
  <div class="wrap hero__inner">
    <div class="kanban">
      ${metaLine(ctx)}
      <h1 class="kanban__name">${ctx.storeName}</h1>
      ${tagline}
    </div>
    <p class="hero__headline">${ctx.headline}</p>
    ${lead}
  </div>
</header>
<main class="wrap">
  ${sampleNotice}
  ${photo}
  <section class="panel"><h2>${HEADINGS.about}</h2><p>${ctx.about}</p></section>
  ${highlights}
  ${menu}
  <section class="panel"><h2>${HEADINGS.closing}</h2><p>${ctx.closing}</p>${renderActionLinks(ctx.actions, "actions", "action")}</section>
  ${contactSection(ctx)}
</main>
<footer><div class="wrap">${footerHtml(ctx.isSample)}</div></footer>`;
}

export const KANBAN: Skeleton = {
  key: "看板",
  industries: ["飲食店", "小売・物販", "その他"],
  palettes: PALETTES,
  headings: HEADINGS,
  contactLabels: CONTACT_LABELS,
  headlines: HEADLINES,
  css: CSS,
  body,
};
