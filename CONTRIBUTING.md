# Contributing

一番歓迎する貢献は「**デザイン骨格（あなたの町の型）の追加**」です。このエンジンは、店名から決定的に骨格・配色を選んで1枚のHPを作ります。今は名刺・暖簾・短冊・方眼の4型しかありませんが、あなたの地域・業種らしい型を増やせます。

## 掟（PRを出す前に必ず守ること）

1. **嘘を生成しない** — 入力にない事実（価格・実績・資格・営業時間など）をAIにも骨格にも作らせないこと。無い事実は「無い」まま出す（住所の都道府県が取れない、地域を書かない等）。
2. **WCAG AA（コントラスト比 4.5:1）** — 骨格が持つ全パレット × 全表示面（本文/補助/見出しの色 × 背景色）の組み合わせで基準を満たすこと。
3. **CSP内で完結する** — 外部フォント・外部画像・インラインscriptなど、Content-Security-Policyを緩める変更をしないこと。
4. **PR前に `npm test` と `npm run check`（tsc --noEmit）が両方green** であること。

## 骨格を追加する手順

1. **`worker/src/domain/render/types.ts`** の `Skeleton` インターフェースを確認する。

   ```typescript
   export interface Skeleton {
     readonly key: SkeletonKey;
     readonly industries: readonly Industry[];
     readonly palettes: readonly Palette[];
     readonly headings: { readonly about: string; readonly highlights: string; readonly closing: string };
     readonly contactLabels: { readonly phone: string; readonly address: string; readonly hours: string };
     readonly headlines: readonly HeadlinePattern[];
     readonly css: string;
     readonly body: (ctx: SkeletonContext) => string;
   }
   ```

   `body` に渡ってくる `SkeletonContext` の文字列は**すべてHTMLエスケープ済み**です。骨格側で `escapeHtml` を呼ぶと二重エスケープになるので呼ばないでください。逆に `input` や `content` を直接読んで生の値を使うこともできない設計になっています（`SkeletonContext` 経由の値だけを使ってください）。

2. **`worker/src/domain/render/skeletons/<自分のkey>.ts`** を新規作成し、既存の `meishi.ts`（名刺）・`noren.ts`（暖簾）・`tanzaku.ts`（短冊）・`hogan.ts`（方眼）のどれかを下敷きに実装する。パレット（配色）のCSSカスタムプロパティは `var(--x)` 経由でしか触らないこと（静的CSSはパレット非依存にする設計原則）。

3. **`worker/src/domain/render/skeletons/index.ts`** の配列に1行追加する。

   ```typescript
   export const SKELETONS: readonly Skeleton[] = [MEISHI, NOREN, TANZAKU, HOGAN, YOUR_SKELETON];
   ```

   なお現状 `SkeletonKey` 型は `"名刺" | "暖簾" | "短冊" | "方眼"` という閉じたUnion型です（`types.ts`）。新しいキーを追加する場合はこの型定義にも自分のキーを足す必要があります（この型を将来オープンなレジストリ方式に変えるのは別課題として残っています）。

4. **`worker/tests/skeleton.test.ts`** に、既存パターンに倣ってテストを追加する。最低限:
   - **決定論性テスト** — 同じ入力なら何度作っても同じ骨格・配色・HTMLになること
   - **WCAG AAコントラストテスト** — 自分の骨格が持つ全パレットで、本文色・補助色・見出し色などが背景に対して4.5:1を満たすこと（既存の `contrastRatio()` ヘルパーをそのまま使えます）
   - **業種フィルタのテスト** — `industries` に指定した業種でのみ選ばれること

5. **`worker/DESIGN_SPEC.md`**「7. 各型の仕様」に、既存4型と同じ構成で自分の骨格の仕様セクションを追記する（レビューしやすくするため）。

## 動作確認（テストだけでは拾えない「デザインとして変」を見るため）

```bash
cd worker
npm run dev
```

ルート直下の `create.html` から `npm run dev` で立てたローカルWorkerにフォームを投げて、実際の見た目を確認してください。PRには**スクリーンショットを添付**してください（配色を全部貼るのが望ましいですが、最低1配色は必須）。

## 今のスコープ外（できないことを「できる」と書かないための明記）

- **多言語対応はスコープ外です。** 見出し生成・クリシェ除去・業種語彙（`Industry` 型: `飲食店`/`美容・サロン`/`教室・スクール`/`小売・物販`/`修理・住まいのサービス`/`その他`）は日本語・日本の業種分類を前提に作られています。今回のスコープは「日本国内の色々な業種・地域の型を足せる」ことで、海外向けの型・多言語文言は別の大きな設計課題として今後の課題です。
- **本番運用スクリプト**（デプロイ・データ移行など）はこのリポジトリには含まれていません。骨格の追加だけで完結する構成です。

## PRを送る前のチェックリスト

- [ ] `npm test` が全件green（既存分＋追加分）
- [ ] `npm run check`（`tsc --noEmit`）がgreen
- [ ] 新しい配色は `var(--x)` 経由でしかパレット色に触っていない
- [ ] 新しい骨格の全パレット × 全表示面でWCAG AA 4.5:1を満たすテストを書いた
- [ ] 同じ入力を2回generateして同じ出力になることを確認した
- [ ] ローカルの `create.html` から実際に生成して見た目を確認し、スクリーンショットをPRに添付した

## その他の貢献

デザイン骨格の追加以外にも、バグ報告・テストの追加・ドキュメントの改善を歓迎します。Issueを立てるか、直接PRを送ってください。
