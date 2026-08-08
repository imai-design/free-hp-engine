export const INDUSTRIES = [
  "飲食店",
  "美容・サロン",
  "教室・スクール",
  "小売・物販",
  "修理・住まいのサービス",
  "その他",
] as const;
export const COLOR_THEMES = ["あたたかい", "落ち着いた", "さわやか"] as const;

export type Industry = (typeof INDUSTRIES)[number];
export type ColorTheme = (typeof COLOR_THEMES)[number];

export interface SiteInput {
  storeName: string;
  industry: Industry;
  catchphrase: string;
  description: string;
  colorTheme: ColorTheme;
  phone?: string;
  address?: string;
  /**
   * 営業時間・定休日。住所欄に混ぜて書かれると地図リンクが作れないので独立させている。
   * AIには本文へ書かせず、入力値をそのままテンプレートに表示する（数値を盛る癖への対策）。
   */
  businessHours?: string;
  /**
   * メニュー・料金。1行を1品として受け取り、render/parts.ts で品名と価格に分ける。
   * 改行を含むため、通常の optionalString とは別の検証を通す。
   */
  menuText?: string;
  /**
   * お店の写真1枚をdata URIで受け取る（ブラウザ側で縮小済み）。
   * 外部ストレージを増やさずHTMLに埋め込むため。SVGは中にスクリプトを書けるので受け付けない。
   */
  photo?: string;
  /** 予約ページのURL。httpsのみ受け付ける（javascript:等のスキームを構造的に排除するため）。 */
  reserveUrl?: string;
  /**
   * Instagramのユーザー名。「@user」「user」「instagram.com/user」のどれで来てもユーザー名だけに正規化する。
   * href は render 側で毎回こちらが組み立てる（ユーザーの入力した完全なURLをそのまま出さない）。
   */
  instagram?: string;
  /**
   * LINE公式アカウント。「@ID」または `https://lin.ee/xxxx` 形式の短縮URLだけを受け付ける。
   * 「@ID」は render 側で `https://line.me/R/ti/p/@ID` に組み立てる。
   */
  lineOfficial?: string;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const isString = (value: unknown): value is string => typeof value === "string";

function requiredString(
  input: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): string {
  const value = input[key];
  if (!isString(value)) throw new ValidationError(`${key} is required`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new ValidationError(`${key} must be ${min}-${max} characters`);
  }
  if (/\p{Cc}/u.test(trimmed)) throw new ValidationError(`${key} contains invalid control characters`);
  return trimmed;
}

function optionalString(input: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (!isString(value)) throw new ValidationError(`${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ValidationError(`${key} must be at most ${max} characters`);
  if (/\p{Cc}/u.test(trimmed)) throw new ValidationError(`${key} contains invalid control characters`);
  return trimmed || undefined;
}

const MENU_TEXT_MAX_LENGTH = 500;
const MENU_TEXT_MAX_LINES = 8;

/** menuText だけは区切りとして改行を許し、それ以外の制御文字は通常の文字列と同様に拒否する。 */
function optionalMenuText(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (!isString(value)) throw new ValidationError(`${key} must be a string`);

  // ブラウザ以外のクライアントから来る CRLF / CR も、Worker 内では LF に統一する。
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return undefined;
  if (normalized.length > MENU_TEXT_MAX_LENGTH) {
    throw new ValidationError(`${key} must be at most ${MENU_TEXT_MAX_LENGTH} characters`);
  }
  const lines = normalized.split("\n");
  if (lines.length > MENU_TEXT_MAX_LINES) {
    throw new ValidationError(`${key} must be at most ${MENU_TEXT_MAX_LINES} lines`);
  }
  // split 後の各行に Cc が残っていれば、改行以外（タブ・NUL等）の制御文字。
  if (lines.some((line) => /\p{Cc}/u.test(line))) {
    throw new ValidationError(`${key} contains invalid control characters`);
  }
  return normalized;
}

// base64にしたあとの文字数。約1.4MBの画像に相当し、ブラウザ側で縮小すれば十分収まる。
const PHOTO_MAX_LENGTH = 2_000_000;
// SVGを意図的に外している（<script>やonload属性を埋め込めるため）。
const PHOTO_DATA_URI_PATTERN = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/u;

/** base64の先頭だけを復号する。マジックナンバー確認のために全体を展開する必要はない。 */
function decodeBase64Head(base64: string, byteLength: number): number[] {
  const chunk = base64.slice(0, Math.ceil(byteLength / 3) * 4);
  const binary = atob(chunk);
  return Array.from(binary.slice(0, byteLength), (character) => character.charCodeAt(0));
}

/**
 * 申告されたMIMEと実際のバイト列が一致するかを確かめる。
 * 「data:image/jpeg;base64,」と名乗りながら中身が別物、という持ち込みを防ぐ。
 */
function hasMatchingImageSignature(mimeSubtype: string, base64: string): boolean {
  let head: number[];
  try {
    head = decodeBase64Head(base64, 12);
  } catch {
    return false;
  }
  if (head.length < 4) return false;
  if (mimeSubtype === "jpeg") return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (mimeSubtype === "png") return head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  if (mimeSubtype === "webp") {
    if (head.length < 12) return false;
    const ascii = (from: number, to: number) => head.slice(from, to).map((code) => String.fromCharCode(code)).join("");
    return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  }
  return false;
}

function optionalPhoto(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (!isString(value)) throw new ValidationError(`${key} must be a string`);
  if (value.length > PHOTO_MAX_LENGTH) {
    throw new ValidationError("写真のデータが大きすぎます。もう少し小さい画像でお試しください。");
  }
  const match = PHOTO_DATA_URI_PATTERN.exec(value);
  if (!match) throw new ValidationError("写真はJPEG・PNG・WebPのいずれかで送ってください。");
  if (!hasMatchingImageSignature(match[1], match[2])) {
    throw new ValidationError("写真のデータを画像として読み取れませんでした。");
  }
  return value;
}

// ---- 予約URL・Instagram・LINE公式（2026-08-07追加） ----
//
// 3つとも href に直結する入力なので、①httpsだけを許す ②取り出した値からこちらでURLを組み立てる
// （ユーザーの完全なURLをそのまま出さない）という2段構えで守る。実際のエスケープ・href組み立てはrender側。

const RESERVE_URL_MAX_LENGTH = 300;
const SOCIAL_INPUT_MAX_LENGTH = 120;
// Instagramの実際の制約に合わせる（英数字・ピリオド・アンダースコアのみ、1〜30文字）。
const INSTAGRAM_USERNAME_PATTERN = /^[A-Za-z0-9._]{1,30}$/u;
// LINEの公式ID（@の後ろ）。英数字・ピリオド・アンダースコア・ハイフンのみ、1〜20文字。
const LINE_ID_PATTERN = /^[A-Za-z0-9._-]{1,20}$/u;
// lin.eeの短縮URLは、この形（末尾にスラッシュ・クエリ・フラグメントが無い）だけを許す。
const LINE_EE_URL_PATTERN = /^https:\/\/lin\.ee\/[A-Za-z0-9]{1,20}$/u;

function optionalReserveUrl(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (!isString(value)) throw new ValidationError(`${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > RESERVE_URL_MAX_LENGTH) {
    throw new ValidationError(`${key} must be at most ${RESERVE_URL_MAX_LENGTH} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ValidationError("予約ページのURLを読み取れませんでした。https:// から始まるURLを入力してください。");
  }
  // http:・javascript:等はここで一律に落ちる（スキームをhttpsだけに絞る構造的な排除）。
  if (parsed.protocol !== "https:") {
    throw new ValidationError("予約ページのURLは https:// から始まるものだけ使えます。");
  }
  return parsed.href;
}

/** 「@user」「user」「https://instagram.com/user」のいずれからでもユーザー名だけを取り出す。読めなければnull。 */
function extractInstagramUsername(trimmed: string): string | null {
  if (trimmed.startsWith("@")) return trimmed.slice(1);
  if (/^https?:\/\//iu.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.hostname !== "instagram.com" && parsed.hostname !== "www.instagram.com") return null;
    return parsed.pathname.split("/").filter(Boolean)[0] ?? null;
  }
  return trimmed;
}

function optionalInstagram(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (!isString(value)) throw new ValidationError(`${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > SOCIAL_INPUT_MAX_LENGTH) {
    throw new ValidationError(`${key} must be at most ${SOCIAL_INPUT_MAX_LENGTH} characters`);
  }
  const username = extractInstagramUsername(trimmed);
  if (!username || !INSTAGRAM_USERNAME_PATTERN.test(username)) {
    throw new ValidationError("Instagramのユーザー名を読み取れませんでした。「@ユーザー名」の形で入力してください。");
  }
  return username;
}

function optionalLineOfficial(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (!isString(value)) throw new ValidationError(`${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > SOCIAL_INPUT_MAX_LENGTH) {
    throw new ValidationError(`${key} must be at most ${SOCIAL_INPUT_MAX_LENGTH} characters`);
  }
  if (trimmed.startsWith("@")) {
    if (!LINE_ID_PATTERN.test(trimmed.slice(1))) {
      throw new ValidationError("LINE公式アカウントのIDを読み取れませんでした。「@ID」の形で入力してください。");
    }
    return trimmed;
  }
  if (LINE_EE_URL_PATTERN.test(trimmed)) return trimmed;
  throw new ValidationError("LINE公式アカウントを読み取れませんでした。「@ID」か、lin.eeのURLを入力してください。");
}

export function validateInput(value: unknown): SiteInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const input = value as Record<string, unknown>;
  const industry = input.industry;
  if (!INDUSTRIES.includes(industry as Industry)) throw new ValidationError("industry is invalid");
  const colorTheme = input.colorTheme;
  if (!COLOR_THEMES.includes(colorTheme as ColorTheme)) throw new ValidationError("colorTheme is invalid");

  return {
    storeName: requiredString(input, "storeName", 1, 40),
    industry: industry as Industry,
    catchphrase: requiredString(input, "catchphrase", 1, 60),
    description: requiredString(input, "description", 1, 400),
    colorTheme: colorTheme as ColorTheme,
    phone: optionalString(input, "phone", 40),
    address: optionalString(input, "address", 200),
    businessHours: optionalString(input, "businessHours", 100),
    menuText: optionalMenuText(input, "menuText"),
    photo: optionalPhoto(input, "photo"),
    reserveUrl: optionalReserveUrl(input, "reserveUrl"),
    instagram: optionalInstagram(input, "instagram"),
    lineOfficial: optionalLineOfficial(input, "lineOfficial"),
  };
}
