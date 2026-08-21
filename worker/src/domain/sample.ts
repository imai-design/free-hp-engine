import type { SampleSource } from "./validate.ts";

const SECONDS_PER_DAY = 60 * 60 * 24;

const SAMPLE_TTL_DAYS: Readonly<Record<SampleSource, number>> = {
  map: 14,
  threads: 90,
  // 撮影後すぐunpublishする運用のためTTLの長さ自体に意味は薄いが、mapと揃えておく。
  anonymous: 14,
};

/** 承諾前の見本を自動で非公開にするまでの秒数。元ネタとの接点の有無で期限を変える。 */
export function sampleTtlSeconds(source: SampleSource): number {
  return SAMPLE_TTL_DAYS[source] * SECONDS_PER_DAY;
}

/** 表示文言もKVの実TTLと必ず同じ値になるよう、秒数から日数へ戻す。 */
export function sampleTtlDays(source: SampleSource): number {
  return sampleTtlSeconds(source) / SECONDS_PER_DAY;
}
