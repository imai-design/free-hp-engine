/**
 * 申込フォーム（サイト生成・見本生成・ドメイン取得申込）で受け取った内容を、
 * Cloudflare D1 の applications テーブルへ記録する。
 *
 * KV（SITES）は公開ページ本体とアクセス制御用の値しか持たず、
 * 「誰が何を申し込んだか」を一覧・検索・エクスポートする手段がなかったための追加。
 * D1が未設定・書き込み失敗のどちらでも例外を投げない設計にしている
 * （申込フォームの成功可否とD1への記録を切り離すため。D1が落ちてもサイト生成は成功扱いにする）。
 */

/**
 * Cloudflare D1バインディング（env.DB）の呼び出しに必要な最小限の形。
 * @cloudflare/workers-types非依存で、実際に使う prepare().bind().run()/.all() のみを宣言する
 * （src/generation/provider.ts の WorkersAiBinding と同じ方針）。
 */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

/**
 * D1への保存が失敗したとき、申込内容を一時的に退避する先（env.SITES=KVを想定）。
 * applications.ts はKVの具体的な型を知らなくてよいよう、必要な操作だけを最小限で宣言する。
 */
export interface FailedApplicationStore {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list?: (options: { prefix: string; limit?: number }) => Promise<{ keys: Array<{ name: string }> }>;
}

export type ApplicationKind = "site" | "domain_request" | "sample";

export interface RecordApplicationInput {
  createdAt: string;
  kind: ApplicationKind;
  slug?: string;
  publicUrl?: string;
  storeName?: string;
  businessType?: string;
  description?: string;
  catchcopy?: string;
  mood?: string;
  phone?: string;
  address?: string;
  hours?: string;
  menuText?: string;
  reserveUrl?: string;
  instagram?: string;
  lineOfficial?: string;
  hasPhoto: boolean;
  ownerEmail?: string;
  ownerSub?: string;
  /** 生のIPアドレス。ここで受け取り、保存前にハッシュ化する（生の値をDBに残さないため）。 */
  ip?: string;
  userAgent?: string;
  partnerKey?: string;
  extra?: Record<string, unknown>;
  note?: string;
}

/** SHA-256の先頭16桁だけを識別子として返す共通処理（hashIp・partner_keyのハッシュ化の両方が使う）。 */
async function sha256Hex16(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 16);
}

/**
 * IPアドレスを生で保存しない。SHA-256の先頭16桁だけを識別子として残す（同一送信元の突合が目的）。
 * 簡略化: ソルト無しの単純ハッシュ。IPv4は空間が2^32しかなく、DBを読める人（=ADMIN_KEY保持者）が
 * 元IPへ逆引きすることは技術的に可能（総当たりで数分）。強い匿名化が要る用途では env.IP_HASH_SECRET
 * のようなシークレットでHMAC化する入口を用意し、そちらへ切り替える。
 */
export async function hashIp(ip: string): Promise<string> {
  return sha256Hex16(ip);
}

const INSERT_SQL = `INSERT INTO applications (
  created_at, kind, slug, public_url, store_name, business_type, description,
  catchcopy, mood, phone, address, hours, menu_text, reserve_url, instagram,
  line_official, has_photo, owner_email, owner_sub, ip_hash, user_agent,
  partner_key, extra_json, status, note, partner_key_hash
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?,?)`;

const DBFAIL_TTL_SECONDS = 60 * 60 * 24 * 30; // 30日

/**
 * D1への保存が失敗したとき、申込内容をKVへ退避する。
 * 申込フォーム側は成功扱いのまま進めるが（recordApplication自体は例外を投げない）、
 * データが消えたままにはせず、あとから `dbfail:` プレフィックスで拾って手動で復旧できるようにする。
 */
async function saveFailedApplication(
  store: FailedApplicationStore,
  input: RecordApplicationInput,
): Promise<void> {
  const key = `dbfail:${input.createdAt}:${input.slug ?? crypto.randomUUID()}`;
  try {
    await store.put(key, JSON.stringify(input), { expirationTtl: DBFAIL_TTL_SECONDS });
  } catch (error) {
    console.error("[recordApplication] fallback KV save also failed", error instanceof Error ? error.message : String(error));
  }
}

/**
 * applications テーブルへ1件挿入する。
 * env.DB が未設定（ローカル・テスト環境）なら何もせず false を返す。
 * 挿入自体が失敗した場合もここで握りつぶし、呼び出し元の申込処理は成功扱いのまま進める
 * （fallbackStore を渡していれば、失敗した申込内容はそちらへ退避する）。
 */
export async function recordApplication(
  db: D1Database | undefined,
  input: RecordApplicationInput,
  fallbackStore?: FailedApplicationStore,
): Promise<boolean> {
  if (!db) return false;
  try {
    const ipHash = input.ip ? await hashIp(input.ip) : null;
    const partnerKeyHash = input.partnerKey ? await sha256Hex16(input.partnerKey) : null;
    await db
      .prepare(INSERT_SQL)
      .bind(
        input.createdAt,
        input.kind,
        input.slug ?? null,
        input.publicUrl ?? null,
        input.storeName ?? null,
        input.businessType ?? null,
        input.description ?? null,
        input.catchcopy ?? null,
        input.mood ?? null,
        input.phone ?? null,
        input.address ?? null,
        input.hours ?? null,
        input.menuText ?? null,
        input.reserveUrl ?? null,
        input.instagram ?? null,
        input.lineOfficial ?? null,
        input.hasPhoto ? 1 : 0,
        input.ownerEmail ?? null,
        input.ownerSub ?? null,
        ipHash,
        input.userAgent ?? null,
        // partner_key列は生の鍵をもう書かない（partner_key_hashへ移行済み）。過去データ参照用に列だけ残す。
        null,
        input.extra ? JSON.stringify(input.extra) : null,
        input.note ?? null,
        partnerKeyHash,
      )
      .run();
    return true;
  } catch (error) {
    console.error("[recordApplication] insert failed", error instanceof Error ? error.message : String(error));
    if (fallbackStore) await saveFailedApplication(fallbackStore, input);
    return false;
  }
}

/** 管理エンドポイントの `?failed=1` から呼ぶ。KVに退避した保存失敗件数を数える。 */
export async function countFailedApplications(store: FailedApplicationStore): Promise<number> {
  if (!store.list) return 0;
  const listed = await store.list({ prefix: "dbfail:", limit: 1000 });
  return listed.keys.length;
}

export interface ApplicationRow {
  id: number;
  created_at: string;
  kind: string;
  status: string;
  slug: string | null;
  public_url: string | null;
  store_name: string | null;
  business_type: string | null;
  catchcopy: string | null;
  description: string | null;
  mood: string | null;
  phone: string | null;
  address: string | null;
  hours: string | null;
  menu_text: string | null;
  reserve_url: string | null;
  instagram: string | null;
  line_official: string | null;
  has_photo: number;
  owner_email: string | null;
  partner_key: string | null;
  partner_key_hash: string | null;
  extra_json: string | null;
  note: string | null;
}

/** 管理用一覧・エクスポート用に読み出す。sinceIso が渡されればそれ以降(含む)のものだけに絞る。 */
export async function listApplications(db: D1Database, sinceIso: string | null): Promise<ApplicationRow[]> {
  const statement = sinceIso
    ? db
        .prepare(
          `SELECT id, created_at, kind, status, slug, public_url, store_name, business_type, catchcopy,
                  description, mood, phone, address, hours, menu_text, reserve_url, instagram, line_official,
                  has_photo, owner_email, partner_key, partner_key_hash, extra_json, note
           FROM applications WHERE created_at >= ? ORDER BY created_at DESC LIMIT 2000`,
        )
        .bind(sinceIso)
    : db.prepare(
        `SELECT id, created_at, kind, status, slug, public_url, store_name, business_type, catchcopy,
                description, mood, phone, address, hours, menu_text, reserve_url, instagram, line_official,
                has_photo, owner_email, partner_key, partner_key_hash, extra_json, note
         FROM applications ORDER BY created_at DESC LIMIT 2000`,
      );
  const { results } = await statement.all<ApplicationRow>();
  return results;
}

const CSV_HEADERS: Array<{ key: keyof ApplicationRow; label: string }> = [
  { key: "created_at", label: "作成日時" },
  { key: "kind", label: "種別" },
  { key: "status", label: "ステータス" },
  { key: "store_name", label: "店名・屋号" },
  { key: "business_type", label: "業種" },
  { key: "catchcopy", label: "キャッチコピー" },
  { key: "description", label: "説明" },
  { key: "mood", label: "雰囲気" },
  { key: "phone", label: "電話番号" },
  { key: "address", label: "住所" },
  { key: "hours", label: "営業時間" },
  { key: "menu_text", label: "メニュー" },
  { key: "reserve_url", label: "予約URL" },
  { key: "instagram", label: "Instagram" },
  { key: "line_official", label: "LINE公式" },
  { key: "has_photo", label: "写真の有無" },
  { key: "owner_email", label: "メールアドレス" },
  { key: "public_url", label: "公開URL" },
  { key: "slug", label: "スラッグ" },
  { key: "partner_key_hash", label: "紹介パートナー鍵(ハッシュ)" },
  { key: "extra_json", label: "追加情報(JSON)" },
  { key: "note", label: "メモ" },
];

// 申込内容は誰でも送信できる入力なので、CSVを開くExcel/Numbers側で数式として実行されないようにする
// （CSVインジェクション対策。先頭が = + - @ タブだと数式やDDEとして解釈される既知の攻撃手口）。
const FORMULA_TRIGGER_PATTERN = /^[=+\-@\t]/u;

/**
 * 値の中に区切り文字・改行・ダブルクォートがあればダブルクォートで囲み、中のダブルクォートは2重化する（RFC 4180）。
 * さらに、先頭が数式トリガー文字なら先頭にシングルクォートを足して文字列として固定する（CSVインジェクション対策）。
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (FORMULA_TRIGGER_PATTERN.test(text)) text = `'${text}`;
  if (/[",\n\r]/u.test(text)) return `"${text.replace(/"/gu, '""')}"`;
  return text;
}

/** Excel/Numbersでも文字化けしないよう、呼び出し側でUTF-8 BOMを先頭に付けて返す想定のCSV本文だけを作る。 */
export function toCsv(rows: ApplicationRow[]): string {
  const header = CSV_HEADERS.map((column) => csvCell(column.label)).join(",");
  const lines = rows.map((row) =>
    CSV_HEADERS.map((column) => csvCell(column.key === "has_photo" ? (row.has_photo ? "あり" : "なし") : row[column.key])).join(","),
  );
  return [header, ...lines].join("\r\n") + "\r\n";
}
