# free-hp-engine（AIホームページ製作所（RYOSEIWORLD）・エンジン）

**English summary:** free-hp-engine is a Cloudflare Worker that generates a one-page website for a small business from just three inputs (store name, industry, one-line description) in about 10 seconds. It runs on Cloudflare Workers + Workers AI (free tier, no API key required by default), keeping generation cost near zero. It is licensed under AGPL-3.0. This is a Japanese-first project, but contributions (new design skeletons, industries, translations, etc.) are welcome — see the Japanese README below and [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

3つの入力（店名・業種・ひとこと紹介）から、約10秒でホームページを1枚生成する Cloudflare Worker です。
[freehp.jp](https://freehp.jp) で本番稼働しています。生成されたページは `https://free-hp-engine.ryoseiworld.workers.dev/s/<slug>` のようなURLでそのまま公開されます。

対応業種は、飲食店、美容・サロン、教室・スクール、小売・物販、修理・住まいのサービス、士業・専門サービス、不動産・建設、医療・クリニック、その他です。

## 思想

RYOSEIWORLD のミッションは「ITを全て無料にする」ことです。ホームページはその第一弾です。

サーバー費・生成費が実質0円（Cloudflareの無料枠だけ）で回る設計にしてあるので、このリポジトリをフォークして自分のCloudflareアカウントにデプロイすれば、誰でも自分の町のために「無料ホームページ屋さん」を始められます。売上を取る必要がないので、無料のまま人に配れます。

## 特徴

- **5つの骨格（デザインテンプレート）を店名のハッシュから決定的に出し分け** — 名刺・暖簾・短冊・方眼・看板の5型（`worker/src/domain/render/skeletons/`）。同じ店名・住所なら何度作っても同じ骨格・配色になり、チェーン店が近い場所で作り直しても同じ見た目に寄る対策も入っています。
- **見出しは事実から決定的に生成** — AIに書かせるのは紹介文の一部だけで、見出し（headline）は入力された事実（店名・地域・業種語）から機械的に組み立てます。「無い事実は作らない」を設計の柱にしています。
- **WCAG AA準拠** — 全骨格・全配色の組み合わせで、本文色・補助色・見出し色のコントラスト比 4.5:1 を自動テストで担保しています。
- **テスト109件** — `node --test`（Node標準のテストランナー）でユニットテストを実行します。決定論性・XSS対策（骨格側はエスケープ済み文字列しか受け取らない設計）・入力検証・コントラスト比などをカバーしています。
- **APIキー不要でも動く** — `ANTHROPIC_API_KEY` を設定しなければ、自動的に Cloudflare Workers AI（無料枠・キー不要）にフォールバックします。

## 動かし方（ローカル）

```bash
cd worker
npm install
cp wrangler.toml.example wrangler.toml
```

`wrangler.toml` を開いて、自分のCloudflareアカウントの値に書き換えます。

```bash
# KV namespace を作成し、出てきた id を wrangler.toml の [[kv_namespaces]] id に入れる
npx wrangler kv namespace create SITES
```

`account_id` は Cloudflareダッシュボードのサイドバーで確認できます。`GOOGLE_CLIENT_ID` は未設定のままで構いません（設定した瞬間にGoogleログイン必須の登録制に切り替わる作りです）。

```bash
npm run dev    # ローカルで起動（wrangler dev）
npm test       # テスト実行（109件）
npm run check  # 型チェック（tsc --noEmit）
```

生成AIを使う場合、`ANTHROPIC_API_KEY` を使わないのであれば追加の秘密鍵は不要です（`[ai]` binding が無料のWorkers AIを使います）。Anthropic APIを使いたい場合のみ、コミットせずに以下で登録してください。

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

## デプロイ

```bash
cd worker
npx wrangler deploy
```

フロントエンド（入力フォーム）は同じリポジトリには含まれていません。ルート直下の `create.html` を自分のWorkerのURLに向けて配信するか、[free-hp-site](https://github.com/Ryoseiimai/free-hp-site) を参考にしてください。

## 無料枠の実測上限

Cloudflare Workers AIの無料枠は1日10,000ニューロンです。この生成処理1回あたりの消費量から実測すると、**約175件/日**が上限です（`worker/src/domain/userQuota.ts` にコメントで根拠を記載しています）。それを超えて使いたい場合は、`ANTHROPIC_API_KEY` を設定してAnthropic API側に流すか、翌日（JST基準）まで待つ必要があります。「無料で無制限」ではなく「実測でここまでは無料」と正直に書いておきます。

## なぜAGPL-3.0か

このエンジンをそのままフォークして、中身を隠したまま有料SaaSとして再配布することは、「ITを全て無料にする」という活動の趣旨と矛盾します。AGPL-3.0は、改変したコードをサーバーとして人に使わせた場合にも、その改変ソースの公開を義務づけるライセンスです。

- 商用利用そのものは禁止していません。フォークして自分の町の骨格を追加し、ホスティング業として収益を得ることも自由です。
- 禁止しているのは「改変版を人に使わせながら、その改変ソースだけを非公開にすること」です。

詳細は [LICENSE](./LICENSE) を参照してください。フロントエンド（[free-hp-site](https://github.com/Ryoseiimai/free-hp-site)）は MIT ライセンスです。

## 骨格（デザイン）を追加したい

一番歓迎したい貢献です。手順は [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

## 作った人

[今井涼晴](https://x.com/ryoseichan3160) / RYOSEIWORLD
