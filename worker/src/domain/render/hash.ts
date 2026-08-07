import type { SiteInput } from "../validate.ts";

/**
 * 安定ハッシュ。同じ入力なら毎回同じ番号を返す（作り直しても見た目が変わらない）。
 *
 * 罠を1つ潰してある。1本のFNV値を `h % 4`, `(h>>>8) % 3`, `(h>>>16) % 5` のように切り分けて使うと
 * 軸どうしが相関する（実店名20件で試したところ、骨格・配色・見出しが3組まるごと一致した）。
 * 軸ごとに別ソルトを混ぜ、murmur3のfinalizerを通してから剰余を取る。
 */
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    let code = character.codePointAt(0) as number;
    while (code > 0) {
      hash = Math.imul(hash ^ (code & 0xff), 0x01000193) >>> 0;
      code >>>= 8;
    }
  }
  return hash >>> 0;
}

/** murmur3のfinalizer。FNV-1aは上位ビットが偏るので、剰余の前に必ず通す。 */
function finalize(value: number): number {
  let hash = (value ^ (value >>> 16)) >>> 0;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * 同じ店名なら毎回同じ番号を返す（作り直しても見た目が変わらない）。
 * 軸ごとにソルトを変えるのは、骨格と配色が連動して「骨格が同じ店は配色も同じ」になるのを防ぐため。
 */
export function pickIndex(seed: string, axis: string, length: number): number {
  if (length <= 1) return 0;
  return finalize(fnv1a32(`${axis}:${seed}`)) % length;
}

/**
 * 骨格・配色・見出し型の抽選に使う種。住所も混ぜるのは、
 * 同じ屋号のチェーンが別の町にあるとき別の顔にするため。
 */
export const seedOf = (input: SiteInput): string => `${input.storeName}|${input.address ?? ""}`;
