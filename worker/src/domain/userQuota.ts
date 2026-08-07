/**
 * 1人あたり1日いくつ作れるかの管理。
 *
 * 生成に使っているWorkers AIの無料枠は1日10,000ニューロン＝実測で約175件。
 * 2026-08-05に営業用のまとめ生成でこれを1日で使い切り、その間は
 * 申込フォームから来た人も作れない状態になった。全体の枠は1つしかないので、
 * 1人がいくら使えるかを決めておかないと、先に来た誰かが全部を持っていく。
 */

export interface QuotaStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** 1人が1日に作れる数。試して気に入らなければ作り直す余地は残しつつ、枠を独占させない値。 */
export const DAILY_SITES_PER_USER = 3;
const DAY_SECONDS = 60 * 60 * 24;

export class UserQuotaError extends Error {
  public readonly resetAtIso: string;

  constructor(resetAtIso: string) {
    super("daily site limit reached");
    this.name = "UserQuotaError";
    this.resetAtIso = resetAtIso;
  }
}

/** 日付の区切りは日本時間の午前0時。利用者の感覚と合わせるため（UTCだと朝9時に変わる）。 */
export function tokyoDateKey(now: number): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function nextTokyoMidnightIso(now: number): number {
  const shifted = now + 9 * 60 * 60 * 1000;
  const startOfDay = Math.floor(shifted / (DAY_SECONDS * 1000)) * DAY_SECONDS * 1000;
  return startOfDay + DAY_SECONDS * 1000 - 9 * 60 * 60 * 1000;
}

/**
 * 1件ぶん使う。上限に達していれば UserQuotaError を投げる。
 * 数え上げは厳密でなくてよい（同時アクセスで1〜2件多く通ることは許容する）。
 * ここで守りたいのは「1人が175件を全部使う」ような桁の暴走であって、1件の誤差ではない。
 */
export async function consumeDailyQuota(
  store: QuotaStore,
  userId: string,
  now: number,
  limit: number = DAILY_SITES_PER_USER,
): Promise<{ used: number; remaining: number }> {
  const key = `uquota:${userId}:${tokyoDateKey(now)}`;
  const current = Number((await store.get(key)) ?? "0");
  const used = Number.isFinite(current) ? current : 0;
  if (used >= limit) {
    throw new UserQuotaError(new Date(nextTokyoMidnightIso(now)).toISOString());
  }
  await store.put(key, String(used + 1), { expirationTtl: DAY_SECONDS + 3600 });
  return { used: used + 1, remaining: Math.max(0, limit - used - 1) };
}

/**
 * Workers AIの無料枠が次に戻る時刻（UTCの0時＝日本時間の朝9時）。
 * 「朝9時ごろ」とだけ伝えると今朝のことだと読まれるので、あと何時間かを添えて返す。
 */
export function nextAiQuotaReset(now: number): { hoursLeft: number; label: string } {
  const DAY = 24 * 60 * 60 * 1000;
  const resetAt = Math.floor(now / DAY) * DAY + DAY;
  const hoursLeft = Math.max(1, Math.ceil((resetAt - now) / (60 * 60 * 1000)));
  // 日本時間で何日の朝9時かを言い切る
  const tokyo = new Date(resetAt + 9 * 60 * 60 * 1000);
  const label = `${tokyo.getUTCMonth() + 1}月${tokyo.getUTCDate()}日の朝9時ごろ`;
  return { hoursLeft, label };
}
