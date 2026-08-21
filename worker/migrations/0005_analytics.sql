-- 公開ページの閲覧状況を日単位・匿名のsid単位で記録する。
-- IPアドレスやUser-Agentそのものは保存せず、位置情報も約10km精度へ丸めた値だけを持つ。
CREATE TABLE IF NOT EXISTS visits (
  slug TEXT NOT NULL,
  sid TEXT NOT NULL,
  day TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  path TEXT NOT NULL,
  ref_host TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL CHECK (device IN ('mobile', 'pc')),
  country TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  lat REAL,
  lon REAL,
  region TEXT NOT NULL DEFAULT '',
  pv_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, sid, day)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  sid TEXT NOT NULL,
  day TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('tel', 'map')),
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_visits_slug_day ON visits(slug, day);
CREATE INDEX IF NOT EXISTS idx_visits_slug_last_seen ON visits(slug, last_seen);
CREATE INDEX IF NOT EXISTS idx_events_slug_day ON events(slug, day);
CREATE INDEX IF NOT EXISTS idx_events_slug_ts ON events(slug, ts);
