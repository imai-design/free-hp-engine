/**
 * 見本（kind=sample）閲覧の最小計測。
 *
 * 既存のD1ベースanalytics（beacon.js）はブラウザでJSが動いたときだけ計測されるため、
 * curlや一部のプレビュー環境からのアクセスは拾えない。声かけ→閲覧→決済の中間指標として
 * 「見本URLに何回アクセスがあったか」を取り違えなく数えるため、配信時にサーバー側で
 * {slug, date}単位のカウントをKVへ素朴にインクリメントする（UA/IPは持たない）。
 * 詳細な訪問者分析（滞在・地域・デバイス等）は既存analyticsのまま。
 */

export interface SampleViewStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list?(options: { prefix: string; limit?: number }): Promise<{ keys: Array<{ name: string }> }>;
}

const SLUG_PATTERN = /^[a-z0-9-]{4,80}$/u;
const KEY_PREFIX = "sampleview:v1:";
// 週次PDCAで直近を振り返れれば十分なので、1年強残れば足りる。無限に溜め続けない歯止め。
const VIEW_TTL_SECONDS = 60 * 60 * 24 * 400;

function viewKey(slug: string, date: string): string {
  return `${KEY_PREFIX}${slug}:${date}`;
}

function tokyoDateKey(now: number): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 見本(/s/{slug})が配信されるたびに呼ぶ。失敗しても配信自体は止めない（呼び出し側でcatchする想定）。 */
export async function recordSampleView(store: SampleViewStore | undefined, slug: string, now = Date.now()): Promise<void> {
  if (!store || !SLUG_PATTERN.test(slug)) return;
  const key = viewKey(slug, tokyoDateKey(now));
  const current = Number.parseInt((await store.get(key)) ?? "0", 10);
  const next = (Number.isFinite(current) ? current : 0) + 1;
  await store.put(key, String(next), { expirationTtl: VIEW_TTL_SECONDS });
}

export interface SampleViewsResult {
  slug: string;
  views: number;
  byDate: Array<{ date: string; views: number }>;
}

/** GET /api/sample-views の集計。日別キーをlistして合算するだけの素朴な実装。 */
export async function getSampleViews(store: SampleViewStore | undefined, slug: string): Promise<SampleViewsResult | null> {
  if (!store || !store.list || !SLUG_PATTERN.test(slug)) return null;
  const listed = await store.list({ prefix: `${KEY_PREFIX}${slug}:`, limit: 1000 });
  const byDate = await Promise.all(listed.keys.map(async ({ name }) => {
    const date = name.slice(`${KEY_PREFIX}${slug}:`.length);
    const value = Number.parseInt((await store.get(name)) ?? "0", 10);
    return { date, views: Number.isFinite(value) ? value : 0 };
  }));
  byDate.sort((left, right) => left.date.localeCompare(right.date));
  const views = byDate.reduce((sum, row) => sum + row.views, 0);
  return { slug, views, byDate };
}
