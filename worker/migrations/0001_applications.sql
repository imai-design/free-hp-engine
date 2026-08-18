-- 申込フォーム（サイト生成・見本生成・ドメイン取得申込）で受け取った内容を一覧・検索・エクスポートできるようにするテーブル。
-- KV(SITES)は公開ページ本体とアクセス制御用の値しか持たないため、入力内容そのものを別途D1に残す。
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  -- 'site' = 申込フォームからの本番サイト生成 / 'sample' = 営業用見本(90日で自動失効) / 'domain_request' = 独自ドメイン取得申込
  kind TEXT NOT NULL CHECK (kind IN ('site', 'domain_request', 'sample')),
  slug TEXT,
  public_url TEXT,
  store_name TEXT,
  business_type TEXT,
  description TEXT,
  catchcopy TEXT,
  mood TEXT,
  phone TEXT,
  address TEXT,
  hours TEXT,
  menu_text TEXT,
  reserve_url TEXT,
  instagram TEXT,
  line_official TEXT,
  has_photo INTEGER NOT NULL DEFAULT 0,
  owner_email TEXT,
  owner_sub TEXT,
  -- 生のIPアドレスは保存しない。SHA-256の先頭16桁のみ(worker/src/domain/applications.ts の hashIp)。
  ip_hash TEXT,
  user_agent TEXT,
  partner_key TEXT,
  -- kind別の付随情報(domain_requestのdomains/availability/quote等)をJSON文字列で保持する予備列。
  extra_json TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_applications_created_at ON applications(created_at);
CREATE INDEX IF NOT EXISTS idx_applications_owner_email ON applications(owner_email);
-- SQLiteのUNIQUE indexはNULL同士を別物として扱うため、slugを持たないdomain_requestの行が複数あっても衝突しない。
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_slug ON applications(slug);
