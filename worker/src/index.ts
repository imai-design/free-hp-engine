import { generateContent, ProviderError, type GeneratedContent, type WorkersAiBinding } from "./generation/provider.ts";
import { CATEGORY_LEAK_QA_REASON, qaContent, sanitizeCategoryLeak, sanitizeVenueTerms, VENUE_LANGUAGE_QA_REASON } from "./domain/qa.ts";
import { enforceRateLimit, RateLimitError, type RateLimitStore } from "./domain/rateLimit.ts";
import { renderSite } from "./domain/render.ts";
import { SKELETONS } from "./domain/render/skeletons/index.ts";
import type { SkeletonKey } from "./domain/render/types.ts";
import { createUniqueSlug } from "./domain/slug.ts";
import { validateInput, validateSampleSource, ValidationError, type SampleSource, type SiteInput } from "./domain/validate.ts";
import { bearerToken, verifyGoogleIdToken, type GoogleUser } from "./domain/googleAuth.ts";
import { consumeDailyQuota, DAILY_SITES_PER_USER, nextAiQuotaReset, tokyoDateKey, UserQuotaError } from "./domain/userQuota.ts";
import { checkDomainAvailability, type AvailabilityStatus, type FetchImpl } from "./domain/domainAvailability.ts";
import { quoteDomains } from "./domain/domainPricing.ts";
import { validateDomainRequest, type DomainRequestInput, type DomainRequestMethod } from "./domain/validateDomainRequest.ts";
import { countFailedApplications, hashIp, listApplications, recordApplication, toCsv, type D1Database } from "./domain/applications.ts";
import { enforceAdminRateLimit } from "./domain/adminRateLimit.ts";
import { sampleTtlSeconds } from "./domain/sample.ts";
import {
  beaconResponse,
  constantTimeEqual,
  getAnalyticsStats,
  handleBeat,
  statsAccessKey,
} from "./domain/analytics.ts";
import { renderStatsPage } from "./domain/statsPage.ts";

interface KvListResult {
  keys: Array<{ name: string }>;
}

interface WorkerStore extends RateLimitStore {
  list?: (options: { prefix: string; limit?: number }) => Promise<KvListResult>;
  delete?: (key: string) => Promise<void>;
}

export interface Env {
  SITES: WorkerStore;
  ANTHROPIC_API_KEY?: string;
  AI?: WorkersAiBinding;
  PUBLIC_BASE_URL?: string;
  /** こちらから提案するための見本をまとめて作る経路の合鍵。未設定ならその経路は閉じたまま。 */
  BATCH_KEY?: string;
  /**
   * GoogleログインのクライアントID（公開値）。
   * 未設定のあいだはログイン不要のまま動く（設定した瞬間に登録制へ切り替わる）。
   */
  GOOGLE_CLIENT_ID?: string;
  /** 申込情報（applications テーブル）を持つD1。未設定（ローカル・テスト）でも申込処理自体は止めない。 */
  DB?: D1Database;
  /**
   * 管理用一覧・CSVエクスポート（/api/admin/applications）の鍵。未設定ならその経路は隠したまま。
   * 正式な渡し方は `Authorization: Bearer <key>` ヘッダー。クエリパラメータ `?key=` は
   * 2026-09-17まで（追加から30日間）だけ後方互換で受け付ける（DB.md参照）。
   */
  ADMIN_KEY?: string;
}

export interface RequestContext {
  generate?: (input: SiteInput, env: Env) => Promise<GeneratedContent>;
  now?: () => number;
  fetch?: FetchImpl;
}

const ALLOWED_ORIGINS = new Set([
  "https://freehp.jp",
  "https://www.freehp.jp",
  "https://imai-design.github.io",
]);
const DEFAULT_BASE_URL = "https://free-hp-engine.ryoseiworld.workers.dev";
const TOP_PAGE_URL = "https://freehp.jp/";
const MAX_GENERATION_QA_ATTEMPTS = 2;

interface CheckedGeneration {
  readonly content?: GeneratedContent;
  readonly reason?: string;
}

/**
 * 非店舗用の語彙違反（来店語・審査カテゴリ名の混入）だけは再生成し、
 * それでも直らなければ決定的な機械置換へ倒す。両方とも同じリトライ／フォールバック経路に乗せる。
 */
async function generateCheckedContent(
  input: SiteInput,
  env: Env,
  generator: NonNullable<RequestContext["generate"]>,
  sampleSource?: SampleSource,
): Promise<CheckedGeneration> {
  let venueFallback: GeneratedContent | undefined;
  let lastReason: string | undefined;
  for (let attempt = 1; attempt <= MAX_GENERATION_QA_ATTEMPTS; attempt += 1) {
    let generated: GeneratedContent;
    try {
      generated = await generator(input, env);
    } catch (error) {
      if (!venueFallback) throw error;
      break;
    }
    const qa = qaContent(generated, input, sampleSource);
    if (qa.ok) return { content: generated };
    lastReason = qa.reason;
    if (qa.reason !== VENUE_LANGUAGE_QA_REASON && qa.reason !== CATEGORY_LEAK_QA_REASON) break;
    venueFallback = generated;
  }
  if (!venueFallback) return { reason: lastReason };
  const sanitized = sanitizeCategoryLeak(sanitizeVenueTerms(venueFallback, input), input);
  const fallbackQa = qaContent(sanitized, input, sampleSource);
  return fallbackQa.ok ? { content: sanitized } : { reason: fallbackQa.reason ?? lastReason };
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get("origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", "POST, GET, OPTIONS");
    // authorizationを許可しないと、ログイン付きのfetchはブラウザの事前確認(preflight)で落ちる。
    // 実際に2026-08-06、これを忘れて「通信に失敗しました」になった。
    headers.set("access-control-allow-headers", "content-type, authorization, x-batch-key");
    headers.set("vary", "Origin");
  }
  return headers;
}

function withCors(request: Request, response: Response): Response {
  const headers = corsHeaders(request);
  response.headers.forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** data属性は新規ページ用、robots metaは属性追加前に作った既存見本を安全に配信するための後方互換。 */
function isSampleHtml(html: string | null): html is string {
  return html !== null && (
    html.includes('data-freehp-sample="true"')
    || html.includes('<meta name="robots" content="noindex,nofollow">')
  );
}

async function handleSite(slug: string, env: Env): Promise<Response> {
  const html = await env.SITES.get(`site:${slug}`);
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
  if (isSampleHtml(html)) {
    headers["x-robots-tag"] = "noindex, nofollow, noarchive";
    headers["referrer-policy"] = "no-referrer";
  }
  return new Response(html, {
    status: html ? 200 : 404,
    headers,
  });
}

const STORED_PHOTO_PATTERN = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/u;

/**
 * 写真を画像ファイルとして配信する。
 * HTMLに埋め込んだままだとLINEやSNSの共有カードに画像を出せない（og:imageは参照可能なURLを要求する）。
 * ページ本体も同じURLを参照するので、HTMLが数KBに収まりスマホでの表示も速くなる。
 */
async function handlePhoto(slug: string, env: Env): Promise<Response> {
  const stored = await env.SITES.get(`photo:${slug}`);
  if (!stored) return new Response(null, { status: 404 });
  const match = STORED_PHOTO_PATTERN.exec(stored);
  if (!match) return new Response(null, { status: 404 });
  let binary: string;
  try {
    binary = atob(match[2]);
  } catch {
    return new Response(null, { status: 404 });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Response(bytes, {
    headers: {
      "content-type": match[1],
      // 中身が変わらない前提のURLなので長めに持たせる。ページごと消えるときは一緒に消える。
      "cache-control": "public, max-age=604800",
      "x-content-type-options": "nosniff",
    },
  });
}

function withoutBody(response: Response): Response {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function handleGenerate(request: Request, env: Env, context: RequestContext): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "origin is not allowed" }, 403);
  // 写真1枚（ブラウザ側で縮小済みのdata URI）を受け取れる程度まで許容する。
  // 個々の項目の長さはvalidateInput側で別途縛っているので、ここは全体の重さの歯止め。
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 3_000_000) return json({ error: "request is too large" }, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(await request.text());
  } catch {
    return json({ error: "request body must be valid JSON" }, 400);
  }
  let input: SiteInput;
  try {
    input = validateInput(raw);
  } catch (error) {
    return json({ error: error instanceof ValidationError ? error.message : "invalid request" }, 400);
  }
  // ログインを必須にするのは GOOGLE_CLIENT_ID を設定したときだけ。
  // 未設定のあいだは従来どおり誰でも作れる（切り替えでサイトが止まらないようにするため）。
  let user: GoogleUser | null = null;
  if (env.GOOGLE_CLIENT_ID) {
    const token = bearerToken(request.headers.get("authorization"));
    user = token ? await verifyGoogleIdToken(token, env.GOOGLE_CLIENT_ID, env.SITES, context.now ?? Date.now) : null;
    if (!user) {
      return json({ error: "Googleでログインしてから、もう一度お試しください。", needsLogin: true }, 401);
    }
    if (!user.emailVerified) {
      return json({ error: "Googleアカウントのメールアドレスが確認済みではありません。" }, 403);
    }
    try {
      await consumeDailyQuota(env.SITES, user.sub, context.now?.() ?? Date.now());
    } catch (error) {
      if (error instanceof UserQuotaError) {
        return json({
          error: `1日に作れるのは${DAILY_SITES_PER_USER}件までです。日付が変わったらまた作れます。もっと必要な場合はメールでご相談ください。`,
        }, 429);
      }
      return json({ error: "利用状況を確認できませんでした。もう一度お試しください。" }, 503);
    }
  }
  let limit: { remaining: number; resetAt: number };
  try {
    limit = await enforceRateLimit(env.SITES, request.headers.get("CF-Connecting-IP") ?? "unknown", context.now?.() ?? Date.now());
  } catch (error) {
    if (error instanceof RateLimitError) return json({ error: "生成回数の上限に達しました。1時間後にもう一度お試しください。" }, 429, { "retry-after": String(error.retryAfter) });
    return json({ error: "rate limit service is unavailable" }, 503);
  }
  let content: GeneratedContent;
  try {
    const generated = await generateCheckedContent(input, env, context.generate ?? generateContent);
    if (!generated.content) {
      return json({ error: "生成内容の確認に失敗しました。もう一度お試しください。" }, 422);
    }
    content = generated.content;
  } catch (error) {
    // 枠切れは翌日まで回復しない。「少し時間をおいて」と案内すると嘘になるので分けて伝える。
    if (error instanceof ProviderError && error.code === "daily_quota_exhausted") {
      const reset = nextAiQuotaReset(context.now?.() ?? Date.now());
      return json({
        error: `いま作れる分を使い切ってしまいました。${reset.label}（あと約${reset.hoursLeft}時間）にまた作れるようになります。お急ぎでしたらメールでご相談ください。`,
      }, 429, { "retry-after": String(reset.hoursLeft * 3600) });
    }
    const isNotConfigured = error instanceof ProviderError && (error.code === "missing_api_key" || error.code === "missing_binding");
    if (isNotConfigured) return json({ error: "生成サービスの準備中です。" }, 503);
    return json({ error: "生成サービスとの通信に失敗しました。" }, 502);
  }
  const baseUrl = (env.PUBLIC_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/u, "");
  let slug: string;
  let publicUrl: string;
  try {
    slug = await createUniqueSlug(env.SITES, input.storeName);
    publicUrl = `${baseUrl}/s/${slug}`;
    // 写真は画像URLとして別に置く。ページ本体も共有カードも同じURLを参照する。
    const photoUrl = input.photo ? `${publicUrl}/photo` : undefined;
    // 申込フォームから作られたページに期限は付けない。
    // 1日3件フル稼働でも1年で無料枠の2割ほどしか使わないと実測できたので、消す理由がない。
    // （もともとのTTLは営業用の見本を自動で掃除するための仕組みで、お客さんまで巻き添えにしていた）
    if (input.photo) {
      await env.SITES.put(`photo:${slug}`, input.photo);
    }
    const html = renderSite(input, content, { publicUrl, photoUrl });
    await env.SITES.put(`site:${slug}`, html);
    if (user) {
      // 誰がどのページを作ったか。あとから本人に一覧を見せる／引っ越しの連絡をするために要る。
      await env.SITES.put(
        `owner:${slug}`,
        JSON.stringify({ sub: user.sub, email: user.email, storeName: input.storeName, at: new Date(context.now?.() ?? Date.now()).toISOString() }),
        { expirationTtl: 60 * 60 * 24 * 400 },
      );
    }
    // 申込内容の記録。失敗してもここまでの生成・公開は成功しているのでレスポンスは変えない
    // （失敗時はenv.SITESへ内容を退避する。recordApplication内部の仕組み）。
    await recordApplication(env.DB, {
      createdAt: new Date(context.now?.() ?? Date.now()).toISOString(),
      kind: "site",
      slug,
      publicUrl,
      storeName: input.storeName,
      businessType: input.industry,
      description: input.description,
      catchcopy: input.catchphrase,
      mood: input.colorTheme,
      phone: input.phone,
      address: input.address,
      hours: input.businessHours,
      menuText: input.menuText,
      reserveUrl: input.reserveUrl,
      instagram: input.instagram,
      lineOfficial: input.lineOfficial,
      hasPhoto: Boolean(input.photo),
      ownerEmail: user?.email,
      ownerSub: user?.sub,
      ip: request.headers.get("CF-Connecting-IP") ?? undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
    }, env.SITES);
  } catch {
    return json({ error: "公開処理に失敗しました。もう一度お試しください。" }, 503);
  }
  return json({ url: publicUrl, slug }, 200, { "x-rate-limit-remaining": String(limit.remaining) });
}

interface SamplePartner {
  key: string;
  name: string;
}

// 想定する鍵の長さを大きく超える入力は比較に入る前に弾く（走査量が入力長に比例して増える一種の
// リソース濫用への歯止め。厳密なconstant-time比較の代替ではなく、あくまで異常に長い入力への防御）。
const MAX_COMPARE_LENGTH = 64;

/** 長さが違っても長い方の末尾まで必ず走査する。 */
function fullScanEqual(actual: string | null, expected: string): boolean {
  if (actual !== null && actual.length > MAX_COMPARE_LENGTH) return false;
  let mismatch = actual === null ? 1 : actual.length ^ expected.length;
  const actualLength = actual?.length ?? 0;
  for (let index = 0; index < Math.max(actualLength, expected.length); index += 1) {
    mismatch |= (actual?.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function activePartner(key: string, stored: string | null): SamplePartner | null {
  if (!stored) return null;
  try {
    const value = JSON.parse(stored) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    if (record.active !== true || typeof record.name !== "string" || !record.name.trim()) return null;
    return { key, name: record.name };
  } catch {
    return null;
  }
}

const DOMAIN_NEXT_STEPS: Record<DomainRequestMethod, readonly string[]> = {
  self: [
    "ドメイン取得の手順書をメールでお送りします（届かない場合は迷惑メールもご確認ください）",
    "取得できたら、そのドメイン名を返信で教えてください。こちらで設定して公開します",
    "設定・公開の費用はいただきません",
  ],
  wait_crowdfunding: [
    "取得費用はクラウドファンディングで集める準備をしています。準備が整い次第、順番にメールでご案内します",
    "お待ちいただく間も、いまのページはそのまま公開されています",
    "お急ぎになった場合は、同じフォームから『お急ぎ』で送り直してください",
  ],
  prepay: [
    "振込先と金額（ドメインの実費のみ）をメールでご案内します",
    "ご入金の確認後、通常1〜3日でドメインを取得して設定します",
    "領収書が必要な場合はメールでお知らせください",
  ],
};

interface StoredDomainRequest extends DomainRequestInput {
  id: string;
  at: string;
  availability: Record<string, AvailabilityStatus>;
  quote: Record<string, number>;
  status: "new";
}

function domainRequestId(now: number): string {
  const date = new Date(now).toISOString().slice(0, 10).replace(/-/gu, "");
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${date}-${suffix}`;
}

/** src/domain/slug.ts の createUniqueSlug と同じパターン。KVに同じ申込IDが既にあれば作り直す。 */
async function createUniqueDomainRequestId(store: RateLimitStore, now: number): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = domainRequestId(now);
    if (!(await store.get(`domreq:${id}`))) return id;
  }
  throw new Error("could not allocate a unique domain request id");
}

async function handleDomainRequest(request: Request, env: Env, context: RequestContext): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "origin is not allowed" }, 403);

  // /api/generate と同じ歯止め。本文を読む前にヘッダーだけで重すぎるリクエストを弾く。
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 20_000) return json({ error: "request too large" }, 413);

  // 不正なリクエストを繰り返し送っても予算（レート上限）を消費させるため、
  // JSONパース・バリデーションより前にレート制限を掛ける。
  try {
    await enforceRateLimit(env.SITES, request.headers.get("CF-Connecting-IP") ?? "unknown", context.now?.() ?? Date.now());
  } catch (error) {
    if (error instanceof RateLimitError) {
      return json({ error: "送信回数の上限に達しました。1時間後にもう一度お試しください。" }, 429, { "retry-after": String(error.retryAfter) });
    }
    return json({ error: "rate limit service is unavailable" }, 503);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await request.text());
  } catch {
    return json({ error: "request body must be valid JSON" }, 400);
  }

  let input: DomainRequestInput;
  try {
    input = validateDomainRequest(raw);
  } catch (error) {
    return json({ error: error instanceof ValidationError ? error.message : "invalid request" }, 422);
  }

  const entries = await Promise.all(input.domains.map(async (domain) => [
    domain,
    await checkDomainAvailability(domain, context.fetch ?? fetch),
  ] as const));
  const availability = Object.fromEntries(entries) as Record<string, AvailabilityStatus>;
  const quote = quoteDomains(input.domains);
  const now = context.now?.() ?? Date.now();

  let id: string;
  try {
    id = await createUniqueDomainRequestId(env.SITES, now);
    const stored: StoredDomainRequest = {
      ...input,
      id,
      at: new Date(now).toISOString(),
      availability,
      quote,
      status: "new",
    };
    await env.SITES.put(`domreq:${id}`, JSON.stringify(stored));
  } catch {
    return json({ error: "お申し込みを保存できませんでした。もう一度お試しください。" }, 503);
  }
  // 既存のsiteUrl(/s/{slug})からslugを拾えれば、サイト側の申込(kind='site')と突き合わせられるようにしておく。
  const slugMatch = input.siteUrl?.match(/\/s\/([a-z0-9-]{4,80})(?:\/|$)/u);
  await recordApplication(env.DB, {
    createdAt: new Date(now).toISOString(),
    kind: "domain_request",
    slug: slugMatch?.[1],
    publicUrl: input.siteUrl,
    storeName: input.storeName,
    hasPhoto: false,
    phone: input.phone,
    ownerEmail: input.email,
    ip: request.headers.get("CF-Connecting-IP") ?? undefined,
    userAgent: request.headers.get("user-agent") ?? undefined,
    note: input.note,
    extra: { id, domains: input.domains, contactName: input.contactName, method: input.method, availability, quote },
  }, env.SITES);

  return json({
    id,
    availability,
    quote,
    method: input.method,
    nextSteps: [...DOMAIN_NEXT_STEPS[input.method]],
  });
}

async function handleDomainRequests(request: Request, env: Env): Promise<Response> {
  const key = request.headers.get("x-batch-key");
  if (!env.BATCH_KEY || !fullScanEqual(key, env.BATCH_KEY)) return json({ error: "not found" }, 404);

  const sinceValue = new URL(request.url).searchParams.get("since");
  let since = Number.NEGATIVE_INFINITY;
  if (sinceValue !== null) {
    since = Date.parse(sinceValue);
    if (!sinceValue.trim() || !Number.isFinite(since)) return json({ error: "since must be a valid ISO timestamp" }, 422);
  }

  if (!env.SITES.list) return json({ error: "request store is unavailable" }, 503);
  try {
    const listed = await env.SITES.list({ prefix: "domreq:", limit: 200 });
    const values = await Promise.all(listed.keys.slice(0, 200).map(({ name }) => env.SITES.get(name)));
    const items = values.flatMap((value): StoredDomainRequest[] => {
      if (!value) return [];
      try {
        const item = JSON.parse(value) as StoredDomainRequest;
        const at = typeof item.at === "string" ? Date.parse(item.at) : Number.NaN;
        return Number.isFinite(at) && at >= since ? [item] : [];
      } catch {
        return [];
      }
    });
    items.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    return json({ items: items.slice(0, 200) });
  } catch {
    return json({ error: "お申し込み一覧を取得できませんでした。" }, 503);
  }
}

// クエリパラメータ`?key=`での認証は、Authorizationヘッダーへの移行期間として
// この日時までだけ後方互換で受け付ける（2026-08-18の追加から30日間）。
const ADMIN_QUERY_KEY_DEPRECATION_DEADLINE = Date.parse("2026-09-17T00:00:00Z");

interface ExtractedAdminKey {
  key: string | null;
  /** ?key= のほうで認証した（＝非推奨経路を使った）かどうか。レスポンスに警告ヘッダーを足すために使う。 */
  deprecatedQuery: boolean;
}

/**
 * 管理鍵は `Authorization: Bearer <key>` ヘッダーが正。
 * `?key=` はアクセスログ・ブラウザ履歴に残るため、移行期間(ADMIN_QUERY_KEY_DEPRECATION_DEADLINEまで)だけ
 * 後方互換で受け付ける。期限を過ぎたら`?key=`は無視し（鍵不一致と同じ401になる）、経路自体は隠さない。
 */
function extractAdminKey(request: Request, url: URL, now: number): ExtractedAdminKey {
  const bearerMatch = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/u);
  if (bearerMatch) return { key: bearerMatch[1], deprecatedQuery: false };
  const queryKey = url.searchParams.get("key");
  if (queryKey !== null && now < ADMIN_QUERY_KEY_DEPRECATION_DEADLINE) {
    return { key: queryKey, deprecatedQuery: true };
  }
  return { key: null, deprecatedQuery: false };
}

/**
 * 申込情報（applications テーブル）の管理用一覧・CSVエクスポート。
 * ADMIN_KEY未設定なら経路の存在自体を隠す。
 */
async function handleAdminApplications(request: Request, env: Env, context: RequestContext): Promise<Response> {
  if (!env.ADMIN_KEY) return json({ error: "not found" }, 404);
  // レート制限・失敗集計のどちらもD1(env.DB)を使うため、鍵チェックより前にDBの有無を確認する。
  if (!env.DB) return json({ error: "database is unavailable" }, 503);

  const now = context.now?.() ?? Date.now();

  // 鍵の総当たりを、鍵の一致確認より前に頭打ちにする（不正な鍵でも予算を消費させるため）。
  // KVのget→put(非原子的)ではなくD1のINSERT→COUNTを使う（src/domain/adminRateLimit.ts参照）。
  try {
    const ipHash = await hashIp(request.headers.get("CF-Connecting-IP") ?? "unknown");
    await enforceAdminRateLimit(env.DB, ipHash, now);
  } catch (error) {
    if (error instanceof RateLimitError) {
      return json({ error: "試行回数の上限に達しました。1時間後にもう一度お試しください。" }, 429, { "retry-after": String(error.retryAfter) });
    }
    return json({ error: "rate limit service is unavailable" }, 503);
  }

  const url = new URL(request.url);
  const { key, deprecatedQuery } = extractAdminKey(request, url, now);
  const extraHeaders: HeadersInit = deprecatedQuery ? { "x-deprecated-auth": "query" } : {};
  if (!fullScanEqual(key, env.ADMIN_KEY)) return json({ error: "unauthorized" }, 401, extraHeaders);

  // D1保存に失敗した申込がKVへ何件退避されているかだけを返す（内容そのものは返さない）。
  if (url.searchParams.get("failed") === "1") {
    const failedCount = await countFailedApplications(env.SITES);
    return json({ failedCount }, 200, { "cache-control": "no-store", ...extraHeaders });
  }

  const sinceValue = url.searchParams.get("since");
  let sinceIso: string | null = null;
  if (sinceValue !== null && sinceValue.trim()) {
    const parsed = Date.parse(sinceValue);
    if (!Number.isFinite(parsed)) return json({ error: "since must be a valid date (YYYY-MM-DD)" }, 422, extraHeaders);
    sinceIso = new Date(parsed).toISOString();
  }

  let rows: Awaited<ReturnType<typeof listApplications>>;
  try {
    rows = await listApplications(env.DB, sinceIso);
  } catch {
    return json({ error: "申込情報を取得できませんでした。" }, 503, extraHeaders);
  }

  // 個人情報を含むレスポンスなので、共有キャッシュ・ブラウザキャッシュのどちらにも残さない。
  if (url.searchParams.get("format") === "json") return json({ items: rows }, 200, { "cache-control": "no-store", ...extraHeaders });

  // 既定はCSV。ExcelやNumbersで開いても文字化けしないよう先頭にUTF-8のBOM(U+FEFF)を付ける。
  return new Response("\uFEFF" + toCsv(rows), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="applications.csv"',
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

/**
 * こちらから提案するための見本を1件作る（営業用）。
 * 申込フォーム経由ではないので回数制限をかけず、そのかわり合鍵を要求する。
 * お店の承諾を得ていないページなので必ず noindex を立てる（公式サイトと誤解されないため）。
 */
async function handleSample(request: Request, env: Env, context: RequestContext): Promise<Response> {
  const key = request.headers.get("x-batch-key");
  // 従来どおり、合鍵が未設定かつ鍵すら提示されていなければ経路の存在を隠す。
  if (!env.BATCH_KEY && key === null) return json({ error: "not found" }, 404);

  // 長さ違いも含めて必ず全文字を比較し、早期returnでBATCH_KEYの長さを漏らさない。
  const isBatchRequest = env.BATCH_KEY ? fullScanEqual(key, env.BATCH_KEY) : false;
  let partner: SamplePartner | null = null;
  if (!isBatchRequest && key !== null) {
    partner = activePartner(key, await env.SITES.get(`partner:${key}`));
  }
  if (!isBatchRequest && !partner) return json({ error: "unauthorized" }, 401);

  let raw: unknown;
  try {
    raw = JSON.parse(await request.text());
  } catch {
    return json({ error: "request body must be valid JSON" }, 400);
  }
  let input: SiteInput;
  try {
    input = validateInput(raw);
  } catch (error) {
    return json({ error: error instanceof ValidationError ? error.message : "invalid request" }, 400);
  }
  // sampleSource（断り書きの文言）とskeleton（骨格の固定）は、お店データ(SiteInput)ではなく
  // リクエスト直下のメタ情報として受け取る。raw はここまで validateInput を通っているのでオブジェクト確定。
  const rawObject = raw as Record<string, unknown>;
  let sampleSource: SampleSource;
  try {
    sampleSource = validateSampleSource(rawObject.sampleSource);
  } catch (error) {
    return json({ error: error instanceof ValidationError ? error.message : "invalid request" }, 400);
  }
  let skeletonKey: SkeletonKey | undefined;
  if (rawObject.skeleton !== undefined && rawObject.skeleton !== null && rawObject.skeleton !== "") {
    const found = SKELETONS.find((skeleton) => skeleton.key === rawObject.skeleton);
    if (!found) return json({ error: "skeleton is invalid" }, 400);
    skeletonKey = found.key;
  }
  let content: GeneratedContent;
  try {
    const generated = await generateCheckedContent(input, env, context.generate ?? generateContent, sampleSource);
    if (!generated.content) {
      return json({ error: "生成内容の確認に失敗しました。", reason: generated.reason }, 422);
    }
    content = generated.content;
  } catch (error) {
    // 合鍵が要る経路なので、原因の切り分けができるよう詳細まで返す（申込フォーム側は伏せたまま）。
    return json({
      error: "生成サービスとの通信に失敗しました。",
      code: error instanceof ProviderError ? error.code : "unknown",
      detail: error instanceof ProviderError ? (error.upstreamMessage ?? error.message) : (error instanceof Error ? error.message : String(error)),
    }, 502);
  }
  const baseUrl = (env.PUBLIC_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/u, "");
  const expirationTtl = sampleTtlSeconds(sampleSource);
  try {
    const slug = await createUniqueSlug(env.SITES, input.storeName);
    const publicUrl = `${baseUrl}/s/${slug}`;
    const photoUrl = input.photo ? `${publicUrl}/photo` : undefined;
    if (input.photo) await env.SITES.put(`photo:${slug}`, input.photo, { expirationTtl });
    const html = renderSite(input, content, { publicUrl, photoUrl, sample: true, sampleSource, skeleton: skeletonKey });
    await env.SITES.put(`site:${slug}`, html, { expirationTtl });
    if (partner) {
      const now = context.now?.() ?? Date.now();
      await env.SITES.put(
        `partner_site:${slug}`,
        JSON.stringify({ key: partner.key, name: partner.name, at: new Date(now).toISOString() }),
        { expirationTtl },
      );
      const countKey = `partner_count:${partner.key}:${tokyoDateKey(now).slice(0, 7)}`;
      const storedCount = Number(await env.SITES.get(countKey) ?? "0");
      const count = Number.isSafeInteger(storedCount) && storedCount >= 0 ? storedCount : 0;
      await env.SITES.put(countKey, String(count + 1));
    }
    // 申込内容の記録。失敗してもここまでの生成・公開は成功しているのでレスポンスは変えない。
    await recordApplication(env.DB, {
      createdAt: new Date(context.now?.() ?? Date.now()).toISOString(),
      kind: "sample",
      slug,
      publicUrl,
      storeName: input.storeName,
      businessType: input.industry,
      description: input.description,
      catchcopy: input.catchphrase,
      mood: input.colorTheme,
      phone: input.phone,
      address: input.address,
      hours: input.businessHours,
      menuText: input.menuText,
      reserveUrl: input.reserveUrl,
      instagram: input.instagram,
      lineOfficial: input.lineOfficial,
      hasPhoto: Boolean(input.photo),
      partnerKey: partner?.key,
      ip: request.headers.get("CF-Connecting-IP") ?? undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
    }, env.SITES);
    return json({ url: publicUrl, slug });
  } catch {
    return json({ error: "公開処理に失敗しました。" }, 503);
  }
}

/** 連絡を受けた見本を、その場で公開KVから消す。通常サイトには絶対に使えない。 */
async function handleSampleUnpublish(request: Request, env: Env): Promise<Response> {
  const key = request.headers.get("x-batch-key");
  if (!env.BATCH_KEY && key === null) return json({ error: "not found" }, 404);
  if (!env.BATCH_KEY || !fullScanEqual(key, env.BATCH_KEY)) {
    return json({ error: "unauthorized" }, 401);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await request.text());
  } catch {
    return json({ error: "request body must be valid JSON" }, 400);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return json({ error: "request body must be a JSON object" }, 400);
  }
  const slug = (raw as Record<string, unknown>).slug;
  if (typeof slug !== "string" || !/^[a-z0-9-]{4,80}$/u.test(slug)) {
    return json({ error: "slug is invalid" }, 400);
  }

  const html = await env.SITES.get(`site:${slug}`);
  if (!html) return json({ error: "sample not found" }, 404);
  if (!isSampleHtml(html)) return json({ error: "only samples can be unpublished" }, 403);
  if (!env.SITES.delete) return json({ error: "unpublish service is unavailable" }, 503);

  // 公開本体を先に消し、その後に写真とパートナー用の補助記録を掃除する。
  await env.SITES.delete(`site:${slug}`);
  await Promise.all([
    env.SITES.delete(`photo:${slug}`),
    env.SITES.delete(`partner_site:${slug}`),
  ]);
  return json({ ok: true });
}

async function hasStatsAccess(slug: string, key: string | null, env: Env): Promise<boolean> {
  if (!env.ADMIN_KEY) return false;
  const expected = await statsAccessKey(env.ADMIN_KEY, slug);
  return constantTimeEqual(key, expected);
}

async function handleStatsApi(url: URL, env: Env, context: RequestContext): Promise<Response> {
  const slug = url.searchParams.get("slug") ?? "";
  if (!/^[a-z0-9-]{4,80}$/u.test(slug) || !await hasStatsAccess(slug, url.searchParams.get("k"), env)) {
    return json({ error: "not found" }, 404);
  }
  if (!env.DB) return json({ error: "analytics unavailable" }, 503);
  try {
    const stats = await getAnalyticsStats(env.DB, slug, context.now?.() ?? Date.now());
    return json(stats, 200, { "cache-control": "no-store" });
  } catch (error) {
    console.error("[analytics] query failed", error instanceof Error ? error.message : String(error));
    return json({ error: "analytics unavailable" }, 503);
  }
}

async function handleStatsPage(slug: string, key: string | null, env: Env): Promise<Response> {
  if (!await hasStatsAccess(slug, key, env)) return json({ error: "not found" }, 404);
  return new Response(renderStatsPage(slug, key ?? ""), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow, noarchive",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    },
  });
}

export async function handleRequest(request: Request, env: Env, context: RequestContext = {}): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/beat") return handleBeat(request, env.DB, context.now?.() ?? Date.now());
  if (request.method === "OPTIONS") return withCors(request, new Response(null, { status: 204 }));
  if (url.pathname === "/api/stats" && request.method === "GET") return handleStatsApi(url, env, context);
  if (url.pathname === "/api/generate" && request.method === "POST") return withCors(request, await handleGenerate(request, env, context));
  if (url.pathname === "/api/sample" && request.method === "POST") return withCors(request, await handleSample(request, env, context));
  if (url.pathname === "/api/sample/unpublish" && request.method === "POST") return withCors(request, await handleSampleUnpublish(request, env));
  if (url.pathname === "/api/domain-request" && request.method === "POST") return withCors(request, await handleDomainRequest(request, env, context));
  if (url.pathname === "/api/domain-requests" && request.method === "GET") return withCors(request, await handleDomainRequests(request, env));
  if (url.pathname === "/api/admin/applications" && request.method === "GET") return withCors(request, await handleAdminApplications(request, env, context));
  if (url.pathname.startsWith("/api/") && request.method !== "OPTIONS") return withCors(request, json({ error: "not found" }, 404));
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
    return new Response(null, { status: 302, headers: { location: TOP_PAGE_URL } });
  }
  if (request.method === "GET" || request.method === "HEAD") {
    if (url.pathname === "/beacon.js") {
      const response = beaconResponse();
      return request.method === "HEAD" ? withoutBody(response) : response;
    }
    const statsMatch = url.pathname.match(/^\/s\/([a-z0-9-]{4,80})\/stats$/u);
    if (statsMatch) {
      const response = await handleStatsPage(statsMatch[1], url.searchParams.get("k"), env);
      return request.method === "HEAD" ? withoutBody(response) : response;
    }
    const photoMatch = url.pathname.match(/^\/s\/([a-z0-9-]{4,80})\/photo$/u);
    if (photoMatch) {
      const response = await handlePhoto(photoMatch[1], env);
      return request.method === "HEAD" ? withoutBody(response) : response;
    }
    const match = url.pathname.match(/^\/s\/([a-z0-9-]{4,80})$/u);
    if (match) {
      const response = await handleSite(match[1], env);
      return request.method === "HEAD" ? withoutBody(response) : response;
    }
  }
  return json({ error: "not found" }, 404);
}

export default { fetch: handleRequest };
