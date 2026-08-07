import type { Skeleton } from "../types.ts";
import { HOGAN } from "./hogan.ts";
import { MEISHI } from "./meishi.ts";
import { NOREN } from "./noren.ts";
import { TANZAKU } from "./tanzaku.ts";

export const SKELETONS: readonly Skeleton[] = [MEISHI, NOREN, TANZAKU, HOGAN];
export { HOGAN, MEISHI, NOREN, TANZAKU };
