import { generateContent, ProviderError, type GeneratedContent, type WorkersAiBinding } from "./generation/provider.ts";
import { qaContent } from "./domain/qa.ts";
import { enforceRateLimit, RateLimitError, type RateLimitStore } from "./domain/rateLimit.ts";
import { renderSite } from "./domain/render.ts";
import { createUniqueSlug } from "./domain/slug.ts";
import { validateInput, ValidationError, type SiteInput } from "./domain/validate.ts";
import { bearerToken, verifyGoogleIdToken, type GoogleUser } from "./domain/googleAuth.ts";
import { consumeDailyQuota, DAILY_SITES_PER_USER, nextAiQuotaReset, tokyoDateKey, UserQuotaError } from "./domain/userQuota.ts";

export interface Env {
  SITES: RateLimitStore;
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
}

export interface RequestContext {
  generate?: (input: SiteInput, env: Env) => Promise<GeneratedContent>;
  now?: () => number;
}

const ALLOWED_ORIGINS = new Set([
  "https://freehp.jp",
  "https://www.freehp.jp",
  "https://imai-design.github.io",
]);
const DEFAULT_BASE_URL = "https://free-hp-engine.ryoseiworld.workers.dev";
const TOP_PAGE_URL = "https://freehp.jp/";
const SAMPLE_TTL_SECONDS = 60 * 60 * 24 * 90;

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
    headers.set("access-control-allow-headers", "content-type, authorization");
    headers.set("vary", "Origin");
  }
  return headers;
}

function withCors(request: Request, response: Response): Response {
  const headers = corsHeaders(request);
  response.headers.forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleSite(slug: string, env: Env): Promise<Response> {
  const html = await env.SITES.get(`site:${slug}`);
  return new Response(html, {
    status: html ? 200 : 404,
    headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" },
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
    content = await (context.generate ?? generateContent)(input, env);
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
  const qa = qaContent(content, input);
  if (!qa.ok) return json({ error: "生成内容の確認に失敗しました。もう一度お試しください。" }, 422);
  const baseUrl = (env.PUBLIC_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/u, "");
  let slug: string;
  try {
    slug = await createUniqueSlug(env.SITES, input.storeName);
    const publicUrl = `${baseUrl}/s/${slug}`;
    // 写真は画像URLとして別に置く。ページ本体も共有カードも同じURLを参照する。
    const photoUrl = input.photo ? `${publicUrl}/photo` : undefined;
    // 申込フォームから作られたページに期限は付けない。
    // 1日3件フル稼働でも1年で無料枠の2割ほどしか使わないと実測できたので、消す理由がない。
    // （もともとの90日は営業用の見本を自動で掃除するための仕組みで、お客さんまで巻き添えにしていた）
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
  } catch {
    return json({ error: "公開処理に失敗しました。もう一度お試しください。" }, 503);
  }
  return json({ url: `${baseUrl}/s/${slug}`, slug }, 200, { "x-rate-limit-remaining": String(limit.remaining) });
}

interface SamplePartner {
  key: string;
  name: string;
}

/** 長さが違っても長い方の末尾まで必ず走査する。 */
function fullScanEqual(actual: string | null, expected: string): boolean {
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
  let content: GeneratedContent;
  try {
    content = await (context.generate ?? generateContent)(input, env);
  } catch (error) {
    // 合鍵が要る経路なので、原因の切り分けができるよう詳細まで返す（申込フォーム側は伏せたまま）。
    return json({
      error: "生成サービスとの通信に失敗しました。",
      code: error instanceof ProviderError ? error.code : "unknown",
      detail: error instanceof ProviderError ? (error.upstreamMessage ?? error.message) : (error instanceof Error ? error.message : String(error)),
    }, 502);
  }
  const qa = qaContent(content, input);
  if (!qa.ok) return json({ error: "生成内容の確認に失敗しました。", reason: qa.reason }, 422);
  const baseUrl = (env.PUBLIC_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/u, "");
  try {
    const slug = await createUniqueSlug(env.SITES, input.storeName);
    const publicUrl = `${baseUrl}/s/${slug}`;
    const photoUrl = input.photo ? `${publicUrl}/photo` : undefined;
    if (input.photo) await env.SITES.put(`photo:${slug}`, input.photo, { expirationTtl: SAMPLE_TTL_SECONDS });
    const html = renderSite(input, content, { publicUrl, photoUrl, sample: true });
    await env.SITES.put(`site:${slug}`, html, { expirationTtl: SAMPLE_TTL_SECONDS });
    if (partner) {
      const now = context.now?.() ?? Date.now();
      await env.SITES.put(
        `partner_site:${slug}`,
        JSON.stringify({ key: partner.key, name: partner.name, at: new Date(now).toISOString() }),
        { expirationTtl: SAMPLE_TTL_SECONDS },
      );
      const countKey = `partner_count:${partner.key}:${tokyoDateKey(now).slice(0, 7)}`;
      const storedCount = Number(await env.SITES.get(countKey) ?? "0");
      const count = Number.isSafeInteger(storedCount) && storedCount >= 0 ? storedCount : 0;
      await env.SITES.put(countKey, String(count + 1));
    }
    return json({ url: publicUrl, slug });
  } catch {
    return json({ error: "公開処理に失敗しました。" }, 503);
  }
}

export async function handleRequest(request: Request, env: Env, context: RequestContext = {}): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return withCors(request, new Response(null, { status: 204 }));
  if (url.pathname === "/api/generate" && request.method === "POST") return withCors(request, await handleGenerate(request, env, context));
  if (url.pathname === "/api/sample" && request.method === "POST") return withCors(request, await handleSample(request, env, context));
  if (url.pathname.startsWith("/api/") && request.method !== "OPTIONS") return withCors(request, json({ error: "not found" }, 404));
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
    return new Response(null, { status: 302, headers: { location: TOP_PAGE_URL } });
  }
  if (request.method === "GET" || request.method === "HEAD") {
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
