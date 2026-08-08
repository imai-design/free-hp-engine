import assert from "node:assert/strict";
import test from "node:test";
import type { GeneratedContent } from "../src/generation/provider.ts";
import { renderSite } from "../src/domain/render.ts";
import { validateInput, type Industry } from "../src/domain/validate.ts";

const NEW_INDUSTRIES = [
  "教室・スクール",
  "小売・物販",
  "修理・住まいのサービス",
] as const satisfies readonly Industry[];

const baseInput = {
  storeName: "まちの仕事場",
  catchphrase: "一人ひとりに、丁寧に向き合います。",
  description: "地域の方に向けて、日々の仕事や活動について紹介しています。",
  colorTheme: "落ち着いた",
};

const content: GeneratedContent = {
  subheadline: "地域の方が安心して相談できる場所を目指しています。",
  aboutText: "まちの仕事場は、地域に根ざして活動しています。",
  highlights: ["一人ひとりに丁寧に対応します"],
  closingText: "お気軽にお立ち寄りください。",
};

for (const industry of NEW_INDUSTRIES) {
  test(`validate: 新業種「${industry}」を受け付ける`, () => {
    const validated = validateInput({ ...baseInput, industry });
    assert.equal(validated.industry, industry);
  });

  test(`render: 新業種「${industry}」をHTMLに表示する`, () => {
    const input = validateInput({ ...baseInput, industry });
    const html = renderSite(input, content);
    assert.match(html, new RegExp(`class="[^"]*industry"[^>]*>${industry}<`, "u"));
  });
}
