# 申込情報データベース（D1）

申込フォーム（サイト生成・見本生成・独自ドメイン取得申込）で受け取った入力内容を、Cloudflare D1 の
`applications` テーブルに記録している。KV（`SITES`）は公開ページ本体とアクセス制御用の値しか持たないため、
「誰が何を申し込んだか」を一覧・検索・エクスポートする手段としてこちらを使う。

## 一覧の見方（いちばん簡単な方法）

**正式な使い方**は `Authorization: Bearer <鍵>` ヘッダーを付けてアクセスする（鍵は `~/.freehp-admin-key` の中身）。

```bash
curl -H "Authorization: Bearer $(cat ~/.freehp-admin-key)" \
  "https://free-hp-engine.ryoseiworld.workers.dev/api/admin/applications?format=csv" \
  -o applications.csv
```

- ダウンロードした `applications.csv` をダブルクリックすれば Excel か Numbers で開く（先頭にUTF-8のBOMを付けているので文字化けしない）。
- 直近分だけ見たいときは `&since=2026-08-01` のように日付を足す（その日の0時(UTC)以降だけに絞られる）。
- JSONで受け取りたいときは `&format=json` を付ける（プログラムから読むとき用）。
- 1回のリクエストで最新2,000件まで（created_at の新しい順）。
- D1保存に失敗し、あとで拾えるようKVへ退避された件数だけを見たいときは `&failed=1`（内容そのものは返らない。件数だけ）。

鍵は `~/.freehp-admin-key` に入っている。中身をコピーして使う。

```bash
cat ~/.freehp-admin-key
```

同じIPから短時間に何度も試すと（1時間に5回まで）一時的に弾かれる（鍵の総当たり対策。2026-08-18からD1ベースのカウンタに変更し、KVのget→putより並列試行に強くなった）。それ以上は待つしかない。

**旧方式（`?key=（鍵）` をブラウザのアドレスバーに直接入れる方式）は2026-09-17まで後方互換で動く。**
それ以降は `?key=` を付けても認証されなくなる（鍵不一致と同じ401になる。経路自体は隠さない）。
`?key=` を使うとレスポンスに `X-Deprecated-Auth: query` ヘッダーが付く（curlで `-i` を付ければ確認できる）。
アクセスログやブラウザ履歴に鍵が残るのが理由なので、ブックマーク等に `?key=...` を保存している場合は
上記のcurlコマンド（またはPostman等でヘッダーを付けられるツール）に切り替える。

## 鍵の場所

| 用途 | ファイル | 備考 |
|---|---|---|
| 管理用一覧・CSVエクスポートの鍵 | `~/.freehp-admin-key` | `wrangler secret put ADMIN_KEY` で本番に設定済み。chmod 600 |
| 見本生成・削除（`/api/sample`, `/api/sample/unpublish`）の合鍵 | `~/.freehp-batch-key` | 既存。今回のD1追加とは無関係 |

鍵を作り直したいとき（漏れた・ローテーションしたい）：

```bash
openssl rand -hex 24 > ~/.freehp-admin-key && chmod 600 ~/.freehp-admin-key
cd ~/dev/2026-08-03-free-hp-engine-isolated/worker
cat ~/.freehp-admin-key | npx wrangler secret put ADMIN_KEY
npx wrangler deploy
```

## 見本の安全策

`sampleSource=map` / `threads` の見本は、最上部の帯で「AIホームページ製作所が提案用に作った非公式・未承認の見本」であることと、`info@freehp.jp` の削除窓口を明示する。検索・共有時の誤認を減らすため、robots metaに加えて配信レスポンスへ `X-Robots-Tag: noindex, nofollow, noarchive` と `Referrer-Policy: no-referrer` を付ける。画像入力はJPEG・PNG・WebPのdata URIだけを許可し、外部URL画像は拒否する。

KVの自動失効は、接点のない地図由来（`map`）が14日、本人の要望投稿を起点とするThreads由来（`threads`）が90日。`site:`・`photo:`・`partner_site:`へ同じTTLを付け、ページ下部に表示する日数もこの値から生成する。申込フォーム経由の通常サイトにはTTLを付けない。

掲載停止の連絡を受けた場合は、見本生成と同じ合鍵で次を実行する。見本だけをKVから即時削除し、通常サイトなら403を返して残す。

```bash
curl -X POST \
  -H "content-type: application/json" \
  -H "x-batch-key: $(cat ~/.freehp-batch-key)" \
  --data '{"slug":"削除する見本のslug"}' \
  "https://free-hp-engine.ryoseiworld.workers.dev/api/sample/unpublish"
```

## テーブル定義

`migrations/0001_applications.sql`〜`0004_partner_key_hash.sql`。主な列:

- `kind`: `site`（申込フォームからの本番サイト生成）／ `sample`（営業用見本・mapは14日、threadsは90日で自動失効）／ `domain_request`（独自ドメイン取得申込）
- 店舗情報: `store_name` `business_type` `description` `catchcopy` `mood` `phone` `address` `hours` `menu_text` `reserve_url` `instagram` `line_official` `has_photo`
- 申込者: `owner_email` `owner_sub`（Googleログイン時のみ）
- 送信元: `ip_hash`（生IPは保存しない。SHA-256先頭16桁）`user_agent`
- `partner_key`: 過去データ参照用に列だけ残しているが、2026-08-18以降は常にNULL（下記参照）
- `partner_key_hash`: 紹介パートナーの鍵をSHA-256先頭16桁でハッシュ化したもの。2026-08-18以降はこちらに入る
  （生の鍵をCSV/管理画面にそのまま出すと、CSV流出が`/api/sample`の生成権限の流出に直結するため）
- `extra_json`: `domain_request` の追加情報（希望ドメイン・可用性・見積等）をJSON文字列で保持
- `status` / `note`: 今のところ既定値のまま（あとから手で更新する用の余地）

`slug`のUNIQUE制約は「全種別で一意」ではなく「同じ`kind`内でのみ一意」（`migrations/0002_slug_unique_per_kind.sql`）。
同じ店（同じslug）が site→domain_request の順で申し込んでも衝突しない。

`admin_attempts`テーブル（`migrations/0003_admin_attempts.sql`）は管理エンドポイントの鍵総当たり対策専用で、
`applications`とは別。`ip_hash`と`ts`（ミリ秒）だけを持ち、古い行を消す仕組みはまだ無い（増え続ける）。

## データの入り方

`src/index.ts` の `handleGenerate`（本番サイト生成）・`handleSample`（見本生成）・`handleDomainRequest`（ドメイン申込）が、
それぞれ成功したタイミングで `recordApplication()`（`src/domain/applications.ts`）を呼んでINSERTする。

**D1への書き込みが失敗しても、申込フォーム側の処理（サイト生成そのもの）は成功として扱う**（`try/catch` で握りつぶし、
`console.error` に残す）。D1が落ちていても訪問者には影響しない設計。ただし2026-08-18以降は、失敗した申込内容を
KV（`SITES`）へ `dbfail:<作成日時ISO>:<slug>` というキーで30日間退避するようになった（`recordApplication`の第3引数）。
`/api/admin/applications?failed=1`（Authorizationヘッダー付き）で退避件数だけを確認できる。件数以上の詳細（店名・連絡先等）
が必要なときは `wrangler kv key list --prefix dbfail: --remote` → `wrangler kv key get <キー> --remote` で個別に読み、
内容を確認したうえで手動で`applications`へ`INSERT`し直す（自動復旧の仕組みはまだ無い）。

## 既存データの取り込み（バックフィル）

2026-08-18時点で、KVの `owner:*`（Googleログインしたユーザーが作ったサイトの持ち主情報）を確認したところ **0件** だった。
KV全体442件の内訳は `site:436` `partner_site:2` `domreq:1` `partner:1` `partner_count:1` `ratelimit:1` で、`owner:` は無し。
つまり、これまでに作られた436件のサイトはすべてログインなし（Googleログイン必須化の前、または未ログインのまま）で作られており、
`applications` テーブルへ遡って取り込める「誰が作ったか」付きのデータは今のところ存在しない。

今後 `owner:*` が増えたときのために、取り込み手順だけ残しておく（実行スクリプトは未作成。0件だったため作らなかった）。

```bash
cd ~/dev/2026-08-03-free-hp-engine-isolated/worker
npx wrangler kv key list --namespace-id 7a182bd4d54d42f1a52eac274b2d4ce1 --remote --prefix owner: --config wrangler.toml
```
上記で1件でも出てきたら、各キーの値（`sub` `email` `storeName` `at`）を読み、
`INSERT OR IGNORE INTO applications (created_at, kind, slug, store_name, owner_email, owner_sub, status, note) VALUES (...)`
（`slug` は KVキー名 `owner:{slug}` から取り出す。`note = 'backfill from KV owner:'`）で `wrangler d1 execute freehp-applications --remote` に流す。

## 未実装（やっていないこと）

- 毎朝のメールに申込件数を載せる、のような定期通知は**まだ作っていない**。今は上記URLを都度開いて確認する運用。
- `status`（new/対応済み等）や `note` を管理画面から更新するUIは無い。今のところ `wrangler d1 execute` で直接SQLを打つ以外に更新手段は無い。
