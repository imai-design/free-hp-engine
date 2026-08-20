# freehp Threads自動営業 クラウド移行 SPEC

日付: 2026-08-19
依頼元: team-lead「Threads公式API仕様の調査→クラウド自動営業の設計書」

## 0. 最重要の発見（先に読む）

**このタスクで要求された設計は、すでに `~/dev/2026-08-17-freehp-cloud/` にほぼそのまま存在する。**
新規に `freehp-outreach` Workerを作ると、既存の `freehp-cloud` Workerと丸ごと重複する。

- `worker/src/threads/api.ts`（158行）に Threads Graph API クライアントが実装済み：
  `me()` `ownPosts()` `replies()` `conversation()` `mentions()` `keywordSearch()`
  `publishReply()`（2段階: `/me/threads` 作成 → `/me/threads_publish` 公開 → `verifyPublished()` で確認）
  `refresh()`（`/refresh_access_token?grant_type=th_refresh_token`）
- `worker/src/threads/loop.ts` `guard.ts` `applicant.ts` `state.ts` に、検索→判定→返信→相手の返信への対応（状態機械）が実装済み
- `worker/src/factory/engine.ts` が既存の `free-hp-engine` `/api/sample`（見本作成）を内部fetchする実装済み（今回の依頼の「見本作成」要件と同一）
- `worker/src/mail.ts` `report.ts` に朝夜報告・メール送信の抽象化が実装済み（今回の依頼の「日報」要件と同一）
- `worker/src/admin.ts` `board.ts` に管理API・状況ボードが実装済み
- **本人にやってもらう1回だけの作業の指示書もすでに存在する**: `~/Desktop/Threads鍵の取り方.html`（7スコープ＋Resend鍵取得の手順込み）
- テスト: `node --test tests/*.test.ts` で **25件中23件パス**（今回このセッションで実行して確認）。失敗2件は軽微（下記4章）
- git履歴: `39c9eaf feat: freehp-cloud Worker v1` → `17c34d2 chore: KV id` → `c164fa5 wip: レビュー修正の途中（Codexネットワーク断で中断）`。**デプロイはまだ一度もされていない**（`wrangler deploy` 未実行、KV namespace作成のみ済み）

つまり「設計」はすでに終わっており、必要なのは **仕上げ→デプロイ** であって、新しい設計書ではない。
以下、1〜3章は依頼どおりThreads公式API仕様の一次資料調査、4章で「既存freehp-cloudを完成させる」ための具体的な残作業、5章で依頼にあった要件と既存実装の対応表、6章で確認できなかった点を記す。

---

## 1. 認証（一次資料で確認できたこと）

出典: [Get Started](https://developers.facebook.com/documentation/threads/get-started) / [Get Access Tokens and Permissions](https://developers.facebook.com/documentation/threads/get-started/get-access-tokens-and-permissions)

- アプリ作成: Meta for Developers でアプリを作り「Threads use case」を選択する。これによりThreads用のapp ID・app secretが発行される（Facebook用アプリのIDとは別）
- **Authorization Window**: `https://threads.net/oauth/authorize`
  必須パラメータ: `client_id`, `redirect_uri`, `response_type=code`, `scope`
- **scope一覧**（確認できたもの）: `threads_basic`（必須）, `threads_content_publish`, `threads_read_replies`, `threads_manage_replies`, `threads_manage_insights`。加えて `threads_keyword_search`（keyword_searchページで別途明記、3章参照）
- 認可コード→短期アクセストークンの交換は「Exchange the Code For a Token」という手順名で存在（このページでは短期トークンの取得までしか書かれておらず、コード例は本セッションでは抽出できなかった。6章参照）
- Threadsテスター: 「Threads testers can grant your app these permissions at any time」＝**Threadsテスターとして自分のアカウントを登録すれば、App Review提出前でも自分自身のアカウントに対して権限を付与しテストできる**、という記述を確認。公開投稿への検索など一部機能はApp Review後でないと自分以外に及ばない（3章）
- 短期→長期トークン交換・長期トークンのrefreshは、`get-started`ページに「Short-lived tokens that have not expired can be exchanged for long-lived access tokens」「`GET /refresh_access_token`エンドポイントを照会する」という記述のみ確認でき、**具体的なURL・パラメータ・有効日数はこのセッションでは一次資料から特定できなかった**（6章に明記。既存実装 `refresh()` は `grant_type=th_refresh_token` を使っており、Instagram Graph APIの同種フロー・既存コードの実装時点(2026-08-17)の一次資料を踏まえたものと推定される）

## 2. 返信の投稿・取得（一次資料で確認できたこと／できなかったこと）

出典: [Reply Management](https://developers.facebook.com/documentation/threads/reply-management) / [Reference](https://developers.facebook.com/documentation/threads/reference)

- Reference ページはエンドポイントを9カテゴリに分類: Publishing / Media Retrieval / Reply Management / User / Locations / Location Search / Insights / oEmbed / Debug（詳細パラメータは各サブページ）
- Reply Management ページからは `reply_control`（`everyone` / `accounts_you_follow` 等、投稿時に誰が返信できるかを制御）と、返信の非表示・承認機能の記述を確認できたが、**`GET /{media-id}/replies` `GET /{media-id}/conversation` の fields一覧、`POST /threads` → `POST /threads_publish` に `reply_to_id` を渡す具体的な手順は、このセッションで参照したページからは抽出できなかった**（サブページ「Retrieve User Replies」への参照はあったが本文取得はできず）
- 既存実装 `worker/src/threads/api.ts` は次の形で実装済み（2026-08-17時点でCodexが一次資料を参照して書いたと推定されるもの。本仕様書の一次資料確認と矛盾しない）:
  - `GET /{media-id}/replies?fields=id,text,username,permalink,timestamp,is_reply_owned_by_me&reverse=true`
  - `GET /{media-id}/conversation?fields=（同上）`
  - `GET /me/mentions?fields=id,text,username,permalink,timestamp`（400エラー時は空配列にフォールバックする実装＝mentions未対応環境への配慮）
  - 返信投稿: `POST /me/threads?media_type=TEXT&text=...&reply_to_id=...` → `POST /me/threads_publish?creation_id=...` → `GET /{id}?fields=id,permalink,status` で公開確認

## 3. キーワード検索（一次資料で完全に確認できた）

出典: [Keyword Search](https://developers.facebook.com/documentation/threads/keyword-search)

- エンドポイント: `GET https://graph.threads.net/v1.0/keyword_search`
- 必須パラメータ: `q`（検索語）
- 任意パラメータ: `search_type`（`TOP`既定 / `RECENT`）、`search_mode`（`KEYWORD`既定 / `TAG`）、`media_type`（TEXT/IMAGE/VIDEO）、`since` `until`（Unixタイムスタンプ）、`limit`（既定25・最大100）、`author_username`、`fields`
- 必要パーミッション: `threads_basic` ＋ **`threads_keyword_search`**
- **`threads_keyword_search` 権限が無い場合は認証ユーザー自身の投稿しか検索できない。公開投稿の検索にはApp Review承認が必要**（重要: 開発モードのままでは他人の投稿を検索できない可能性が高い）
- レート制限: **「a maximum of 2,200 queries within a rolling 24-hour period」**（結果0件のクエリはカウントされない）
- レスポンスの代表的フィールド: `id, text, media_type, permalink, timestamp, username, has_replies, is_quote_post, is_reply`（`owner`フィールドは含まれない＝プライバシー配慮と思われる）

既存実装 `keywordSearch()` は `search_type=RECENT&fields=id,text,username,permalink,timestamp` で呼んでおり仕様と一致。ただし `env.ts` で `enable_keyword_search` の既定値が `false`（無効）になっている＝**App Review未承認のままでは公開検索が失敗するため、安全側でオフにしてある可能性が高い**。本人がApp Reviewを申請するか、自分自身の投稿検索の範囲に限定して使うかの判断が必要（5章のパンチリストに反映）。

## 4. レート制限・エラー形式（一次資料で確認できたこと）

出典: [Troubleshooting](https://developers.facebook.com/documentation/threads/troubleshooting)

24時間あたりの上限（`quota_total` / `quota_duration`秒 の形で記載）:

| 操作 | 上限/24h |
|---|---|
| 投稿（Publishing） | 250 |
| 返信（Reply） | 1,000 |
| 削除 | 100 |
| ロケーション検索 | 500 |
| キーワード検索（3章より） | 2,200 |

エラー形式: メディア公開系のコンテナエラーは `{"status": "ERROR", "id": ..., "error_message": ...}` の形（`FAILED_DOWNLOADING_VIDEO` 等の列挙が確認できた。テキスト投稿のみのfreehp用途では動画系エラーは基本発生しない）。一般的なGraph API呼び出しの標準エラー形式（`error.message/type/code/error_subcode/fbtrace_id`）はこのセッションの一次資料からは再確認できなかったが、既存実装のエラーハンドリング（`ThreadsApiError`：ステータス4xx/5xxで例外化、429/5xxは1回だけ2秒待ってリトライ）は妥当な設計。

`GET /me?fields=id,username`（自分のuser_id取得）は今回のセッションでは該当ページを特定できなかったが、Graph API全般の標準パターンであり既存実装と一致。

## 5. 依頼要件 と 既存 freehp-cloud 実装 の対応表

| team-leadが依頼した要素 | 既存 freehp-cloud での実装 | 状態 |
|---|---|---|
| Cloudflare Worker（Cron定期実行） | `wrangler.toml` に `crons = ["*/30 * * * *"]`、`time.ts` でJST tick判定（工場/朝報告/夜報告を時刻で分岐） | 実装済み |
| outreach_leads相当（検索結果の候補） | KV `leads:queue`（`id/username/text/permalink/timestamp/source/added_at`）＋ `leads:done:<id>` | 実装済み（D1ではなくKV。5.1参照） |
| outreach_replies_in相当（相手の返信） | `applicant:<username>` の `history[]`（`at, dir:'in'|'out', text, permalink`） | 実装済み |
| outreach_log相当 | `sent:<yyyy-mm-dd>`（送信台帳） + `heartbeat` / `heartbeat:log`（実行ログ） | 実装済み |
| 判定/分類/文面ロジックの移植 | `threads/guard.ts`（禁止語・文字数・URL・時間帯）+ `llm.ts`（Anthropic Messages APIでJSON強制）+ `prompts/policy.md` | **実装済みだが要更新**（5.2参照） |
| 見本作成（/api/sample内部fetch） | `factory/engine.ts`（BATCH_KEY・skeleton指定） | 実装済み |
| 送信の枠（1日3件・返信5件・自動停止） | `env.ts` の `OUTREACH_PER_TICK/PER_DAY/PER_HOUR` + `outreach:counters` + `config.paused` | 実装済み（数値は要合わせ。5.2参照） |
| 通知/日報（/report） | `report.ts`（朝夜3行報告）+ `board.ts`（`/board` `/api/stats`） | 実装済み |
| 本人の1回だけの作業（視覚指示書） | `~/Desktop/Threads鍵の取り方.html`（7スコープ＋Resend鍵取得） | **既に存在**（今回作る必要なし） |
| Mac側launchdジョブの退避 | HANDOFF.mdに手順あり（`freehp-samples`等を止める） | 手順のみ・未実施 |
| テスト方針（モック・node:sqlite不要） | `node --experimental-strip-types --test tests/*.test.ts`、fetch/KVはモック | 実装済み・23/25パス |

### 5.1 KV vs D1について
依頼では「D1テーブルで」という指定だったが、既存実装はKV中心（`STATE`バインディング1つ）。理由は推測だが、Threads側の状態（誰が既読か・送信済みか）は「キーで引く」用途が中心でJOINや集計SQLの必要が薄く、KVで十分という判断だったと考えられる。件数集計だけの日報なら現状のKVで足りる。**もしSQLでの横断分析（送信文言ごとの反応率など）を将来やりたいなら、既存の `freehp-applications` D1（`account_id: b99a46227dbadca74dcfb800fe7c8301`）に `outreach_events` テーブルを1つ追加し、Worker側で送信・受信のたびにINSERTする形で後乗せ可能**（D1書き込み失敗時は既存の`recordApplication`と同じ「握りつぶしてKVへ退避」のパターンを踏襲すればよい）。今は必須ではないと判断し、本SPECでは新規D1マイグレーションは提案しない（過剰実装を避ける）。

### 5.2 Mac側の直近チューニングとの差分（要同期）
`~/.threads-watch/hot_leads.py`（最終更新 2026-08-18 22:40）は、team-leadの実データレビューを経て**1文目固定3パターン・締めの文固定・禁止語リスト18語・見本URL付きテンプレ（GIFT_REPLY_TEMPLATE）**まで作り込まれている。一方 `freehp-cloud/prompts/policy.md`（最終更新 2026-08-17 19:24）は**1日古く**、この一連のチューニングを反映していない可能性が高い。デプロイ前に `hot_leads.py` の禁止語リスト・固定文・見本URLテンプレのロジックを `guard.ts` / `loop.ts` / `policy.md` に移植し直す必要がある。

## 6. 一次資料で確認できなかった点（推測のまま残る点）

1. **短期→長期トークン交換の正確なエンドポイントURL・パラメータ・長期トークンの有効日数**（`/access_token?grant_type=th_exchange_token&client_secret=...&access_token=...` という形を推定しているが、本セッションの一次資料からは再確認できていない）
2. **長期トークンrefreshの正確なパラメータと「発行から何時間後から更新可能か」**（既存実装は `grant_type=th_refresh_token` のみでaccess_tokenをクエリパラメータで渡す方式。60日有効・24時間経過後にrefresh可能、という数字は業界一般知識からの推定で、このセッションの一次資料では未確認）
3. **`/{media-id}/replies` `/{media-id}/conversation` の正式なfieldsパラメータ一覧と権限（threads_read_replies / threads_manage_replies の使い分け）**（既存実装のfields指定は妥当と考えられるが一次資料での再確認はできず）
4. **標準的なGraph APIエラーJSON形式**（`error.message/type/code`等）の当てはめ確認
5. **自分宛メンション取得の正式な仕様**（`/me/mentions`は既存実装に存在するが、公式ドキュメントの該当ページをこのセッションでは特定できなかった）

これらはWebSearchツールがセッション予算上限（本セッション内で他エージェントとの合算で200回到達）に達し、WebFetchでのURL推測に頼らざるを得なかったことが原因。再調査する場合は `developers.facebook.com/documentation/threads/` 配下を素のブラウザ（Playwright等）で辿るか、WebSearch予算リセット後に検索から正しいサブページURLを特定するのが早い。

## 7. 推奨する次のアクション（優先順）

1. `worker/tests/guard.test.ts` の禁止語テスト失敗（「円」が誤って禁止語判定されている）と `worker/tests/llm.test.ts` の期待値ズレ（`external_resource` vs `active_or_image_content`）を修正 → `npm test` 全緑
2. `npm install --ignore-scripts @cloudflare/puppeteer` を入れて `wrangler deploy --dry-run` を通す（HANDOFF.md記載の既知の未完了点）
3. 5.2の「Mac側の直近チューニング」を `policy.md` / `guard.ts` / `loop.ts` に移植
4. `enable_keyword_search` を有効化する前提条件（App Review要否の最終確認、または自分の投稿検索の範囲に限定する運用）を本人と確認
5. デプロイ（オーナーが逐次実行）: `ADMIN_KEY` `BATCH_KEY` `ANTHROPIC_API_KEY` をsecret設定 → `wrangler deploy`
6. 本人に `~/Desktop/Threads鍵の取り方.html` の手順（Threadsテスター登録・トークン取得・Resend鍵取得）を実施してもらう（既に指示書は存在するので新規作成不要。内容が今も正しいか一度目視確認だけ推奨）
7. `/admin/mail-test` `/admin/tick` で疎通確認 → 問題なければMac側launchd（`freehp-hotleads` `freehp-replywatch` `freehp-leadfinder` `freehp-autoreply`等）を `_disabled` へ退避し、watchdogのexclude登録も忘れず行う

新規Workerの作成、新規D1マイグレーション、新規の1回限り作業指示書は**いずれも不要**というのが本調査の結論。
