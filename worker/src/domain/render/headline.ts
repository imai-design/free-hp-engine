import { pickIndex } from "./hash.ts";
import type { HeadlineParts, HeadlinePattern } from "./types.ts";

/**
 * h1を事実だけから決定的に組み立てる。AIには書かせない（DESIGN_SPEC.md §6-1）。
 * 各骨格のパターン表は「店名だけで書ける型」を必ず1つ含める決まりなので、通常ここは空にならない。
 */
export function buildHeadline(
  patterns: readonly HeadlinePattern[],
  parts: HeadlineParts,
  seed: string,
): string {
  const usable = patterns
    .map((pattern) => pattern(parts))
    .filter((line): line is string => line !== null && line.length > 0);
  if (usable.length === 0) return parts.store;
  return usable[pickIndex(seed, "headline", usable.length)];
}
