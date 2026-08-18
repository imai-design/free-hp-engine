/**
 * tests/applications.test.ts の MockD1 はSQLをそのまま記録するだけで、実SQLiteの制約
 * （UNIQUE index等）を一切検証しない。そのため、slugのUNIQUE制約が「全種別で一意」から
 * 「同じ種別(kind)内でのみ一意」に変わったこと（migrations/0002_slug_unique_per_kind.sql）は、
 * モックテストだけでは検出できなかった（Codexレビュー2026-08-18で指摘）。
 *
 * ここでは実際に migrations/*.sql を node:sqlite（Node 22.5+の組み込み実験的モジュール）へ
 * 適用し、recordApplication() を通してINSERTが本当に通る／衝突するかを検証する。
 * node:sqlite は --experimental-sqlite フラグが要るため（package.json の test スクリプト参照）、
 * フラグ無しの古いNode環境で実行された場合はこのファイル全体をスキップする。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Database, D1PreparedStatement } from "../src/domain/applications.ts";
import { recordApplication } from "../src/domain/applications.ts";
import { enforceAdminRateLimit, ADMIN_RATE_LIMIT } from "../src/domain/adminRateLimit.ts";
import { RateLimitError } from "../src/domain/rateLimit.ts";

type SqliteModule = typeof import("node:sqlite");

let sqliteModule: SqliteModule | undefined;
try {
  sqliteModule = await import("node:sqlite");
} catch {
  sqliteModule = undefined;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

/** migrations/*.sql をファイル名順（0001, 0002, ...）にすべて適用する。 */
function applyMigrations(db: InstanceType<SqliteModule["DatabaseSync"]>): void {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.exec(sql);
  }
}

/**
 * node:sqlite の DatabaseSync を、applications.ts / adminRateLimit.ts が要求する
 * 最小限の非同期D1インターフェースに合わせるだけの薄いラッパー。
 */
function wrapAsD1(db: InstanceType<SqliteModule["DatabaseSync"]>): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      const makeStatement = (boundValues: unknown[]): D1PreparedStatement => ({
        bind(...values: unknown[]): D1PreparedStatement {
          return makeStatement(values);
        },
        async run(): Promise<unknown> {
          return db.prepare(sql).run(...(boundValues as never[]));
        },
        async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
          const results = db.prepare(sql).all(...(boundValues as never[])) as T[];
          return { results };
        },
      });
      return makeStatement([]);
    },
  };
}

if (!sqliteModule) {
  test("dbConstraints: node:sqliteが使えないためスキップ(node --experimental-sqlite が必要)", { skip: true }, () => {});
} else {
  const { DatabaseSync } = sqliteModule;

  test("実DB: site作成後に同じslugでdomain_requestを送ってもINSERTが成功する(kind単位のUNIQUE)", async () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const d1 = wrapAsD1(db);

    const siteOk = await recordApplication(d1, {
      createdAt: "2026-08-18T00:00:00.000Z",
      kind: "site",
      slug: "kissa-kaeru",
      hasPhoto: false,
    });
    const domainRequestOk = await recordApplication(d1, {
      createdAt: "2026-08-18T00:01:00.000Z",
      kind: "domain_request",
      slug: "kissa-kaeru",
      hasPhoto: false,
    });
    assert.equal(siteOk, true);
    assert.equal(domainRequestOk, true, "同じslugでも種別(kind)が違えばINSERTが通らないといけない");

    const rows = db.prepare("SELECT kind, slug FROM applications ORDER BY id").all() as Array<{ kind: string; slug: string }>;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.kind).sort(), ["domain_request", "site"]);
  });

  test("実DB: 同じkind・同じslugの2回目のINSERTはUNIQUE制約に衝突しfalseを返す", async () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const d1 = wrapAsD1(db);

    const first = await recordApplication(d1, {
      createdAt: "2026-08-18T00:00:00.000Z",
      kind: "site",
      slug: "duplicate-slug",
      hasPhoto: false,
    });
    const second = await recordApplication(d1, {
      createdAt: "2026-08-18T00:02:00.000Z",
      kind: "site",
      slug: "duplicate-slug",
      hasPhoto: false,
    });
    assert.equal(first, true);
    assert.equal(second, false, "同じkind+slugの2件目はUNIQUE制約で弾かれ、recordApplicationはfalseを返す");

    const rows = db.prepare("SELECT COUNT(*) as count FROM applications WHERE slug = ?").all("duplicate-slug") as Array<{ count: number }>;
    assert.equal(rows[0].count, 1);
  });

  test("実DB: partner_keyは生の値でなくpartner_key_hash列にSHA-256先頭16桁で入る", async () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const d1 = wrapAsD1(db);

    await recordApplication(d1, {
      createdAt: "2026-08-18T00:00:00.000Z",
      kind: "sample",
      slug: "partner-sample",
      hasPhoto: false,
      partnerKey: "super-secret-partner-key",
    });

    const rows = db
      .prepare("SELECT partner_key, partner_key_hash FROM applications WHERE slug = ?")
      .all("partner-sample") as Array<{ partner_key: string | null; partner_key_hash: string | null }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].partner_key, null, "partner_key列には生の鍵をもう書かない");
    assert.match(rows[0].partner_key_hash ?? "", /^[0-9a-f]{16}$/u);
    assert.notEqual(rows[0].partner_key_hash, "super-secret-partner-key");
  });

  test("実DB: admin_attemptsはINSERT→COUNTで直近1時間の試行回数を数え、上限超で拒否する", async () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const d1 = wrapAsD1(db);

    const now = Date.parse("2026-08-18T10:00:00.000Z");
    let rejected = 0;
    for (let attempt = 0; attempt < ADMIN_RATE_LIMIT + 2; attempt += 1) {
      try {
        await enforceAdminRateLimit(d1, "ip-hash-abc", now + attempt);
      } catch (error) {
        if (error instanceof RateLimitError) rejected += 1;
        else throw error;
      }
    }
    assert.equal(rejected, 2, "上限を超えた2回だけ拒否されるはず");

    const rows = db.prepare("SELECT COUNT(*) as count FROM admin_attempts WHERE ip_hash = ?").all("ip-hash-abc") as Array<{ count: number }>;
    assert.equal(rows[0].count, ADMIN_RATE_LIMIT + 2, "拒否した試行も1行としては記録され続ける");
  });
}
