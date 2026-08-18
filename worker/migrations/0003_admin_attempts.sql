-- 管理用一覧・CSVエクスポート(/api/admin/applications)の鍵総当たり対策を、
-- KVのget→put(非原子的。並列リクエストで上限をすり抜けられる)から、
-- D1のINSERT→COUNT(同一D1インスタンス内の書き込みはSQLiteのロックで逐次化される)へ強化する。
-- 他のAPI(生成・ドメイン申込等)のレート制限は既存のKVベースのまま(src/domain/rateLimit.ts)。
--
-- 意図的簡略化: 古い試行行を削除する仕組みはここには無く、このテーブルは増え続ける。
-- 本格的に直すなら、Durable Object等の専用カウンタへ移行するか、定期的な削除バッチ(created created_at < now-1日 のDELETE)を足す入口。
CREATE TABLE IF NOT EXISTS admin_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_attempts_ip_ts ON admin_attempts(ip_hash, ts);
