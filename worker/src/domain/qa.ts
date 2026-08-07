import type { GeneratedContent } from "../generation/provider.ts";
import type { SiteInput } from "./validate.ts";

export interface QaResult {
  ok: boolean;
  reason?: string;
}

const PLACEHOLDER_PATTERN = /\{\{|\}\}|\[insert|\[ここ|ここに.{0,8}(入|書)|lorem ipsum|undefined|null/iu;
const PROMPT_LEAK_PATTERN = /system prompt|ignore (all|previous)|api key|script\s*>/iu;

export function qaContent(content: GeneratedContent, input: SiteInput): QaResult {
  const required = [content.subheadline, content.aboutText, content.closingText];
  if (required.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    return { ok: false, reason: "required generated field is empty" };
  }
  // 下限を見ていなかったので、空配列がそのまま通って「大切にしていること」が中身ゼロの箱として出荷されていた。
  if (
    !Array.isArray(content.highlights) ||
    content.highlights.length < 1 ||
    content.highlights.length > 3 ||
    content.highlights.some((value) => typeof value !== "string" || !value.trim())
  ) {
    return { ok: false, reason: "highlights has an invalid shape" };
  }
  const combined = [...required, ...content.highlights].join("\n");
  if (PLACEHOLDER_PATTERN.test(combined)) return { ok: false, reason: "placeholder text remained" };
  if (PROMPT_LEAK_PATTERN.test(combined)) return { ok: false, reason: "prompt or unsafe text remained" };
  if (![input.storeName, input.industry, input.catchphrase].some((needle) => combined.includes(needle))) {
    return { ok: false, reason: "generated content is not related to the submitted business" };
  }
  if (combined.length > 6000) return { ok: false, reason: "generated content is too long" };
  return { ok: true };
}
