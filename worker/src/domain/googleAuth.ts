/**
 * Googleアカウントでの本人確認。
 *
 * ブラウザ側で受け取ったIDトークン（JWT）を、Googleの検証エンドポイントに問い合わせて確かめる。
 * 署名検証を自前で書かないのは、鍵の取り回しを誤ると「誰でも他人になりすませる」種類の
 * 不具合になるため。1回の外部問い合わせを足すほうが安全で、結果はKVに短く置いて使い回す。
 */

export interface GoogleUser {
  /** Googleが振る不変のユーザーID。メールアドレスは変わりうるので、こちらを主キーにする。 */
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

export interface TokenStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo?id_token=";
/** Googleが名乗る発行者。どちらの表記も正規。 */
const VALID_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
/** 検証結果を使い回す時間。IDトークン自体の寿命は1時間なので、それより十分短くする。 */
const CACHE_SECONDS = 300;
/** 明らかに長すぎるものは問い合わせる前に捨てる。 */
const MAX_TOKEN_LENGTH = 4096;

/** キャッシュのキーにトークンそのものを使わないための一方向ハッシュ。 */
async function tokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface TokenInfo {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  exp?: string | number;
}

function toUser(info: TokenInfo, clientId: string, nowSeconds: number): GoogleUser | null {
  if (!info.iss || !VALID_ISSUERS.has(info.iss)) return null;
  // audが自分のクライアントIDでないトークンは、別のサービス向けに発行されたもの。受け取ってはいけない。
  if (info.aud !== clientId) return null;
  if (!info.sub || !info.email) return null;
  const exp = Number(info.exp);
  if (!Number.isFinite(exp) || exp <= nowSeconds) return null;
  const verified = info.email_verified === true || info.email_verified === "true";
  return { sub: info.sub, email: info.email, emailVerified: verified, name: info.name };
}

/**
 * IDトークンを確かめてユーザーを返す。確かめられなければ null。
 * 呼び出し側は null を「ログインしていない」として扱う（理由は伝えない＝総当たりの手がかりを与えない）。
 */
export async function verifyGoogleIdToken(
  token: string,
  clientId: string,
  store: TokenStore,
  now: () => number = Date.now,
): Promise<GoogleUser | null> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  // JWTは「.」で3つに分かれた形。そうでないものは問い合わせるまでもない。
  if (token.split(".").length !== 3) return null;

  const nowSeconds = Math.floor(now() / 1000);
  const cacheKey = `gauth:${await tokenFingerprint(token)}`;
  const cached = await store.get(cacheKey);
  if (cached) {
    try {
      const user = JSON.parse(cached) as GoogleUser & { exp: number };
      if (user.exp > nowSeconds) return { sub: user.sub, email: user.email, emailVerified: user.emailVerified, name: user.name };
    } catch {
      // 壊れたキャッシュは無視して問い合わせ直す
    }
  }

  let info: TokenInfo;
  try {
    const response = await fetch(`${TOKENINFO_URL}${encodeURIComponent(token)}`);
    if (!response.ok) return null;
    info = (await response.json()) as TokenInfo;
  } catch {
    return null;
  }

  const user = toUser(info, clientId, nowSeconds);
  if (!user) return null;

  const ttl = Math.min(CACHE_SECONDS, Math.max(1, Number(info.exp) - nowSeconds));
  await store.put(cacheKey, JSON.stringify({ ...user, exp: Number(info.exp) }), { expirationTtl: ttl });
  return user;
}

/** `Authorization: Bearer <token>` から中身だけ取り出す。 */
export function bearerToken(header: string | null): string {
  if (!header) return "";
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match ? match[1].trim() : "";
}
