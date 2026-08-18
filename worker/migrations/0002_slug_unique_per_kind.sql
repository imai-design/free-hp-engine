-- slugの一意性を「全種別で一意」から「同じ種別(kind)内でのみ一意」に変更する。
-- 従来のUNIQUE(slug)だと、site作成後に同じ店(=同じslug)でdomain_requestを送ると、
-- 種別が違うにもかかわらずUNIQUE制約に衝突して必ずINSERTが失敗していた(recordApplicationは
-- 例外を握りつぶしてfalseを返すため、症状としては「申込がapplicationsテーブルから消える」形で出る)。
--
-- SQLiteのUNIQUE制約は列定義に埋め込まれた制約ではなくINDEXとして実装されているため
-- (0001_applications.sql の CREATE UNIQUE INDEX を参照)、テーブルの再作成・データコピーは不要で、
-- INDEXの差し替えだけで安全に移行できる。
DROP INDEX IF EXISTS idx_applications_slug;
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_kind_slug ON applications(kind, slug);
