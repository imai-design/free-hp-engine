import type { ColorTheme, SiteInput } from "../validate.ts";
import { pickIndex, seedOf } from "./hash.ts";
import { MEISHI, SKELETONS } from "./skeletons/index.ts";
import type { Palette, Skeleton, SkeletonKey, Temperature } from "./types.ts";

const TEMPERATURE_OF: Record<ColorTheme, Temperature> = {
  あたたかい: "warm",
  落ち着いた: "calm",
  さわやか: "fresh",
  たのしい: "lively",
  しっとり: "moody",
};

/**
 * 骨格を決める。業種の対応表は全業種に最低2つ当たるように組んであるが、
 * 将来 industries を絞りすぎたときに落ちないよう、名刺（全業種型）を最後の受け皿にする。
 */
export function selectSkeleton(input: SiteInput, forced?: SkeletonKey): Skeleton {
  if (forced) {
    const found = SKELETONS.find((skeleton) => skeleton.key === forced);
    if (found) return found;
  }
  const eligible = SKELETONS.filter((skeleton) => skeleton.industries.includes(input.industry));
  if (eligible.length === 0) return MEISHI;
  return eligible[pickIndex(seedOf(input), "skeleton", eligible.length)];
}

/**
 * 配色を決める。見本ページ（options.sample）は店主が配色を選んでいないので、
 * input.colorTheme は営業側が機械的に入れた値でしかない。無視してハッシュで選ぶ。
 * 申込フォーム経由のときだけ、選ばれた温度の中から選ぶ。
 */
export function selectPalette(skeleton: Skeleton, input: SiteInput, isSample: boolean): Palette {
  const seed = seedOf(input);
  const wanted = TEMPERATURE_OF[input.colorTheme];
  const pool = isSample ? skeleton.palettes : skeleton.palettes.filter((palette) => palette.temp === wanted);
  const list = pool.length > 0 ? pool : skeleton.palettes;
  return list[pickIndex(seed, `palette:${skeleton.key}`, list.length)];
}
