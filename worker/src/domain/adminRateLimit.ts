import type { D1Database } from "./applications.ts";
import { RateLimitError } from "./rateLimit.ts";

/**
 * 管理用一覧・CSVエクスポート(/api/admin/applications)専用のレート制限。
 *
 * src/domain/rateLimit.ts はKVの get→put で数えており、2回のネットワーク往復の間に
 * 並列リクエストが割り込めるため非原子的（ローカル再現で上限5に対し20並列が全て通過した）。
 * 管理鍵は全個人情報へアクセスできる強い権限なので、ここだけはD1へ1行INSERTしてから
 * 同じウィンドウ内の行数をCOUNTする方式にする。同一D1インスタンスへの書き込みはSQLiteの
 * ロックにより逐次化されるため、KV版よりも実際の上限に近い挙動になる
 * （それでも「INSERTしてからCOUNTする」2ステップである以上、ミリ秒未満の完全な原子性は保証しない）。
 */

export const ADMIN_RATE_LIMIT = 5;
export const ADMIN_RATE_WINDOW_SECONDS = 60 * 60;

const INSERT_SQL = `INSERT INTO admin_attempts (ip_hash, ts) VALUES (?, ?)`;
const COUNT_SQL = `SELECT COUNT(*) as count FROM admin_attempts WHERE ip_hash = ? AND ts >= ?`;

/**
 * 1回の試行を記録し、直近 ADMIN_RATE_WINDOW_SECONDS 以内の試行回数が上限を超えていれば
 * RateLimitError を投げる。呼び出し側は鍵チェックより前に呼ぶ（不正な鍵でも予算を消費させるため）。
 */
export async function enforceAdminRateLimit(db: D1Database, ipHash: string, now = Date.now()): Promise<void> {
  const windowStartMs = now - ADMIN_RATE_WINDOW_SECONDS * 1000;
  await db.prepare(INSERT_SQL).bind(ipHash, now).run();
  const { results } = await db.prepare(COUNT_SQL).bind(ipHash, windowStartMs).all<{ count: number }>();
  const count = Number(results[0]?.count ?? 0);
  if (count > ADMIN_RATE_LIMIT) {
    throw new RateLimitError(ADMIN_RATE_WINDOW_SECONDS);
  }
}
